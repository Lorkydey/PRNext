export const MAX_STREAM_CHUNK = 64 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const NO_BODY = new Set([204, 205, 304]);

export class ProtocolWriteError extends Error {
  constructor(cause) { super('Request transport write failed', { cause }); }
}

function bytes(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('A response stream must yield bytes');
}

// A resolved write means the pipe has accepted the bytes. Awaiting every frame
// prevents Node's writable queue from growing with a slow Rust/HTTP consumer.
export function createProtocolOutput(write, { cork, uncork } = {}) {
  const send = value => new Promise((resolve, reject) => {
    try { write(value, error => error ? reject(new ProtocolWriteError(error)) : resolve()); }
    catch (error) { reject(new ProtocolWriteError(error)); }
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
          if (error) reject(new ProtocolWriteError(error));
          else if (index === parts.length - 1) resolve();
        });
      }
    } catch (error) { reject(new ProtocolWriteError(error)); }
    finally { uncork(); }
  });
  const sendChunk = (id, chunk) => {
    const line = controlLine({ id, type: 'chunk', length: chunk.length });
    if (!cork || !uncork) return send(line).then(() => send(chunk));
    // writev sends metadata and bytes without joining/copying the payload.
    return sendParts([line, chunk]);
  };

  return async function output(id, result, { stream = false, compactResponse = false, method = 'GET', production = true, signalController } = {}) {
    let responseStarted = false, bodyCancelled = false;
    try {
      signalController?.signal.throwIfAborted();
      const responseBody = result.bufferedBody ?? result.body;
      const pageError = { ...(result.pageError ? { pageError: result.pageError } : {}),
        ...(result.pageFailure ? { pageFailure: result.pageFailure } : {}) };
      if (stream && !result.isr && (method === 'HEAD' || NO_BODY.has(result.status))) {
        bodyCancelled = true;
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
      responseStarted = true;
      // Iterate the producer directly: an intermediate async generator adds
      // promise reactions and Buffer views for every already bounded chunk.
      // Each write still settles before the next chunk or producer read.
      if (responseBody !== null && responseBody !== undefined) {
        if (typeof responseBody === 'string' || responseBody instanceof ArrayBuffer || ArrayBuffer.isView(responseBody)) {
          const value = bytes(responseBody);
          for (let offset = 0; offset < value.length; offset += MAX_STREAM_CHUNK) {
            await sendChunk(id, value.subarray(offset, offset + MAX_STREAM_CHUNK));
          }
        } else {
          if (typeof responseBody[Symbol.asyncIterator] !== 'function' && typeof responseBody[Symbol.iterator] !== 'function') {
            throw new TypeError('Invalid response stream');
          }
          for await (const item of responseBody) {
            const value = bytes(item);
            if (value.length <= MAX_STREAM_CHUNK) {
              if (value.length) await sendChunk(id, value);
            } else {
              for (let offset = 0; offset < value.length; offset += MAX_STREAM_CHUNK) {
                await sendChunk(id, value.subarray(offset, offset + MAX_STREAM_CHUNK));
              }
            }
          }
        }
      }
      await control({ id, type: 'end' });
    } catch (error) {
      const cancelled = signalController?.signal.aborted || error instanceof ProtocolWriteError;
      signalController?.abort(error);
      if (!bodyCancelled) await result.cancel?.(error);
      // Socket cancellation has no writable peer and no protocol recovery on
      // this lane. Cancel its producer once; never attempt a second write (and
      // secondary EPIPE) or report a client disconnect as an application error.
      if (cancelled || !responseStarted) throw error;
      console.error('[prnext] Response stream failed:', error?.stack || error);
      // Headers are already on the wire: terminate this response, never emit a
      // replacement HTTP response or retry application code after a mutation.
      await control({ id, type: 'error', message: production ? 'Response stream failed' : String(error?.message || error).slice(0, 4096) });
    }
  };
}
