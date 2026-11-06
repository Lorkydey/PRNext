import {AsyncLocalStorage} from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const names = new Set(['configuration', 'discovery', 'runtime-inputs', 'pages-server', 'pages-browser', 'pages-output', 'middleware', 'metadata', 'app', 'instrumentation', 'types', 'runtime-bundle', 'prerender', 'native-ppr', 'retention', 'precompression', 'analysis', 'standalone', 'compiler-node', 'compiler-browser', 'compiler-edge']);

/** Wall times include awaited native/compiler work; nested phases are not additive. */
export async function withBuildTimings(run, clock = () => performance.now()) {
  const state = {clock, started: clock(), phases: new Map()};
  return storage.run(state, async () => {
    try { return {result: await run(), timings: report(state)}; }
    catch (error) {
      // Diagnostics must never replace the original application/build failure.
      try { if (error && typeof error === 'object') Object.defineProperty(error, 'buildTimings', {value: report(state), configurable: true}); } catch {}
      throw error;
    }
  });
}

export async function measureBuildPhase(name, run) {
  if (!names.has(name)) throw new TypeError('Unknown build timing phase');
  const state = storage.getStore();
  if (!state) return run();
  const started = state.clock();
  let failed = false;
  try { return await run(); }
  catch (error) { failed = true; throw error; }
  finally {
    const row = state.phases.get(name) || {calls: 0, failedCalls: 0, milliseconds: 0};
    row.calls++; row.failedCalls += Number(failed); row.milliseconds += Math.max(0, state.clock() - started);
    state.phases.set(name, row);
  }
}

function report(state) {
  return {version: 1, scope: 'build-wall-time-excluding-module-startup', nestedPhasesAreAdditive: false,
    totalMilliseconds: Math.max(0, state.clock() - state.started),
    phases: Object.fromEntries([...state.phases].map(([name, value]) => [name, {...value}]))};
}
