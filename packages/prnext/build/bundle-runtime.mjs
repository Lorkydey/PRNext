import { build } from 'esbuild';
import { lstat, realpath, readdir, writeFile, unlink,readFile } from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {version as esbuildVersion} from 'esbuild';
import {privateCacheDirectory,readCacheRecord,writeCacheRecord} from './persistent-cache.mjs';

// Paths used by the native worker, generated application modules, prerender,
// standalone tracing, compatibility modules and the runtime lifecycle contract.
// Other relative imports are resolved into shared chunks by this single build.
export const runtimeEntryNames = Object.freeze([
  'worker', 'rsc-worker', 'app-render', 'app-stream-html', 'transport', 'request-work',
  'http', 'app-static', 'route-static', 'render', 'api', 'middleware', 'incremental-cache', 'app-instant',
  'action-crypto', 'action-client', 'action-ssr', 'edge', 'metadata-route', 'og-loader',
].sort());

/** Run once, after compiling application/Edge graphs and before any prerender. */
export async function bundleRuntime(stage,{projectRoot,sourceDirectory}={}) {
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
  const input=sourceDirectory?await realpath(sourceDirectory):runtime;
  const entries = await readdir(input, { withFileTypes: true });
  const originals = entries.filter(entry => entry.name.endsWith('.mjs')&&!entry.name.endsWith('.test.mjs'));
  if (originals.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Runtime source modules must be ordinary files.');
  }
  for (const name of runtimeEntryNames) {
    if (!originals.some(entry => entry.name === `${name}.mjs`)) throw new Error(`Missing runtime entry ${name}.mjs`);
  }
  const sources=new Map();
  // Production compiles the installed sources directly. Only generated stage
  // overrides (currently the bundled env loader) replace an installed module.
  // Hash and compile the same captured bytes; do not trust mtimes or skip app
  // graph callbacks. This avoids copying hundreds of modules into every stage.
  for(const entry of originals){
    let file=path.join(input,entry.name);
    if(sourceDirectory){const override=path.join(runtime,entry.name);const info=await lstat(override).catch(e=>{if(e.code!=='ENOENT')throw e;});if(info){if(!info.isFile()||info.isSymbolicLink())throw Error('Runtime overrides must be ordinary files');file=override;}}
    sources.set(path.join(input,entry.name),await readFile(file));
  }
  let directory,key,cached;
  if(projectRoot){
    directory=await privateCacheDirectory(projectRoot,'runtime-bundle-v2');
    if(directory){
      const hash=createHash('sha256').update(esbuildVersion).update(JSON.stringify(runtimeEntryNames)).update(await readFile(new URL('./bundle-runtime.mjs',import.meta.url)));
      for(const entry of [...originals].sort((a,b)=>a.name.localeCompare(b.name)))hash.update(JSON.stringify([entry.name,createHash('sha256').update(sources.get(path.join(input,entry.name))).digest('hex')]));
      key=hash.digest('hex');cached=await readCacheRecord(directory,key);
    }
  }
  // write:false makes compilation atomic with respect to the source runtime:
  // no files change if parsing or resolution fails. The virtual output is a
  // sibling so all relative paths have the same depth as the final runtime.
  const virtualOutput = path.join(resolvedStage, '.runtime-bundle');
  const validCache=cached&&Array.isArray(cached.files)&&cached.files.length<=128&&cached.files.every(item=>Array.isArray(item)&&item.length===2&&/^[\w-]+\.mjs$/.test(item[0])&&typeof item[1]==='string')&&new Set(cached.files.map(([name])=>name)).size===cached.files.length&&runtimeEntryNames.every(name=>cached.files.some(([file])=>file===name+'.mjs'));
  const result = validCache?null:await build({
    absWorkingDir: input,
    entryPoints: runtimeEntryNames.map(name => path.join(input, `${name}.mjs`)),
    outdir: virtualOutput,
    outbase: input,
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
    plugins:[{name:'prnext-runtime-snapshot',setup(build){build.onLoad({filter:/\.mjs$/},args=>sources.has(args.path)?{contents:sources.get(args.path),loader:'js',resolveDir:path.dirname(args.path)}:undefined);}}],
  });
  const emitted = new Map();
  if(validCache)for(const [name,contents]of cached.files)emitted.set(name,Buffer.from(contents));
  for (const file of result?.outputFiles||[]) {
    if (path.dirname(file.path) !== virtualOutput || !file.path.endsWith('.mjs')) {
      throw new Error('Runtime bundler emitted a file outside its flat output directory.');
    }
    emitted.set(path.basename(file.path), file.contents);
  }
  if (runtimeEntryNames.some(name => !emitted.has(`${name}.mjs`))) throw new Error('Runtime bundle omitted a required entry.');
  if(directory&&!validCache)await writeCacheRecord(directory,key,{files:[...emitted].map(([name,bytes])=>[name,Buffer.from(bytes).toString()])});
  // This is an unpublished, disposable stage. On any write failure buildProject
  // discards the stage and preserves the previous published build unchanged.
  for (const [name, contents] of emitted) await writeFile(path.join(runtime, name), contents);
  for (const entry of await readdir(runtime,{withFileTypes:true})) {
    if(!entry.name.endsWith('.mjs')||!entry.isFile())continue;
    if (!emitted.has(entry.name)) await unlink(path.join(runtime, entry.name));
  }
  // JSON, CJS, license files and the OG assets directory are never traversed or
  // removed. The caller writes the normal runtime contract after prerender.
  return { entryCount: runtimeEntryNames.length, moduleCount: emitted.size,cached:!!validCache,
    bytes: [...emitted.values()].reduce((sum, contents) => sum + contents.length, 0) };
}
