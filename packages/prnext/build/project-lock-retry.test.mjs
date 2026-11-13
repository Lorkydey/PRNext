import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const lockModule=new URL('../runtime/project-lock.mjs',import.meta.url).href;
for(const mode of ['transient','generation','persistent'])test(`dead-owner retirement handles Windows ${mode} rename denial safely`,async t=>{
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-lock-retry-')));
  t.after(async()=>{
    const target=await realpath(directory),base=await realpath(tmpdir());
    assert.equal(path.dirname(target),base);assert.ok(path.basename(target).startsWith('prnext-lock-retry-'));
    await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  });
  const shim=pathToFileURL(path.join(directory,'fs-shim.mjs')).href;
  const replacement='11111111-1111-4111-8111-111111111111';
  await writeFile(path.join(directory,'fs-shim.mjs'),`
    import * as fs from 'node:fs/promises';import path from 'node:path';import {hostname} from 'node:os';
    export * from 'node:fs/promises';export let attempts=0;
    export async function rename(from,to){
      if(path.basename(to).startsWith('.prnext-lock-retired-')){
        attempts++;
        if(${JSON.stringify(mode)}==='generation')await fs.writeFile(path.join(from,'owner.json'),JSON.stringify({pid:process.pid,host:hostname(),token:${JSON.stringify(replacement)}}));
        if(${JSON.stringify(mode)}!=='transient'||attempts<3)throw Object.assign(Error('Injected Windows sharing denial'),{code:'EPERM'});
      }return fs.rename(from,to);
    }
  `);
  const loader=pathToFileURL(path.join(directory,'loader.mjs')).href;
  const atomicShim=pathToFileURL(path.join(directory,'atomic-shim.mjs')).href;
  await writeFile(path.join(directory,'atomic-shim.mjs'),`import {createAtomicRenamer as create} from ${JSON.stringify(new URL('../runtime/fs.mjs',import.meta.url).href)};export function createAtomicRenamer(options){return create({...options,platform:'win32'});}`);
  await writeFile(path.join(directory,'loader.mjs'),`export function resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(lockModule)}){if(specifier==='node:fs/promises')return{url:${JSON.stringify(shim)},shortCircuit:true};if(specifier==='./fs.mjs')return{url:${JSON.stringify(atomicShim)},shortCircuit:true};}return next(specifier,context);}`);
  const code=`
    import assert from 'node:assert/strict';import path from 'node:path';
    import {mkdir,writeFile,readFile,readdir,access} from 'node:fs/promises';import {hostname} from 'node:os';
    import {register} from 'node:module';
    const root=${JSON.stringify(directory)},lock=path.join(root,'.prnext-build.lock'),old='22222222-2222-4222-8222-222222222222',dead=2000000000;
    assert.throws(()=>process.kill(dead,0),error=>error.code==='ESRCH');
    await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:dead,host:hostname(),token:old}));
    register(${JSON.stringify(loader)},import.meta.url);
    const {withBuildLock}=await import(${JSON.stringify(lockModule)}),shim=await import(${JSON.stringify(shim)});let calls=0;
    if(${JSON.stringify(mode)}==='transient'){
      assert.equal(await withBuildLock(root,()=>{calls++;return 42;}),42);assert.equal(calls,1);assert.equal(shim.attempts,3);
      await assert.rejects(access(lock),error=>error.code==='ENOENT');assert.ok(!(await readdir(root)).some(name=>name.startsWith('.prnext-lock-retired-')));
    }else{
      await assert.rejects(withBuildLock(root,()=>{calls++;}),error=>error.code===(${JSON.stringify(mode)}==='generation'?'PRNEXT_BUILD_LOCKED':'EPERM'));
      assert.equal(calls,0);assert.equal(JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8')).token,${JSON.stringify(mode)}==='generation'?${JSON.stringify(replacement)}:old);
      if(${JSON.stringify(mode)}==='generation')assert.equal(shim.attempts,1);else assert.ok(shim.attempts>1&&shim.attempts<100,'Retirement retries must remain bounded');
    }
  `;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:15000,maxBuffer:256*1024});
});
