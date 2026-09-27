export const MAX_STREAM_CHUNK = 64 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const NO_BODY = new Set([204, 205, 304]);

function bytes(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('A response stream must yield bytes');
}

async function* responseChunks(body) {
  if (body === null || body === undefined) return;
  if (typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const value = bytes(body);
    for (let offset = 0; offset < value.length; offset += MAX_STREAM_CHUNK) yield value.subarray(offset, offset + MAX_STREAM_CHUNK);
    return;
  }
  if (typeof body[Symbol.asyncIterator] !== 'function' && typeof body[Symbol.iterator] !== 'function') {
    throw new TypeError('Invalid response stream');
  }
  for await (const item of body) {
    const value = bytes(item);
    for (let offset = 0; offset < value.length; offset += MAX_STREAM_CHUNK) yield value.subarray(offset, offset + MAX_STREAM_CHUNK);
  }
}

// A resolved write means the pipe has accepted the bytes. Awaiting every frame
// prevents Node's writable queue from growing with a slow Rust/HTTP consumer.
export function createProtocolOutput(write, { cork, uncork } = {}) {
  const send = value => new Promise((resolve, reject) => {
    write(value, error => error ? reject(error) : resolve());
  });
  const controlLine = frame => {
    const value = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(value) > MAX_CONTROL_BYTES) throw new Error('Response headers exceed the 64 KiB transport limit');
    return value;
  };
  const control = frame => send(controlLine(frame));
  const sendParts = parts => new Promise((resolve, reject) => {
    cork();
    try {
      for (let index = 0; index < parts.length; index++) {
        write(parts[index], error => {
          if (error) reject(error);
          else if (index === parts.length - 1) resolve();
        });
      }
    } catch (error) { reject(error); }
    finally { uncork(); }
  });
  const sendChunk = (id, chunk) => {
    const line = controlLine({ id, type: 'chunk', length: chunk.length });
    if (!cork || !uncork) return send(line).then(() => send(chunk));
    // writev sends metadata and bytes without joining/copying the payload.
    return sendParts([line, chunk]);
  };

  return async function output(id, result, { stream = false, compactResponse = false, method = 'GET', production = true, signalController } = {}) {
    const responseBody = result.bufferedBody ?? result.body;
    const pageError = { ...(result.pageError ? { pageError: result.pageError } : {}),
      ...(result.pageFailure ? { pageFailure: result.pageFailure } : {}) };
    if (stream && !result.isr && (method === 'HEAD' || NO_BODY.has(result.status))) {
      await result.cancel?.();
      if (result.body?.cancel && !result.body.locked) await result.body.cancel();
      await send(JSON.stringify({ id, status: result.status, headers: result.headers || {}, body: '', ...pageError }) + '\n');
      return;
    }
    if (!stream && !result.isr) {
      await send(JSON.stringify({ id, status: result.status, headers: result.headers || {}, body: Buffer.from(result.body || '').toString('base64'), ...pageError }) + '\n');
      return;
    }
    const headers = Object.fromEntries(Object.entries(result.headers || {}).filter(([name]) => name.toLowerCase() !== 'content-length'));
    if (compactResponse && !result.isr && (typeof responseBody === 'string' || responseBody instanceof ArrayBuffer || ArrayBuffer.isView(responseBody))) {
      const body = bytes(responseBody);
      if (body.length <= 16 * 1024) {
        const complete = controlLine({ id, type: 'complete', status: result.status, headers, length: body.length, ...pageError });
        if (cork && uncork) await sendParts(body.length ? [complete, body] : [complete]);
        else { await send(complete); if (body.length) await send(body); }
        return;
      }
    }
    const head = controlLine({ id, type: 'head', status: result.status, headers, ...pageError, ...(result.isr ? { isr: result.isr } : {}) });
    if (cork && uncork && (typeof responseBody === 'string' || responseBody instanceof ArrayBuffer || ArrayBuffer.isView(responseBody))) {
      const body = bytes(responseBody);
      if (body.length <= MAX_STREAM_CHUNK) {
        // Pages HTML and buffered action responses already know their entire
        // small body. Send their frames together, keeping the same wire format.
        await sendParts([head, ...(body.length ? [controlLine({id,type:'chunk',length:body.length}),body] : []), controlLine({id,type:'end'})]);
        return;
      }
    }
    await send(head);
    try {
      for await (const chunk of responseChunks(responseBody)) {
        await sendChunk(id, chunk);
      }
      await control({ id, type: 'end' });
    } catch (error) {
      signalController?.abort(error);
      await result.cancel?.(error);
      console.error('[prnext] Response stream failed:', error?.stack || error);
      // Headers are already on the wire: terminate this response, never emit a
      // replacement HTTP response or retry application code after a mutation.
      await control({ id, type: 'error', message: production ? 'Response stream failed' : String(error?.message || error).slice(0, 4096) });
    }
  };
}
