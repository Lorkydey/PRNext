import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

const rsc = new Map();
const fraction = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const milliseconds = value => Number.isFinite(value) ? Math.max(0, Math.min(60_000, value)) : 0;

// No interval of its own: the existing host heartbeat samples both JS isolates.
// RSS is read only in the host, since worker threads share the same process RSS.
export function createResourceMonitor({ memory = false } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previous = performance.eventLoopUtilization(), at = performance.now(), gc = 0;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) gc += entry.duration;
  });
  observer.observe({ entryTypes: ['gc'] });
  return {
    sample() {
      const now = performance.now(), elapsed = Math.max(1, now - at);
      const current = performance.eventLoopUtilization();
      const result = { rss: memory ? process.memoryUsage.rss() : 0,
        busy: fraction(performance.eventLoopUtilization(current, previous).utilization),
        delayMs: milliseconds(delay.count ? delay.percentile(99) / 1e6 : 0), gc: fraction(gc / elapsed) };
      previous = current; at = now; gc = 0; delay.reset();
      return result;
    },
    close() { observer.disconnect(); delay.disable(); },
  };
}

export function registerResourceWorker(worker, active) {
  rsc.set(worker, { active, sample: undefined, at: 0, probing: 0 });
  worker.once('exit', () => rsc.delete(worker));
}
export function recordResourceWorker(worker, sample) {
  const entry = rsc.get(worker);
  if (!entry || !sample || !['busy', 'delayMs', 'gc'].every(key => Number.isFinite(sample[key]))) return;
  entry.sample = { busy: fraction(sample.busy), delayMs: milliseconds(sample.delayMs), gc: fraction(sample.gc) };
  entry.at = performance.now(); entry.probing = 0;
}
export function aggregateResourceLoad(sample, now = performance.now()) {
  const result = { ...sample };
  for (const [worker, entry] of rsc) {
    if (entry.sample && now - entry.at <= 3000) {
      result.busy = Math.max(result.busy, entry.sample.busy);
      result.delayMs = Math.max(result.delayMs, entry.sample.delayMs);
      result.gc = Math.max(result.gc, entry.sample.gc);
    }
    if (entry.probing && now - entry.probing > 1500 && entry.active()) {
      result.busy = 1; result.delayMs = milliseconds(now - entry.probing);
    }
    if (!entry.probing) {
      entry.probing = now;
      try { worker.postMessage({ type: 'resource-probe' }); }
      catch { entry.probing = 0; }
    }
  }
  return result;
}
