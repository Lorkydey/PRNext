// Framework preparation only: never import a route, render an app component or call
// application code. Imports cannot be unloaded or interrupted inside V8; the
// native parent bounds bootstrap and owns cancellation of the entire child.
export async function prewarmFramework({ routes, options, load, signal }, {
  now = () => performance.now(), rss = () => process.memoryUsage().rss,
} = {}) {
  if (!Number.isFinite(options?.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 30000
    || !Number.isFinite(options?.maxRssMb) || options.maxRssMb <= 0 || options.maxRssMb > 2048) {
    throw new TypeError('Invalid framework prewarm budget');
  }
  const started = now(), deadline = started + options.timeoutMs, loaded = [];
  const available = () => signal?.aborted ? 'cancelled'
    : now() >= deadline ? 'timeout'
    : rss() >= options.maxRssMb * 1024 * 1024 ? 'rss' : undefined;
  const result = reason => ({ ready: !reason, reason, loaded, durationMs: Math.max(0, now() - started) });
  const nodeRoutes = routes.filter(route => (route.cacheConfig?.runtime ?? route.handlerConfig?.runtime) !== 'edge');
  const modules = [];
  if (nodeRoutes.some(route => route.router === 'app' && route.kind === 'page')) modules.push('app-render');
  if (nodeRoutes.some(route => route.router !== 'app' && route.kind === 'page')) modules.push('render');
  if (nodeRoutes.some(route => route.kind === 'api')) modules.push('api');
  for (const name of modules) {
    let reason = available();
    if (reason) return result(reason);
    const module = await load(name);
    reason = available();
    if (reason) return result(reason);
    if (name === 'app-render') {
      await module.prewarmAppRenderer({ ...options, timeoutMs: Math.max(1, deadline - now()), signal });
      reason = available();
      if (reason) return result(reason);
    }
    loaded.push(name);
  }
  return result(available());
}
