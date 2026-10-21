import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { withBuildLock } from './build-lock.mjs';
import { buildStatic } from './static-adapter.mjs';

async function fixture(t) { const root = await mkdtemp(path.join(tmpdir(), 'prnext-lock-')); t.after(() => rm(root, { recursive:true, force:true })); return root; }
test('an active project lock protects both builders and releases after failure', async t => {
  const root = await fixture(t);
  await withBuildLock(root, async () => {
    await assert.rejects(withBuildLock(root, () => assert.fail('overlapping build')), {code:'PRNEXT_BUILD_LOCKED'});
    await assert.rejects(buildStatic(root), {code:'PRNEXT_BUILD_LOCKED'});
  });
  await assert.rejects(withBuildLock(root, () => {throw new Error('build failed');}), /build failed/);
  assert.equal(await withBuildLock(root, () => 42), 42);
});
test('different project roots build independently', async t => {
  const a = await fixture(t), b = await fixture(t);
  await withBuildLock(a, () => withBuildLock(b, () => undefined));
});
test('a killed publisher is recovered once under competing processes', {timeout:30000}, async t => {
  const root = await fixture(t), module = new URL('./build-lock.mjs',import.meta.url).href;
  const child = spawn(process.execPath,['--input-type=module','-e',`import {withBuildLock} from ${JSON.stringify(module)}; await withBuildLock(${JSON.stringify(root)},async()=>{console.log('locked');await new Promise(()=>setInterval(()=>{},1000));});`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(() => {if(child.exitCode===null)child.kill();});
  // Keep the promise alive while the parent deliberately kills its owner.
  let ready=''; await new Promise((resolve,reject)=>{child.stdout.on('data',s=>{ready+=s;if(ready.includes('locked'))resolve();});child.once('exit',()=>reject(new Error('publisher exited before locking')));});
  await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)), 'build', root, '--adapter','static']),/already running/);
  const ended=once(child,'exit');child.kill('SIGKILL');await ended;
  let active=0, peak=0, wins=0;
  const results=await Promise.allSettled(Array.from({length:12},()=>withBuildLock(root,async()=>{peak=Math.max(peak,++active);wins++;await new Promise(r=>setTimeout(r,80));active--; })));
  assert.equal(peak,1);assert.equal(wins,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'PRNEXT_BUILD_LOCKED');
  assert.equal(await withBuildLock(root,()=>42),42);
});
test('a lock from another host is never reclaimed by age', async t => {
  const root=await fixture(t);await mkdir(path.join(root,'.prnext-build.lock'));
  await writeFile(path.join(root,'.prnext-build.lock/owner.json'),JSON.stringify({pid:1,host:hostname()+'-other',token:'00000000-0000-0000-0000-000000000000',createdAt:'1970-01-01'}));
  await assert.rejects(withBuildLock(root,()=>assert.fail()),{code:'PRNEXT_BUILD_LOCKED'});
  assert.ok(await readFile(path.join(root,'.prnext-build.lock/owner.json')));
});
