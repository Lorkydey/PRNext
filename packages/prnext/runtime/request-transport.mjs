const MAX_HEADER = 256 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

// Awaiting the consumer preserves socket backpressure. At most one body is
// assembled, and binary bytes never pass through JSON strings or base64.
export async function* requestFrames(source, { authenticate } = {}) {
  let fragments = [], size = 0, input, body, offset = 0;
  for await (const chunk of source) {
    let cursor = 0;
    while (cursor < chunk.length) {
      if (body) {
        const length = Math.min(body.length - offset, chunk.length - cursor);
        chunk.copy(body, offset, cursor, cursor + length);
        cursor += length; offset += length;
        if (offset !== body.length) continue;
        input.body = body; body = undefined; offset = 0;
        yield input; input = undefined;
        continue;
      }
      const end = chunk.indexOf(10, cursor);
      const part = chunk.subarray(cursor, end < 0 ? chunk.length : end);
      size += part.length;
      if (size > (authenticate ? 256 : MAX_HEADER)) throw new Error('Request transport header exceeds limit');
      fragments.push(part);
      cursor = end < 0 ? chunk.length : end + 1;
      if (end < 0) continue;
      const line = fragments.length === 1 ? part.toString() : Buffer.concat(fragments, size).toString();
      fragments = []; size = 0;
      if (authenticate) { authenticate(line); authenticate = undefined; continue; }
      if (!line.trim()) continue;
      input = JSON.parse(line);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request frame');
      if (input.bodyLength === undefined) { yield input; input = undefined; continue; }
      if (!Number.isSafeInteger(input.bodyLength) || input.bodyLength < 0 || input.bodyLength > MAX_BODY) throw new Error('Invalid request body length');
      if (input.bodyLength === 0) { input.body = EMPTY_BODY; yield input; input = undefined; }
      else body = Buffer.allocUnsafe(input.bodyLength);
    }
  }
  if (size || body || authenticate) throw new Error('Truncated request transport frame');
}
