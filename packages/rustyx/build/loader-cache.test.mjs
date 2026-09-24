import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {cachedLoader} from './loader-cache.mjs';
test('loader cache invalidates contents, context additions and missing files, and honors cacheable(false)',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rustyx-loader-cache-'));
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
