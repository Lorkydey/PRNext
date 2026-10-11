import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Protocol compatibility does not imply safe retirement. These modules jointly
// implement activity tracking, cancellation and post-response draining.
export const lifecycleModules = ['worker.mjs', 'transport.mjs', 'request-work.mjs', 'app-render.mjs', 'app-stream-html.mjs', 'rsc-worker.mjs'];
export async function writeRuntimeContract(stage) {
  const files = (await Promise.all(['runtime', 'compat'].map(async directory =>
    (await readdir(path.join(stage,directory))).filter(name => /\.(?:mjs|cjs|json)$/.test(name)).map(name => `${directory}/${name}`)))).flat().sort();
  const modules = Object.fromEntries(await Promise.all(files.map(async name =>
    [name, createHash('sha256').update(await readFile(path.join(stage, name))).digest('hex')])));
  const contract = { schema: 1, protocol: 2, lifecycle: 1,
    capabilities: ['activity', 'tracked-finalization', 'graceful-drain', 'lane-cancellation'], modules };
  await writeFile(path.join(stage, 'runtime-contract.json'), JSON.stringify(contract, null, 2) + '\n');
}
