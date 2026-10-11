import { appTimeoutError } from './app-errors.mjs';

// Per-isolate admission includes abandoned requests until the isolate confirms
// settlement. A burst of cooperative cancellations gets time to acknowledge
// without immediately terminating unrelated active responses.
export function createRscLifecycle(retire, {
  cancellationLimit = 16, maxActive = 512, maxWaiters = 512,
} = {}) {
  for (const [name, value] of Object.entries({ cancellationLimit, maxActive, maxWaiters })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (typeof retire !== 'function') throw new TypeError('retire must be a function');
  const active = new Set(), waiters = new Set(), retirementWaiters = new Set();
  let cancelled = 0, closedError, retirement, retired = false, retirementFailed = false, retirementError;
  const timeoutError = milliseconds => appTimeoutError('RSC admission', milliseconds);
  const available = () => !closedError && cancelled < cancellationLimit && active.size < maxActive;

  function lease() {
    const token = { cancelled: false };
    active.add(token);
    return {
      cancel() {
        if (!active.has(token) || token.cancelled) return;
        token.cancelled = true;
        cancelled++;
        // Pressure closes admission, never shortens an existing request's
        // deadline. Mutations and cache work may legitimately outlive callers.
      },
      release() {
        if (!active.delete(token)) return;
        if (token.cancelled) cancelled--;
        drain();
      },
    };
  }

  function drain() {
    for (const waiter of waiters) {
      if (!available()) break;
      waiter.cleanup();
      if (waiter.signal?.aborted) waiter.reject(waiter.signal.reason);
      else if (performance.now() >= waiter.deadline) waiter.reject(timeoutError(waiter.timeoutMs));
      else waiter.resolve(lease());
    }
  }

  function acquire({ signal, timeoutMs = 28000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (closedError) return Promise.reject(closedError);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(timeoutError(timeoutMs));
    if (available()) return Promise.resolve(lease());
    return queue(waiters, signal, timeoutMs);
  }

  function queue(collection, signal, timeoutMs) {
    if (waiters.size + retirementWaiters.size >= maxWaiters) {
      const error = new Error('App Router RSC admission queue is full');
      error.statusCode = 503;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => { waiter.cleanup(); reject(signal.reason); };
      const waiter = { signal, timeoutMs, deadline: performance.now() + timeoutMs, resolve, reject,
        cleanup() { collection.delete(waiter); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
      };
      collection.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { waiter.cleanup(); reject(timeoutError(timeoutMs)); }, timeoutMs);
    });
  }

  function waitForRetirement({ signal, timeoutMs = 28000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(timeoutError(timeoutMs));
    if (!retirement) return Promise.reject(new Error('App Router worker is not retiring'));
    if (retired) return retirementFailed ? Promise.reject(retirementError) : Promise.resolve();
    return queue(retirementWaiters, signal, timeoutMs);
  }

  function finishRetirement(error, failed = false) {
    retired = true;
    retirementFailed = failed;
    retirementError = error;
    for (const waiter of retirementWaiters) {
      waiter.cleanup();
      if (waiter.signal?.aborted) waiter.reject(waiter.signal.reason);
      else if (performance.now() >= waiter.deadline) waiter.reject(timeoutError(waiter.timeoutMs));
      else if (failed) waiter.reject(error);
      else waiter.resolve();
    }
  }

  function close(error = new Error('App Router worker closed')) {
    if (closedError) return;
    closedError = error;
    for (const waiter of waiters) { waiter.cleanup(); waiter.reject(error); }
  }

  function terminate(error = new Error('App Router worker retired')) {
    close(error);
    // Worker.terminate() adds an exit listener. Share exactly one call/promise
    // across all request deadlines, cancellation pressure and shutdown paths.
    if (!retirement) {
      retirement = Promise.resolve().then(retire);
      // One observer per isolate, rather than one Promise reaction retained
      // for every caller that times out/aborts while the isolate is stopping.
      retirement.then(() => finishRetirement(), error => finishRetirement(error, true));
    }
    return retirement;
  }

  return {
    acquire, close, terminate, waitForRetirement,
    get retiring() { return retirement ?? null; },
    get closed() { return !!closedError; },
    get stats() { return { active: active.size, cancelled, waiting: waiters.size + retirementWaiters.size, closed: !!closedError }; },
  };
}
