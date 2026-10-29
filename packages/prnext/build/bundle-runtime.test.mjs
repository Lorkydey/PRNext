import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bundleRuntime, runtimeEntryNames } from './bundle-runtime.mjs';

test('direct runtime snapshots reuse cached output and invalidate source and generated overrides',async()=>{
  const f=await fixture();
  try{
    const input=path.join(f.directory,'installed-runtime');await rename(path.join(f.stage,'runtime'),input);
    await writeFile(path.join(input,'helper.mjs'),'export const value=1;');
    await writeFile(path.join(input,'worker.mjs'),"export {value} from './helper.mjs';");
    await writeFile(path.join(input,'should-not-ship.test.mjs'),'this is deliberately not JavaScript');
    async function build(override){const stage=path.join(f.directory,'.prnext-build-'+randomUUID());await mkdir(path.join(stage,'runtime'),{recursive:true});await writeFile(path.join(stage,'runtime/http.mjs'),'export const override='+override+';');return {stage,result:await bundleRuntime(stage,{projectRoot:f.directory,sourceDirectory:input})};}
    const first=await build(1),second=await build(1);assert.equal(first.result.cached,false);assert.equal(second.result.cached,true);
    assert.ok(!(await readdir(path.join(second.stage,'runtime'))).includes('helper.mjs'));
    await writeFile(path.join(input,'helper.mjs'),'export const value=2;');
    const third=await build(1);assert.equal(third.result.cached,false);
    assert.equal((await import(pathToFileURL(path.join(third.stage,'runtime/worker.mjs')).href)).value,2);
    const fourth=await build(2);assert.equal(fourth.result.cached,false);
    assert.equal((await import(pathToFileURL(path.join(fourth.stage,'runtime/http.mjs')).href)).override,2);
  }finally{await f.cleanup();}
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-bundle-runtime-test-'));
  const stage = path.join(directory, `.prnext-build-${randomUUID()}`);
  await mkdir(path.join(stage, 'runtime'), { recursive: true });
  await mkdir(path.join(stage, 'compat'));
  for (const name of runtimeEntryNames) await writeFile(path.join(stage, 'runtime', `${name}.mjs`), 'export const sentinel = true;\n');
  return { directory, stage, put: async (name, source) => writeFile(path.join(stage, name), source),
    async cleanup() {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('prnext-bundle-runtime-test-')) {
        throw new Error('Refusing cleanup outside the owned temporary fixture.');
      }
      await rm(resolved, { recursive: true, force: true });
    } };
}

