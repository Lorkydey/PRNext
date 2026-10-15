import { build } from 'esbuild';
import { lstat, realpath, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

// Paths used by the native worker, generated application modules, prerender,
// standalone tracing, compatibility modules and the runtime lifecycle contract.
// Other relative imports are resolved into shared chunks by this single build.
export const runtimeEntryNames = Object.freeze([
  'worker', 'rsc-worker', 'app-render', 'app-stream-html', 'transport', 'request-work',
  'http', 'app-static', 'route-static', 'render', 'api', 'middleware', 'incremental-cache', 'app-instant',
  'action-crypto', 'action-client', 'action-ssr', 'edge', 'metadata-route', 'og-loader',
].sort());

/** Run once, after compiling application/Edge graphs and before any prerender. */
export async function bundleRuntime(stage) {
  const resolvedStage = path.resolve(stage);
  if (!path.basename(resolvedStage).startsWith('.prnext-build-')) {
    throw new Error('Runtime bundling requires an unpublished PRNext build stage.');
  }
  const runtime = path.join(resolvedStage, 'runtime');
  const [stageInfo, runtimeInfo] = await Promise.all([lstat(resolvedStage), lstat(runtime)]);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || !runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
    throw new Error('Runtime bundling requires ordinary stage and runtime directories.');
  }
  const [canonicalStage, canonicalRuntime] = await Promise.all([realpath(resolvedStage), realpath(runtime)]);
  if (path.relative(canonicalStage, canonicalRuntime) !== 'runtime') {
    throw new Error('Runtime bundling escaped the build stage.');
  }
  const entries = await readdir(runtime, { withFileTypes: true });
  const originals = entries.filter(entry => entry.name.endsWith('.mjs'));
  if (originals.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Runtime source modules must be ordinary files.');
  }
  for (const name of runtimeEntryNames) {
    if (!originals.some(entry => entry.name === `${name}.mjs`)) throw new Error(`Missing runtime entry ${name}.mjs`);
  }
  // write:false makes compilation atomic with respect to the source runtime:
  // no files change if parsing or resolution fails. The virtual output is a
  // sibling so all relative paths have the same depth as the final runtime.
  const virtualOutput = path.join(resolvedStage, '.runtime-bundle');
  const result = await build({
    absWorkingDir: runtime,
    entryPoints: runtimeEntryNames.map(name => path.join(runtime, `${name}.mjs`)),
    outdir: virtualOutput,
    outbase: runtime,
    entryNames: '[name]',
    chunkNames: '_shared-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    // Edge's prepared VM is already a self-contained CJS artifact. Keeping it
    // external preserves its delayed import and original execution boundary.
    external: ['../compat/*', './profiles.json', './*.cjs'],
    minify: false,
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const emitted = new Map();
  for (const file of result.outputFiles) {
    if (path.dirname(file.path) !== virtualOutput || !file.path.endsWith('.mjs')) {
      throw new Error('Runtime bundler emitted a file outside its flat output directory.');
    }
    emitted.set(path.basename(file.path), file.contents);
  }
  if (runtimeEntryNames.some(name => !emitted.has(`${name}.mjs`))) throw new Error('Runtime bundle omitted a required entry.');
  // This is an unpublished, disposable stage. On any write failure buildProject
  // discards the stage and preserves the previous published build unchanged.
  for (const [name, contents] of emitted) await writeFile(path.join(runtime, name), contents);
  for (const entry of originals) {
    if (!emitted.has(entry.name)) await unlink(path.join(runtime, entry.name));
  }
  // JSON, CJS, license files and the OG assets directory are never traversed or
  // removed. The caller writes the normal runtime contract after prerender.
  return { entryCount: runtimeEntryNames.length, moduleCount: emitted.size,
    bytes: [...emitted.values()].reduce((sum, contents) => sum + contents.length, 0) };
}
