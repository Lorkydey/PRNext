import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,readdir,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {cachedLoader} from './loader-cache.mjs';
test('loader cache invalidates contents, context additions and missing files, and honors cacheable(false)',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-loader-cache-'));
  try{
    const file=path.join(root,'input.txt'),dependency=path.join(root,'dep.txt'),directory=path.join(root,'context'),missing=path.join(root,'missing.txt');
    await mkdir(directory);await writeFile(file,'input');await writeFile(dependency,'first');
    let runs=0;
    const options={root,file,loaders:[],target:'node',dev:false};
    const run=async()=>({source:String(++runs),assets:[],warnings:[],cacheable:true,dependencies:[dependency],contexts:[directory],missing:[missing]});
    assert.equal((await cachedLoader(options,run)).source,'1');assert.equal((await cachedLoader(options,run)).source,'1');
    await writeFile(dependency,'other');assert.equal((await cachedLoader(options,run)).source,'2');
    await writeFile(path.join(directory,'added'),'new');assert.equal((await cachedLoader(options,run)).source,'3');
    await writeFile(missing,'exists');assert.equal((await cachedLoader(options,run)).source,'4');
    const uncached={...options,target:'browser'};const volatile=async()=>({...await run(),cacheable:false});
    assert.equal((await cachedLoader(uncached,volatile)).source,'5');assert.equal((await cachedLoader(uncached,volatile)).source,'6');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('loader cache corruption, unavailable storage and invalid dependency snapshots preserve successful outputs',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-loader-optional-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'input.txt');await writeFile(file,'input');
  const options={root,file,loaders:[],target:'node',dev:false};let runs=0;
  const run=async()=>({source:String(++runs),assets:[],warnings:[],dependencies:[],contexts:[],missing:[]});
  await cachedLoader(options,run);
  const directory=path.join(root,'.prnext-cache','loaders-v2'),entry=path.join(directory,(await readdir(directory)).find(name=>name.endsWith('.json')));
  const envelope=JSON.parse(await readFile(entry,'utf8'));
  for(const payload of [{format:2},{format:2,snapshot:{files:[],contexts:[]},result:{source:'poisoned',assets:[{name:'../escape',data:''}]}},{format:2,result:await run(),snapshot:{files:[['relative','missing']],contexts:[]}}]){
    const body=JSON.stringify(payload);await writeFile(entry,JSON.stringify({...envelope,payload:body,checksum:createHash('sha256').update(body).digest('hex')}));
    const expected=runs+1;assert.equal((await cachedLoader(options,run)).source,String(expected));
  }
  await writeFile(entry,'{broken');assert.equal((await cachedLoader(options,run)).source,String(runs));
  await rm(path.join(root,'.prnext-cache'),{recursive:true});await writeFile(path.join(root,'.prnext-cache'),'blocked');
  const result=await run();assert.equal(await cachedLoader(options,async()=>result),result,'cache I/O must not replace a successful loader result');
  await rm(path.join(root,'.prnext-cache'));
  const unstable={...await run(),dependencies:[root]};assert.equal(await cachedLoader(options,async()=>unstable),unstable,'unhashable dependency is an optional snapshot failure');
  const missingArrays={source:'valid loader result without dependency metadata'};assert.equal(await cachedLoader(options,async()=>missingArrays),missingArrays);
  const failure=new Error('actual loader failure');await assert.rejects(cachedLoader(options,async()=>{throw failure;}),error=>error===failure);
});

test('loader cache opt-out performs no cache I/O and concurrent publications remain valid',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-loader-concurrent-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'input.txt');await writeFile(file,'input');
  const options={root,file,loaders:[],target:'node',dev:false},result={source:'result',assets:[],warnings:[],dependencies:[],contexts:[],missing:[]};
  const previous=process.env.PRNEXT_BUILD_CACHE;process.env.PRNEXT_BUILD_CACHE='0';
  try{assert.equal(await cachedLoader(options,async()=>result),result);assert.deepEqual(await readdir(root),['input.txt']);}
  finally{if(previous===undefined)delete process.env.PRNEXT_BUILD_CACHE;else process.env.PRNEXT_BUILD_CACHE=previous;}
  await Promise.all(Array.from({length:12},()=>cachedLoader(options,async()=>result)));
  assert.equal((await cachedLoader(options,async()=>{throw new Error('should reuse publication');})).source,'result');
  const directory=path.join(root,'.prnext-cache','loaders-v2');assert.equal((await readdir(directory)).filter(name=>name.endsWith('.tmp')).length,0);
  await writeFile(path.join(directory,'keep.json'),'unrelated');
  await cachedLoader({...options,target:'browser'},async()=>result);assert.equal(await readFile(path.join(directory,'keep.json'),'utf8'),'unrelated');
});

test('cyclic loader context dependencies disable caching instead of failing the loader',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-loader-cycle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'input.txt'),context=path.join(root,'context');await writeFile(file,'input');await mkdir(context);
  await symlink(context,path.join(context,'cycle'),process.platform==='win32'?'junction':'dir');
  const result={source:'result',assets:[],warnings:[],dependencies:[],contexts:[context],missing:[]};
  assert.equal(await cachedLoader({root,file,loaders:[],target:'node',dev:false},async()=>result),result);
});