test('shared runtime preserves singleton/live exports, lazy boundaries and relocated asset paths', async () => {
  const f = await fixture(), token = `prnext-bundle-${randomUUID()}`;
  try {
    await f.put('runtime/internal-state.mjs', `globalThis[${JSON.stringify(token)}]=(globalThis[${JSON.stringify(token)}]||0)+1;export const identity={};export let value=0;export function increment(){return ++value;}`);
    await f.put('runtime/internal-lazy.mjs', `globalThis[${JSON.stringify(token + '-lazy')}]=true;export {identity} from './internal-state.mjs';`);
    await f.put('runtime/worker.mjs', `export {identity,value,increment} from './internal-state.mjs';export const load=()=>import('./internal-lazy.mjs');export const workerUrl=()=>new URL('./rsc-worker.mjs',import.meta.url);export {default as compatibility} from '../compat/state.cjs';`);
    await f.put('runtime/app-render.mjs', `export {identity,value,increment} from './internal-state.mjs';export {default as compatibility} from '../compat/state.cjs';`);
    await f.put('runtime/rsc-worker.mjs', `export const workerMarker='rsc-entry';`);
    await f.put('compat/state.cjs', 'module.exports={identity:{}};');
    await f.put('runtime/edge.mjs', `export const loadVm=()=>import('./edge-vm.cjs');`);
    await f.put('runtime/edge-vm.cjs', 'module.exports={version:1};');
    await f.put('runtime/http.mjs', `import data from './profiles.json' with {type:'json'};export const profile=data.profile;`);
    const profile = '{"profile":"balanced","marker":"asset-unchanged"}\n';
    await f.put('runtime/profiles.json', profile);
    await mkdir(path.join(f.stage, 'runtime/og'));
    await f.put('runtime/og/font.bin', Buffer.from([0, 1, 128, 255]));
    const result = await bundleRuntime(f.stage);
    const names = await readdir(path.join(f.stage, 'runtime'));
    assert.ok(!names.includes('internal-state.mjs'), 'original internal module must not remain as a second loadable instance');
    assert.ok(!names.includes('internal-lazy.mjs'), 'literal dynamic imports must target the emitted chunk');
    assert.equal(result.entryCount, runtimeEntryNames.length);
    for (const name of runtimeEntryNames) assert.ok(names.includes(`${name}.mjs`), `${name} public path remains`);
    assert.equal(await readFile(path.join(f.stage, 'runtime/profiles.json'), 'utf8'), profile);
    assert.deepEqual(await readFile(path.join(f.stage, 'runtime/og/font.bin')), Buffer.from([0, 1, 128, 255]));
    // The VM must still be loaded from its external CJS file. Mutating this test
    // artifact before the first load distinguishes external import from inlining.
    await f.put('runtime/edge-vm.cjs', 'module.exports={version:2};');
    const moved = path.join(f.directory, 'relocated-standalone');
    assert.equal(path.dirname(moved), f.directory);
    assert.equal(path.dirname(f.stage), f.directory);
    await rename(f.stage, moved);
    const load = name => import(pathToFileURL(path.join(moved, 'runtime', name)).href);
    const worker = await load('worker.mjs'), app = await load('app-render.mjs');
    assert.equal(globalThis[token], 1, 'shared state initializes once across entrypoints');
    assert.equal(worker.identity, app.identity);
    assert.equal(worker.compatibility, app.compatibility, 'compatibility CJS keeps one module identity');
    assert.equal(worker.increment(), 1);
    assert.equal(app.value, 1, 'ESM export remains live');
    assert.equal(globalThis[token + '-lazy'], undefined, 'dynamic import does not execute during entry loading');
    const deferred = await worker.load();
    assert.equal(globalThis[token + '-lazy'], true);
    assert.equal(deferred.identity, worker.identity);
    assert.equal((await import(worker.workerUrl().href)).workerMarker, 'rsc-entry');
    assert.equal((await load('http.mjs')).profile, 'balanced');
    assert.equal((await (await load('edge.mjs')).loadVm()).default.version, 2);
  } finally { delete globalThis[token]; delete globalThis[token + '-lazy']; await f.cleanup(); }
});

test('failed compilation leaves original stage modules and assets intact', async () => {
  const f = await fixture();
  try {
    await f.put('runtime/worker.mjs', 'export const syntax = ;');
    await f.put('runtime/profiles.json', '{"preserved":true}');
    const beforeNames = (await readdir(path.join(f.stage, 'runtime'))).sort();
    const before = new Map(await Promise.all(beforeNames.map(async name => [name, await readFile(path.join(f.stage, 'runtime', name))])));
    await assert.rejects(bundleRuntime(f.stage), /Unexpected|syntax|Expected/);
    assert.deepEqual((await readdir(path.join(f.stage, 'runtime'))).sort(), beforeNames);
    for (const [name, bytes] of before) assert.deepEqual(await readFile(path.join(f.stage, 'runtime', name)), bytes);
  } finally { await f.cleanup(); }
});

test('persistent runtime bundles reuse prepared code and invalidate on source changes or corruption', async () => {
  const f=await fixture();
  try {
    const reset=async(source='export const sentinel = true;\n')=>{
      for(const name of await readdir(path.join(f.stage,'runtime')))await rm(path.join(f.stage,'runtime',name));
      for(const name of runtimeEntryNames)await f.put(`runtime/${name}.mjs`,source);
    };
    const options={projectRoot:f.directory};
    assert.equal((await bundleRuntime(f.stage,options)).cached,false);
    await reset();assert.equal((await bundleRuntime(f.stage,options)).cached,true);
    await reset('export const sentinel = false;\n');assert.equal((await bundleRuntime(f.stage,options)).cached,false);
    const cache=path.join(f.directory,'.prnext-cache/runtime-bundle-v2');
    for(const name of await readdir(cache))await writeFile(path.join(cache,name),'corrupt');
    await reset();assert.equal((await bundleRuntime(f.stage,options)).cached,false);
    assert.match(await readFile(path.join(f.stage,'runtime/worker.mjs'),'utf8'),/true/);
  } finally {await f.cleanup();}
});
