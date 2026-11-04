import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rmdir,symlink,utimes,readdir,realpath} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectCompilationStorage,pruneCompilationStorage,validateCompilationCache,withCompilationStorage,configureCompilationStorage} from './compilation-storage.mjs';
import {validateProjectConfig} from './config.mjs';
import {withBuildLock} from './build-lock.mjs';
const exec=promisify(execFile),key='a'.repeat(64),other='b'.repeat(64);
async function fixture(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-storage-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function put(root,name,bytes){const file=path.join(root,'.prnext-cache',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);return file;}

test('compilation disk budget has typed bounds and rejects ambiguous config',()=>{
  assert.deepEqual(validateProjectConfig({}).compilationCache,{maxDiskSize:256*1024*1024});
  assert.deepEqual(validateProjectConfig({compilationCache:{maxDiskSize:0}}).compilationCache,{maxDiskSize:0});
  for(const value of [null,true,false,[],new Date(),{maxDiskSize:null},{maxDiskSize:-1},{maxDiskSize:0.5},{maxDiskSize:Infinity},{maxDiskSize:4294967297},{maxDiskSize:'4'},{unknown:1},{[Symbol('size')]:4}])assert.throws(()=>validateCompilationCache(value),/compilationCache/);
});

test('one budget reclaims oldest compiler records, preserves durable state and dry-run bytes',async t=>{
  const root=await fixture(t),old=await put(root,`transforms-v1/${key}.json`,Buffer.alloc(80));
  await utimes(old,1,1);await put(root,`runtime-bundle-v2/${other}.json`,Buffer.alloc(60));
  const durable=await put(root,'data.sqlite3','generation=7; tags=keep; leases=keep');
  await put(root,'transforms-v1/unknown.json','application file');
  await put(root,'pages/files/active.html','active reader');
  const before=await inspectCompilationStorage(root);assert.equal(before.bytes,140);assert.equal(before.files,2);
  const preview=await pruneCompilationStorage(root,{maxDiskSize:60,dryRun:true});
  assert.equal(preview.removedBytes,80);assert.equal(preview.afterBytes,60);assert.equal((await readFile(old)).length,80);
  assert.equal(await readFile(durable,'utf8'),'generation=7; tags=keep; leases=keep');
  const actual=await pruneCompilationStorage(root,{maxDiskSize:60});assert.equal(actual.removedBytes,preview.removedBytes);
  assert.equal((await inspectCompilationStorage(root)).bytes,60);assert.equal(await readFile(durable,'utf8'),'generation=7; tags=keep; leases=keep');
  assert.equal(await readFile(path.join(root,'.prnext-cache/pages/files/active.html'),'utf8'),'active reader');
});

test('global graph eviction keeps shared blobs and graph metadata together',async t=>{
  const root=await fixture(t);await put(root,`compilation-graphs-v2/${key}.graph`,Buffer.alloc(10));
  await put(root,`compilation-graphs-v2/${other}.graph`,Buffer.alloc(10));await put(root,`compilation-graphs-v2/${key}.blob`,Buffer.alloc(40));
  await pruneCompilationStorage(root,{maxDiskSize:30});
  assert.deepEqual(await readdir(path.join(root,'.prnext-cache/compilation-graphs-v2')),[]);
});

test('active worker leases and development protect caches; dead leases are retryable',async t=>{
  const root=await fixture(t);await put(root,'node-compile-v1/v24/file',Buffer.alloc(80));
  const lease=await put(root,`node-compile-v1/.lease-${process.pid}-${randomUUID()}.json`,JSON.stringify({host:hostname(),pid:process.pid}));
  const pinned=await pruneCompilationStorage(root,{maxDiskSize:0});assert.equal(pinned.removedFiles,0);assert.equal(pinned.overBudget,true);
  await rm(lease);const dead=await put(root,`node-compile-v1/.lease-2147483647-${randomUUID()}.json`,JSON.stringify({host:hostname(),pid:2147483647}));
  await mkdir(path.join(root,'.prnext-dev.lock'));
  assert.equal((await pruneCompilationStorage(root,{maxDiskSize:0})).deferred,true);
  await rmdir(path.join(root,'.prnext-dev.lock'));assert.equal((await pruneCompilationStorage(root,{maxDiskSize:0})).afterBytes,0);
  await assert.rejects(readFile(dead),{code:'ENOENT'});
});

test('cache maintenance refuses concurrent publishers across processes',async t=>{
  const root=await fixture(t),url=new URL('./compilation-storage.mjs',import.meta.url).href;
  await withBuildLock(root,async()=>{
    await assert.rejects(exec(process.execPath,['--input-type=module','-e',`import {pruneCompilationStorage} from ${JSON.stringify(url)};await pruneCompilationStorage(${JSON.stringify(root)});`],{windowsHide:true}),/already running/);
  });
});

test('budget persists after failed builds and removes only stale owned temporary records',async t=>{
  const root=await fixture(t),stale=await put(root,`loaders-v2/${key}.json.${randomUUID()}.tmp`,'stale');
  const fresh=await put(root,`loaders-v2/${other}.json.${randomUUID()}.tmp`,'fresh');await utimes(stale,1,1);
  await assert.rejects(withBuildLock(root,()=>withCompilationStorage(root,async()=>{configureCompilationStorage({maxDiskSize:0});throw Error('original build error');})),/original build error/);
  const report=await inspectCompilationStorage(root);assert.equal(report.maxDiskSize,0);assert.equal(report.bytes,5);
  await assert.rejects(readFile(stale),{code:'ENOENT'});assert.equal(await readFile(fresh,'utf8'),'fresh');
  await withBuildLock(root,()=>withCompilationStorage(root,async()=>({deferredBuild:true})));
  assert.equal((await inspectCompilationStorage(root)).maxDiskSize,0,'early lazy builds preserve the last configured budget');
});

test('global cache opt-out preserves stored policy, records and file identities',async t=>{
  const root=await fixture(t),file=await put(root,`transforms-v1/${key}.json`,'cached');
  await put(root,'compilation-policy.json',JSON.stringify({maxDiskSize:0}));
  const {stat}=await import('node:fs/promises'),policy=path.join(root,'.prnext-cache/compilation-policy.json');
  const before=await stat(policy),previous=process.env.PRNEXT_BUILD_CACHE;process.env.PRNEXT_BUILD_CACHE='0';
  try{const value={built:true};assert.equal(await withBuildLock(root,()=>withCompilationStorage(root,async()=>value)),value);assert.equal(value.compilationStorage,undefined);}
  finally{if(previous===undefined)delete process.env.PRNEXT_BUILD_CACHE;else process.env.PRNEXT_BUILD_CACHE=previous;}
  const after=await stat(policy);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(await readFile(file,'utf8'),'cached');
});

test('compiler maintenance never follows a namespace symlink or project cache junction',async t=>{
  const root=await fixture(t),outside=await fixture(t),sentinel=path.join(outside,key+'.json');await writeFile(sentinel,'keep');
  await mkdir(path.join(root,'.prnext-cache'));await symlink(outside,path.join(root,'.prnext-cache/transforms-v1'),process.platform==='win32'?'junction':'dir');
  assert.equal((await pruneCompilationStorage(root,{maxDiskSize:0})).removedFiles,0);assert.equal(await readFile(sentinel,'utf8'),'keep');
  const linked=await fixture(t);await symlink(outside,path.join(linked,'.prnext-cache'),process.platform==='win32'?'junction':'dir');
  assert.equal((await pruneCompilationStorage(linked,{maxDiskSize:0})).bytes,0);assert.equal(await readFile(sentinel,'utf8'),'keep');
});

test('cache CLI inspects without executing config, previews and validates option combinations',async t=>{
  const root=await fixture(t),cli=new URL('../cli.mjs',import.meta.url);
  await writeFile(path.join(root,'prnext.config.mjs'),"throw Error('config must not execute')");await put(root,`transforms-v1/${key}.json`,'cache');
  const invoke=async args=>JSON.parse((await exec(process.execPath,[fileURLToPath(cli),'cache',root,...args,'--json'],{windowsHide:true})).stdout);
  assert.equal((await invoke([])).bytes,5);assert.equal((await invoke(['--prune','--dry-run','--max-bytes','0'])).removedBytes,5);
  assert.equal((await invoke([])).bytes,5);assert.equal((await invoke(['--prune','--max-bytes','0'])).afterBytes,0);
  await assert.rejects(invoke(['--max-bytes','0']),/require --prune/);
});

for(const phase of ['namespace-open','base-open','nested-open','before-unlink']){
  test(`cache retention preserves outside sentinels when a directory changes at ${phase}`,async t=>{
    const fixtureRoot=await fixture(t),root=path.join(fixtureRoot,'app'),outside=path.join(fixtureRoot,'outside');
    const nested=phase==='nested-open',base=path.join(root,'.prnext-cache');
    const namespace=path.join(base,nested?'node-compile-v1':'transforms-v1');
    const target=nested?path.join(namespace,'node-version'):namespace;
    const outsideTarget=phase==='base-open'?path.join(outside,'transforms-v1'):outside;
    await mkdir(target,{recursive:true});await mkdir(outsideTarget,{recursive:true});
    const filename=key+'.json';await writeFile(path.join(target,filename),'own cache');
    await writeFile(path.join(outsideTarget,filename),'outside sentinel');
    const moduleUrl=new URL('./compilation-storage.mjs',import.meta.url).href;
    const swapPath=phase==='base-open'?base:target;
    const hookFile=path.join(fixtureRoot,'filesystem.mjs');
    await writeFile(hookFile,`export * from 'node:fs/promises';import * as fs from 'node:fs/promises';
      let swapped=false,reads=0;
      async function swap(){if(swapped)return;swapped=true;await fs.rename(${JSON.stringify(swapPath)},${JSON.stringify(swapPath+'-parked')});await fs.symlink(${JSON.stringify(outside)},${JSON.stringify(swapPath)},process.platform==='win32'?'junction':'dir');}
      export async function opendir(directory,...args){if(${JSON.stringify(phase)}!=='before-unlink'&&directory===${JSON.stringify(target)})await swap();return fs.opendir(directory,...args);}
      export async function lstat(file,...args){const info=await fs.lstat(file,...args);if(${JSON.stringify(phase)}==='before-unlink'&&file===${JSON.stringify(path.join(target,filename))}&&++reads===2)await swap();return info;}`);
    const code=`import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,context,next){if(specifier==='node:fs/promises'&&context.parentURL===${JSON.stringify(moduleUrl)})return{url:${JSON.stringify(pathToFileURL(hookFile).href)},shortCircuit:true};return next(specifier,context);}});
      const {pruneCompilationStorage}=await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(await pruneCompilationStorage(${JSON.stringify(root)},{maxDiskSize:0})));`;
    const report=JSON.parse((await exec(process.execPath,['--input-type=module','-e',code],{windowsHide:true})).stdout);
    assert.equal(report.removedFiles,0);
    assert.equal(report.scanComplete,false);
    assert.equal(report.deferred,true);
    assert.equal(await readFile(path.join(outsideTarget,filename),'utf8'),'outside sentinel');
    const parkedTarget=phase==='base-open'?path.join(base+'-parked','transforms-v1'):target+'-parked';
    assert.equal(await readFile(path.join(parkedTarget,filename),'utf8'),'own cache');
  });
}

for(const dryRun of [false,true]){
  test(`a worker lease appearing after the inventory protects its namespace${dryRun?' in a dry run':''}`,async t=>{
    const fixtureRoot=await fixture(t),root=path.join(fixtureRoot,'app');
    const protectedFile=await put(root,`transforms-v1/${key}.json`,'pinned cache');
    const evictable=await put(root,`runtime-bundle-v2/${other}.json`,'evictable cache');
    const directory=path.dirname(protectedFile),hookFile=path.join(fixtureRoot,'lease-filesystem.mjs');
    const moduleUrl=new URL('./compilation-storage.mjs',import.meta.url).href;
    await writeFile(hookFile,`export * from 'node:fs/promises';import * as fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';import path from 'node:path';
      let reads=0;
      export async function opendir(directory,...args){
        if(directory===${JSON.stringify(directory)}&&++reads===3){
          await fs.writeFile(path.join(directory,'.lease-'+process.pid+'-'+randomUUID()+'.json'),JSON.stringify({pid:process.pid,host:${JSON.stringify(hostname())}}),{flag:'wx'});
        }
        return fs.opendir(directory,...args);
      }`);
    const code=`import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,context,next){if(specifier==='node:fs/promises'&&context.parentURL===${JSON.stringify(moduleUrl)})return{url:${JSON.stringify(pathToFileURL(hookFile).href)},shortCircuit:true};return next(specifier,context);}});
      const {pruneCompilationStorage}=await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify(await pruneCompilationStorage(${JSON.stringify(root)},{maxDiskSize:0,dryRun:${dryRun}})));`;
    const report=JSON.parse((await exec(process.execPath,['--input-type=module','-e',code],{windowsHide:true})).stdout);
    assert.equal(report.scanComplete,true);assert.equal(report.deferred,false);
    assert.equal(report.categories.find(category=>category.name==='transforms-v1').pinned,true);
    assert.equal(report.removedFiles,1,'only the other, inactive namespace is eligible');
    assert.equal(report.afterBytes,Buffer.byteLength('pinned cache'));
    assert.equal(report.overBudget,true);
    assert.equal(await readFile(protectedFile,'utf8'),'pinned cache');
    if(dryRun)assert.equal(await readFile(evictable,'utf8'),'evictable cache');
    else await assert.rejects(readFile(evictable),{code:'ENOENT'});
  });
}
