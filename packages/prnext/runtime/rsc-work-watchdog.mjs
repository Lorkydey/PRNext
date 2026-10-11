// Response deadlines stop when a response completes. While its cache work is
// still settling, probe the shared isolate's responsiveness instead of imposing
// another deadline on legitimate asynchronous work. Fully idle isolates have
// no watchdog timer.
export function createRscWorkWatchdog({ probe, retire, intervalMs = 5000, timeoutMs = 30000 } = {}) {
  if (typeof probe !== 'function' || typeof retire !== 'function') throw new TypeError('probe and retire must be functions');
  for (const [name, value] of Object.entries({ intervalMs, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  }
  let work = 0, timer, expected, nextToken = 0, closed = false;

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    expected = undefined;
  }

  function close() {
    if (closed) return;
    closed = true;
    work = 0;
    clear();
  }

  function fail(token, error) {
    if (closed || !work || expected !== token) return;
    close();
    // Close first so concurrent timeout/probe failures cannot retire twice.
    void Promise.resolve().then(() => retire(error)).catch(failure => {
      console.error('[prnext] RSC work watchdog retirement failed:', failure);
    });
  }

  function schedule() {
    if (closed || !work || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || !work) return;
      const token = ++nextToken;
      expected = token;
      // The default exceeds the existing foreground render deadline: a
      // synchronous foreground render must not lose its established budget.
      timer = setTimeout(() => fail(token, new Error(`App Router worker did not acknowledge its background-work probe within ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
      try {
        Promise.resolve(probe(token)).catch(error => fail(token, error));
      } catch (error) { fail(token, error); }
    }, intervalMs);
    timer.unref();
  }

  function add() {
    if (closed) return () => {};
    work++;
    schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (closed) return;
      if (--work === 0) clear();
    };
  }

  function ack(token) {
    if (closed || !work || expected === undefined || token !== expected) return;
    clear();
    schedule();
  }

  return {
    add, ack, close,
    get stats() { return { work, scheduled: timer !== undefined, awaitingAck: expected !== undefined, closed }; },
  };
}
