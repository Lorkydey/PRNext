import {availableParallelism, freemem} from 'node:os';
import {mapConcurrent} from './concurrent.mjs';

// Budget admission, not a claim to cap esbuild/PostCSS process RSS. A single
// heavy custom transform can exceed its estimate, so unknown hooks stay serial.
export function buildPlanConcurrency(options, {cpus = availableParallelism(), freeBytes = freemem()} = {}) {
  if (!options) return 1;
  return Math.max(1, Math.min(options.maxWorkers, cpus, Math.floor(options.maxMemoryMb / 256), Math.floor(freeBytes / (512 * 1024 * 1024))));
}

export function immutableStylePlan(routes, getPlan) {
  const jobs = new Map();
  const plannedRoutes = routes.map(route => Object.freeze({id: route.id, parallel: !!route.parallel,
    scopes: Object.freeze(getPlan(route).map(scope => {
      const styles = Object.freeze([...scope.styles]);
      const signature = JSON.stringify(styles);
      if (!jobs.has(signature)) jobs.set(signature, Object.freeze({signature, styles}));
      return Object.freeze({signature, path: scope.path, kind: scope.kind});
    })),
  }));
  return Object.freeze({routes: Object.freeze(plannedRoutes), jobs: Object.freeze([...jobs.values()])});
}

export async function executeStylePlan(plan, run, options) {
  const concurrency = buildPlanConcurrency(options);
  const outputs = await mapConcurrent(plan.jobs, run, concurrency);
  return {outputs: new Map(plan.jobs.map((job, index) => [job.signature, outputs[index]])), concurrency};
}
