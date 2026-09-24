// One initial transferable chunk, then one chunk per reader pull. The initial
// credit removes a round trip while keeping the queue bounded to 64 KiB.
export const APP_STREAM_CHUNK_BYTES = 64 * 1024;

export function workerStreamChannel(port, id) {
  const abort = new AbortController();
  let credit = 0;
  let wake;
  let started = false;
  let metadata;
  let ended = false;
  let previousSignal;
  let combinedSignal;
  const wait = async signal => {
    while (!credit) {
      signal.throwIfAborted();
      await new Promise(resolve => {
        wake = () => { signal.removeEventListener('abort', wake); resolve(); };
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  };
  return {
    signal: abort.signal,
    get started() { return started; },
    credit() { credit = 1; wake?.(); wake = undefined; },
    cancel() { abort.abort(new Error('App Router response was cancelled')); wake?.(); wake = undefined; },
    start(value) { started = true; metadata = value; credit = 1; },
    async write(bytes, signal = abort.signal, done = false) {
      if (signal !== previousSignal) {
        previousSignal = signal;
        combinedSignal = signal === abort.signal ? signal : AbortSignal.any([abort.signal, signal]);
      }
      for (let offset = 0; offset < bytes.byteLength; offset += APP_STREAM_CHUNK_BYTES) {
        if (!credit) await wait(combinedSignal);
        combinedSignal.throwIfAborted();
        credit--;
        const length = Math.min(APP_STREAM_CHUNK_BYTES, bytes.byteLength - offset);
        // A byte ReadableStream transfers its allocation to the reader. Keep
        // that ownership across this bridge; Node's pooled Buffers are copied.
        let chunk;
        if (!Buffer.isBuffer(bytes) && offset === 0 && length === bytes.byteLength && bytes.buffer.byteLength <= APP_STREAM_CHUNK_BYTES) chunk = bytes;
        else { chunk = new Uint8Array(length); chunk.set(bytes.subarray(offset, offset + length)); }
        const last = offset + length === bytes.byteLength;
        const message = { id, type: metadata ? 'start' : 'chunk', ...metadata,
          chunk: chunk.buffer, byteOffset: chunk.byteOffset, byteLength: chunk.byteLength, done: done && last };
        metadata = undefined;
        port.postMessage(message, [chunk.buffer]);
        if (message.done) ended = true;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (metadata) port.postMessage({ id, type: 'start', ...metadata, done: true });
      else port.postMessage({ id, type: 'end' });
    },
  };
}

export function parentStreamChannel(port, id, cancelled) {
  let controller;
  let settlePull;
  let closed = false;
  const body = new ReadableStream({
    start(value) { controller = value; },
    pull() {
      return new Promise(resolve => {
        settlePull = resolve;
        port.postMessage({ id, type: 'credit' });
      });
    },
    cancel(reason) {
      closed = true;
      settlePull?.();
      port.postMessage({ id, type: 'cancel' });
      cancelled(reason);
    },
  }, { highWaterMark: 0 });
  return {
    body,
    chunk(buffer, offset = 0, length = buffer?.byteLength) {
      if (closed) return;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > APP_STREAM_CHUNK_BYTES ||
          !Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.byteLength) throw new Error('Invalid App Router stream chunk');
      controller.enqueue(new Uint8Array(buffer, offset, length));
      settlePull?.(); settlePull = undefined;
    },
    end() { if (!closed) { closed = true; controller.close(); } settlePull?.(); },
    error(error) { if (!closed) { closed = true; controller.error(error); } settlePull?.(); },
  };
}
