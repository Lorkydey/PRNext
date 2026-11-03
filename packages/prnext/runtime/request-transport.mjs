const MAX_HEADER = 256 * 1024;
const MAX_BODY = 32 * 1024 * 1024;
export const REQUEST_BODY_CHUNK = 64 * 1024;
const EMPTY_BODY = Buffer.alloc(0);
export const requestBodyState = Symbol('PRNext request body state');

// One owner reads a lane. Streaming bodies borrow this reader until their
// invocation finishes; body bytes are never parsed as request metadata.
function laneReader(source) {
  const iterator = source[Symbol.asyncIterator]?.() || source[Symbol.iterator]();
  let chunk = EMPTY_BODY, offset = 0, ended = false;
  async function available() {
    while (offset === chunk.length && !ended) {
      const next = await iterator.next(); ended = !!next.done;
      chunk = ended ? EMPTY_BODY : next.value; offset = 0;
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    }
    return !ended;
  }
  return {
    async line(limit) {
      const parts = []; let size = 0;
      while (await available()) {
        const end = chunk.indexOf(10, offset), stop = end < 0 ? chunk.length : end;
        const part = chunk.subarray(offset, stop); size += part.length;
        if (size > limit) throw new Error('Request transport header exceeds limit');
        parts.push(part); offset = end < 0 ? stop : end + 1;
        if (end >= 0) return (parts.length === 1 ? parts[0] : Buffer.concat(parts, size)).toString();
      }
      if (size) throw new Error('Truncated request transport header');
      return undefined;
    },
    async exact(length) {
      if (length === 0) return EMPTY_BODY;
      const result = Buffer.allocUnsafe(length); let written = 0;
      while (written < length) {
        if (!await available()) throw new Error('Truncated request transport body');
        const count = Math.min(length - written, chunk.length - offset);
        chunk.copy(result, written, offset, offset + count); written += count; offset += count;
      }
      return result;
    },
    destroy() { source.destroy?.(); },
  };
}

function streamingBody(reader, input, credit) {
  const descriptor = input.bodyStream;
  if (!descriptor || descriptor.version !== 1 || Object.keys(descriptor).some(key => !['version', 'length', 'maxBytes'].includes(key)) ||
      descriptor.maxBytes !== MAX_BODY || !(descriptor.length === null || Number.isSafeInteger(descriptor.length) && descriptor.length >= 0 && descriptor.length <= MAX_BODY) ||
      input.bodyLength !== undefined || input.body !== undefined || !Number.isSafeInteger(input.id) || input.id < 1 || ['GET', 'HEAD'].includes(input.method)) {
    throw new Error('Invalid streaming request descriptor');
  }
  let controller, complete = false, total = 0, cancelled = false;
  const state = { get complete() { return complete; }, get bytes() { return total; }, cancel() {
    if (complete || cancelled) return;
    cancelled = true;
    try { controller?.error(new Error('Request body transport cancelled')); } catch {}
    reader.destroy();
  } };
  const body = new ReadableStream({
    start(value) { controller = value; },
    async pull(value) {
      try {
        // A single explicit credit authorizes one frame. No speculative read
        // consumes an upload while the application is not reading.
        await credit({ id: input.id, type: 'bodycredit', length: REQUEST_BODY_CHUNK });
        const header = await reader.exact(4), length = header.readUInt32BE();
        if (length === 0xffffffff) {
          const code = (await reader.exact(1))[0];
          const kinds = { 1: ['PRNEXT_BODY_LIMIT', 413], 2: ['PRNEXT_BODY_TIMEOUT', 408], 3: ['PRNEXT_BODY_READ', 400], 4: ['PRNEXT_BODY_LENGTH', 400] };
          if (!kinds[code]) throw new Error('Invalid request body error frame');
          throw Object.assign(new Error('Request body transport failed'), { code: kinds[code][0], statusCode: kinds[code][1] });
        }
        if (length === 0) {
          if (descriptor.length !== null && total !== descriptor.length) throw new Error('Request body length mismatch');
          complete = true; value.close(); return;
        }
        if (length > REQUEST_BODY_CHUNK || total + length > MAX_BODY || descriptor.length !== null && total + length > descriptor.length) throw new Error('Request body exceeds its transport budget');
        const bytes = await reader.exact(length); total += bytes.length; value.enqueue(bytes);
      } catch (error) {
        if (cancelled) return;
        value.error(error);
        if (!/^PRNEXT_BODY_(LIMIT|TIMEOUT|READ|LENGTH)$/.test(error.code || '')) reader.destroy();
      }
    },
    async cancel() { cancelled = true; await credit({ id: input.id, type: 'bodycancel' }); },
  }, { highWaterMark: 0 });
  Object.defineProperty(input, requestBodyState, { value: state });
  return body;
}

export async function* requestFrames(source, { authenticate, streamBodies = false, credit } = {}) {
  const reader = laneReader(source);
  if (authenticate) {
    const token = await reader.line(256);
    if (token === undefined) throw new Error('Truncated request authentication');
    authenticate(token);
  }
  for (;;) {
    const line = await reader.line(MAX_HEADER);
    if (line === undefined) return;
    if (!line.trim()) continue;
    const input = JSON.parse(line);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request frame');
    if (input.bodyStream !== undefined) {
      if (!authenticate || !streamBodies || typeof credit !== 'function') throw new Error('Streaming request protocol was not negotiated');
      input.body = streamingBody(reader, input, credit);
      try { yield input; }
      finally { input[requestBodyState].cancel(); }
      // Streaming upload lanes are single-use: an early response cannot turn
      // unread upload bytes into another request. The Node host stays warm.
      return;
    }
    if (input.bodyLength !== undefined) {
      if (!Number.isSafeInteger(input.bodyLength) || input.bodyLength < 0 || input.bodyLength > MAX_BODY) throw new Error('Invalid request body length');
      input.body = await reader.exact(input.bodyLength);
    }
    yield input;
  }
}
