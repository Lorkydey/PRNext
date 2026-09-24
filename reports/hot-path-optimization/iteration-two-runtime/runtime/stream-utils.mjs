export const STREAM_CHUNK_BYTES = 64 * 1024;

export function abortError(reason = 'Response body was canceled') {
  if (reason instanceof Error) return reason;
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

export function apiTimeoutError(phase, milliseconds) {
  const error = new Error(`API ${phase} timed out after ${milliseconds / 1000} seconds`);
  error.statusCode = 504;
  return error;
}

/** Await user code without leaving an abort listener attached after it settles. */
export function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/**
 * Pull one source chunk at a time, splitting it without copying its bytes.
 * Explicit iterator methods also make return() cancel before the first next().
 */
export function streamingBody(source, { signal, onCancel, onComplete, timeoutMs = 25_000, runInContext = callback => callback() } = {}) {
  const reader = source?.getReader?.();
  const iterator = reader ? {
    next: () => reader.read(),
    return: reason => reader.cancel(reason),
  } : source?.[Symbol.asyncIterator]?.();
  if (!iterator) throw new TypeError('A streaming response requires a ReadableStream or async iterable');
  let stopped = false;
  let failure;
  let chunk;
  let offset = 0;
  let timer;
  let nextInProgress = false;
  let rejectPending;

  function clean() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    chunk = undefined;
    if (reader) {
      try { reader.releaseLock(); } catch { /* Cancellation may still be settling a pending read. */ }
    }
    onComplete?.();
  }

  function stop(reason, error = false) {
    if (stopped) return;
    stopped = true;
    if (error) failure = abortError(reason);
    rejectPending?.(failure || abortError(reason));
    // A user stream may never settle its cancel callback. Release our request
    // immediately, while observing that callback's eventual rejection.
    try { Promise.resolve(runInContext(() => iterator.return?.(reason))).catch(() => {}); } catch {}
    try { onCancel?.(abortError(reason)); }
    catch (error) { failure ||= error; }
    finally { clean(); }
  }

  function touch() {
    clearTimeout(timer);
    if (timeoutMs > 0) {
      timer = setTimeout(() => stop(apiTimeoutError('response idle', timeoutMs), true), timeoutMs);
      timer.unref?.();
    }
  }
  function aborted() { stop(signal.reason, true); }
  if (signal?.aborted) aborted();
  else { signal?.addEventListener('abort', aborted, { once: true }); touch(); }

  const body = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (failure) throw failure;
      if (stopped) return { done: true, value: undefined };
      if (nextInProgress) throw new Error('Response body reads must be sequential');
      nextInProgress = true;
      try {
        while (!chunk || offset >= chunk.byteLength) {
          chunk = undefined;
          const canceled = new Promise((_, reject) => { rejectPending = reject; });
          const next = await Promise.race([runInContext(() => iterator.next()), canceled]);
          rejectPending = undefined;
          if (stopped) {
            if (failure) throw failure;
            return { done: true, value: undefined };
          }
          if (next.done) {
            stopped = true;
            clean();
            return { done: true, value: undefined };
          }
          if (!(next.value instanceof Uint8Array)) throw new TypeError('Response body chunks must be Uint8Array values');
          chunk = next.value;
          offset = 0;
        }
        const value = chunk.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, chunk.byteLength));
        offset += value.byteLength;
        touch();
        return { done: false, value };
      } catch (error) {
        if (stopped && !failure) return { done: true, value: undefined };
        stop(error, true);
        throw failure || error;
      } finally { nextInProgress = false; rejectPending = undefined; }
    },
    async return(reason) {
      stop(reason || abortError());
      return { done: true, value: undefined };
    },
    async throw(error) { stop(error, true); throw error; },
    cancel(reason) { return body.return(reason); },
  };
  return body;
}
