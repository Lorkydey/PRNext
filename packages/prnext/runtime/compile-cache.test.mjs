import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,truncate,utimes,stat,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pruneCompilerCache} from './compile-cache-retention.mjs';
import {pruneCompilationStorage} from '../build/compilation-storage.mjs';
import {withBuildLock} from './project-lock.mjs';
async function fixture(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-node-cache-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function worker(t,root,{managed=true,cache=path.join(root,'.prnext-cache/node-compile-v1')}={}){
  await mkdir(cache,{recursive:true});
  const module=new URL('./compile-cache.mjs',import.meta.url).href;
  const env={...process.env,NODE_COMPILE_CACHE:cache};delete env.NODE_DISABLE_COMPILE_CACHE;delete env.PRNEXT_MANAGED_COMPILE_CACHE_ROOT;
  if(managed)env.PRNEXT_MANAGED_COMPILE_CACHE_ROOT=root;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {scheduleCompileCacheFlush} from ${JSON.stringify(module)};scheduleCompileCacheFlush();console.log('ready');const timer=setInterval(()=>{},1000);process.stdin.resume();process.stdin.on('end',()=>{clearInterval(timer);});`],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',chunk=>{out+=chunk;if(out.includes('ready'))resolve();});child.once('exit',()=>reject(Error('worker exited before ready')));});
  return {child,cache,async close(){const exited=once(child,'exit');child.stdin.end();await exited;}};
}

test('managed workers pin global purges and release their unique lease on exit',async t=>{
  const root=await fixture(t),process=await worker(t,root);
  const leases=(await readdir(process.cache)).filter(name=>name.startsWith('.lease-'));assert.equal(leases.length,1);
  const owner=JSON.parse(await readFile(path.join(process.cache,leases[0]),'utf8'));assert.equal(owner.pid,process.child.pid);
  await writeFile(path.join(process.cache,'probe'),'disposable');
  const live=await pruneCompilationStorage(root,{maxDiskSize:0});assert.equal(live.categories.find(category=>category.name==='node-compile-v1').pinned,true);assert.equal(await readFile(path.join(process.cache,'probe'),'utf8'),'disposable');
  await process.close();assert.equal((await readdir(process.cache)).filter(name=>name.startsWith('.lease-')).length,0);
  assert.equal((await pruneCompilationStorage(root,{maxDiskSize:0})).afterBytes,0);
});

test('post-flush maintenance trims oversized Node caches without touching external caches',async t=>{
  const root=await fixture(t),directory=path.join(root,'.prnext-cache/node-compile-v1');await mkdir(directory,{recursive:true});
  const file=path.join(directory,'oversized');await writeFile(file,'');await truncate(file,129*1024*1024);
  const managed=await worker(t,root);const until=Date.now()+10000;
  while(Date.now()<until){try{await stat(file);}catch(error){if(error.code==='ENOENT')break;throw error;}await new Promise(resolve=>setTimeout(resolve,40));}
  await assert.rejects(readFile(file),{code:'ENOENT'});await managed.close();
  const outside=await fixture(t),external=path.join(outside,'preserved');await writeFile(external,'');await truncate(external,129*1024*1024);
  const unmanaged=await worker(t,root,{managed:false,cache:outside});await new Promise(resolve=>setTimeout(resolve,1200));await unmanaged.close();
  assert.equal((await stat(external)).size,129*1024*1024);assert.equal((await readdir(outside)).some(name=>name.startsWith('.lease-')),false);
});

test('an oversized newest entry does not discard smaller reusable compiler files',async t=>{
  const root=await fixture(t),old=path.join(root,'small'),large=path.join(root,'large');await writeFile(old,'ok');await utimes(old,1,1);await writeFile(large,'too large');
  await pruneCompilerCache(root,{maxBytes:3,maxFiles:2});assert.equal(await readFile(old,'utf8'),'ok');await assert.rejects(readFile(large),{code:'ENOENT'});
});

test('a killed worker leaves a lease that dead-owner maintenance can safely reclaim',async t=>{
  const root=await fixture(t),running=await worker(t,root);
  const exited=once(running.child,'exit');running.child.kill('SIGKILL');await exited;
  assert.equal((await readdir(running.cache)).filter(name=>name.startsWith('.lease-')).length,1);
  await pruneCompilationStorage(root,{maxDiskSize:0});
  assert.equal((await readdir(running.cache)).filter(name=>name.startsWith('.lease-')).length,0);
});

test('Node cache maintenance skips a busy collector and never follows a namespace junction',async t=>{
  const root=await fixture(t),outside=await fixture(t),file=path.join(root,'cache');await writeFile(file,'keep');
  await withBuildLock(root,()=>pruneCompilerCache(root,{maxBytes:0}));assert.equal(await readFile(file,'utf8'),'keep');
  await writeFile(path.join(outside,'outside'),'preserved');const link=path.join(root,'linked');await symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await pruneCompilerCache(link,{maxBytes:0});assert.equal(await readFile(path.join(outside,'outside'),'utf8'),'preserved');assert.deepEqual(await readdir(outside),['outside']);
});
