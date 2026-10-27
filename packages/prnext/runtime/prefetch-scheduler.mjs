const INTENT = 1;
const abortError = () => Object.assign(new Error('Speculative navigation cancelled'), { name: 'AbortError' });

// The completed-result cache obeys the same priority as the producer queue.
// Otherwise a viewport scan could evict the hovered route immediately after
// the scheduler had correctly protected its request.
export function prefetchCacheVictim(cache, priority) {
  let candidate;
  for (const [key, entry] of cache) {
    if (entry.abort.signal.aborted) return key;
    if (!candidate || entry.priority < candidate[1].priority) candidate = [key, entry];
  }
  return candidate && candidate[1].priority <= priority ? candidate[0] : undefined;
}

// Speculative work never competes with a committed navigation. The same policy
// is used by both routers; data and authorization remain in their own caches.
export function createPrefetchScheduler({ window: win = globalThis.window, document: doc = globalThis.document,
  concurrency = 2, limit = 8 } = {}) {
  const tasks = new Set();
  let serial = 0, active = 0, navigating = 0, disposed = false, scheduled = false;
  const connection = win?.navigator?.connection;
  const priorityOf = value => value === 'viewport' ? 0 : INTENT;
  function policy(priority) {
    const network = win?.navigator?.connection;
    if (doc?.visibilityState === 'hidden' || win?.navigator?.onLine === false || network?.saveData || /^(slow-)?2g$/.test(network?.effectiveType || '')) return 0;
    const slow = network?.effectiveType === '3g' || (network?.downlink > 0 && network.downlink < 1.5);
    return slow ? (priority < INTENT ? 0 : 1) : concurrency;
  }
  function finish(task, error, value) {
    if (!tasks.delete(task)) return;
    if (task.running) active--;
    task.abort.signal.removeEventListener('abort', task.cancelled);
    const { resolve, reject } = task;
    task.run = task.resolve = task.reject = task.cancelled = undefined;
    error ? reject(error) : resolve(value);
    wake();
  }
  function start(task) {
    task.running = true; active++;
    let result;
    try { result = task.run(task.abort.signal); } catch (error) { finish(task, error); return; }
    Promise.resolve(result).then(value => finish(task, null, value), error => finish(task, error));
  }
  function pump() {
    scheduled = false;
    if (disposed) return;
    const queued = [...tasks].filter(task => !task.running).sort((a, b) => b.priority - a.priority || a.order - b.order);
    for (const task of queued) {
      if (!tasks.has(task)) continue;
      if (task.priority === 2) { start(task); continue; }
      if (navigating) break;
      const slots = policy(task.priority);
      if (!slots) { task.abort.abort(abortError()); continue; }
      if (active >= slots) continue;
      start(task);
    }
  }
  function wake() {
    if (scheduled || disposed) return;
    scheduled = true; queueMicrotask(pump);
  }
  function changed() {
    for (const task of tasks) if (task.priority !== 2 && !policy(task.priority)) task.abort.abort(abortError());
    wake();
  }
  doc?.addEventListener?.('visibilitychange', changed);
  win?.addEventListener?.('online', changed);
  win?.addEventListener?.('offline', changed);
  connection?.addEventListener?.('change', changed);
  return {
    schedule(run, { priority, abort = new AbortController() } = {}) {
      const rank = priorityOf(priority);
      if (disposed || abort.signal.aborted || !policy(rank)) return undefined;
      if (tasks.size >= limit) {
        // Keep intent ahead of broad viewport scans. Never evict demand work.
        const oldest = [...tasks].filter(task => task.priority < 2).sort((a, b) => a.priority - b.priority || a.order - b.order)[0];
        if (!oldest || oldest.priority > rank) return undefined;
        oldest.abort.abort(abortError());
      }
      const task = { run, abort, priority: rank, order: serial++ };
      const promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
      // Cancellation also settles a task whose producer ignores AbortSignal.
      // A late result cannot regain a queue slot or resurrect an invalid cache.
      task.cancelled = () => finish(task, abort.signal.reason || abortError());
      tasks.add(task); abort.signal.addEventListener('abort', task.cancelled, { once: true });
      wake();
      return { abort, promise,
        promote(priority = 'intent') { if (tasks.has(task)) { task.priority = Math.max(task.priority, priorityOf(priority)); wake(); } },
        demand() { if (tasks.has(task)) { task.priority = 2; wake(); } },
      };
    },
    navigation(target) {
      navigating++;
      target?.demand();
      for (const task of tasks) if (task.abort !== target?.abort && task.priority !== 2) task.abort.abort(abortError());
      let released = false;
      return () => { if (!released) { released = true; navigating--; wake(); } };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      doc?.removeEventListener?.('visibilitychange', changed);
      win?.removeEventListener?.('online', changed);
      win?.removeEventListener?.('offline', changed);
      connection?.removeEventListener?.('change', changed);
      for (const task of tasks) task.abort.abort(abortError());
    },
  };
}
