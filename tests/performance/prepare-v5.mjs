// Build a runtime variant from its immutable source snapshot. The fixture's
// application sources and pinned Next build remain identical across variants.
import { readFile, stat, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [name] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error('A named snapshot is required');
const candidate = path.join(root, 'artifacts/performance-v5/candidates', name);
const source = path.join(candidate, 'source');
const provenance = JSON.parse(await readFile(path.join(candidate, 'source.json'), 'utf8'));
for (const [name, expected] of Object.entries(provenance.sourceSha256)) {
  const actual = createHash('sha256').update(await readFile(path.join(source, name))).digest('hex');
  if (actual !== expected) throw new Error('Snapshot changed: ' + name);
}
const app = path.join(root, 'artifacts/performance/app');
const output = path.join(app, '.prnext-v5-' + name);
if (await stat(output).then(() => true, () => false)) throw new Error('Build already exists: ' + output);
if (await stat(path.join(app, '.prnext')).then(() => true, () => false)) throw new Error('Unclaimed fixture build already exists');
const { build } = await import(pathToFileURL(path.join(source, 'packages/prnext/build/index.mjs')));
const before = performance.now();
await build(app);
await rename(path.join(app, '.prnext'), output);
await writeFile(path.join(candidate, 'application-build.json'), JSON.stringify({
  sourceTreeDigest: provenance.sourceTreeDigest, node: process.version, output,
  elapsedSeconds: (performance.now() - before) / 1000, complete: true,
}, null, 2));
console.log('Built immutable runtime variant:', output);
