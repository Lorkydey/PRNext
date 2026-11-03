import {availableParallelism, freemem} from 'node:os';
import {mapConcurrent} from './concurrent.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

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

// Independent CSS graphs can emit the same url() asset. Compile in parallel,
// but publish each exact output once. Keep only hashes and settled promises,
// not all completed bundles, so memory stays bounded by admitted jobs.
export function createStyleOutputWriter(directory) {
  const root = path.resolve(directory), outputs = new Map();
  return async files => {
    for (const file of files) {
      const target = path.resolve(file.path), relative = path.relative(root, target);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Style output escaped its build directory');
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      const hash = createHash('sha256').update(file.contents).digest('hex');
      const previous = outputs.get(key);
      if (previous) {
        if (previous.hash !== hash) throw new Error(`Conflicting style output: ${relative}`);
        await previous.written;
      } else {
        const written = (async () => {await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, file.contents);})();
        outputs.set(key, {hash, written});
        await written;
      }
    }
  };
}
