import diagnostics from '../compat/diagnostics.cjs';

const phases = new Set(['ssr', 'rsc']);
const outcomes = new Set(['completed', 'failed', 'cancelled', 'timedOut']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 32 * 1024 * 1024) : 0;

// Disabled in the ordinary request path. No body, URL, parameters, nonce, model,
// client references or request context is retained, even when enabled. Timings
// include asynchronous rendering/waiting; they are NOT isolated encoder CPU.
export function createFlightMeasurement(request, phase, options) {
  if (!(options?.enabled ?? diagnostics.enabled) || !phases.has(phase)) return;
  const now = options?.now ?? (() => performance.now());
  const record = options?.record ?? diagnostics.record;
  const started = now();
  const route = typeof request?.routePattern === 'string' ? request.routePattern.slice(0, 256) : '<unattributed>';
  const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request?.method) ? request.method : '_OTHER';
  let ended = false, firstChunkMs, modelReadyMs, shellReadyMs, ppr;
  const elapsed = () => Math.max(0, Math.min(86400000, now() - started));
  const metrics = {
    flightBytes: 0, flightChunks: 0, responseBytes: 0, peakQueuedBytes: 0,
    chunk(bytes) {
      if (ended) return;
      firstChunkMs ??= elapsed();
      metrics.flightBytes += count(bytes);
      metrics.flightChunks++;
    },
    mark(name) {
      if (ended) return;
      if (name === 'modelReady') modelReadyMs ??= elapsed();
      else if (name === 'shellReady') shellReadyMs ??= elapsed();
    },
    partial(mode) { if (!ended && ['direct', 'normalized'].includes(mode)) ppr = mode; },
    finish(outcome, status) {
      if (ended || !outcomes.has(outcome)) return;
      ended = true;
      const event = { route, method, phase, outcome, durationMs: elapsed(),
        flightBytes: count(metrics.flightBytes), flightChunks: count(metrics.flightChunks),
        responseBytes: count(metrics.responseBytes), peakQueuedBytes: count(metrics.peakQueuedBytes),
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {status} : {}),
        ...(firstChunkMs !== undefined ? {firstChunkMs} : {}),
        ...(modelReadyMs !== undefined ? {modelReadyMs} : {}),
        ...(shellReadyMs !== undefined ? {shellReadyMs} : {}), ...(ppr ? {ppr} : {}) };
      // Diagnostics must never replace a response/error with an export failure.
      try { record('flight', event); } catch {}
    },
  };
  return metrics;
}
