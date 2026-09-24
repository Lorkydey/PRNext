import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {loadModule,loadedPagesModule} from './module-loader.mjs';
import {runApi} from './api.mjs';

async function directory(t){const root=await mkdtemp(path.join(tmpdir(),'rustyx-modules-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}

test('the Pages index retains resolved namespaces only, is opt-in and evicts metadata',async t=>{
 const root=await directory(t),first=path.join(root,'first.mjs');
 await writeFile(first,'export const value=1;');
 const ordinary=await loadModule(first);assert.equal(loadedPagesModule(first),undefined);
 assert.equal(await loadModule(first,true),ordinary);assert.equal(loadedPagesModule(first),ordinary);
 for(let i=0;i<257;i++){const file=path.join(root,i+'.mjs');await writeFile(file,`export const value=${i};`);await loadModule(file,true)}
 assert.equal(loadedPagesModule(first),undefined);assert.equal(loadedPagesModule(path.join(root,'0.mjs')),undefined);
 assert.equal(loadedPagesModule(path.join(root,'256.mjs')).value,256);
 assert.equal(await loadModule(first,true),ordinary); // Node owns the namespace's lifetime.
 const bad=path.join(root,'bad.mjs');await writeFile(bad,"throw new Error('bad module');");
 await assert.rejects(loadModule(bad,true),/bad module/);assert.equal(loadedPagesModule(bad),undefined);
});

test('CJS loading still observes changed exports and cache removal',async t=>{
 const root=await directory(t),file=path.join(root,'entry.cjs'),require=createRequire(import.meta.url);
 await writeFile(file,'module.exports={value:1};');assert.equal((await loadModule(file,true)).value,1);
 const resolved=require.resolve(file);
 require.cache[resolved].exports={value:2};assert.equal((await loadModule(file,true)).value,2);
 delete require.cache[resolved];assert.equal((await loadModule(file,true)).value,1);
 assert.equal(loadedPagesModule(file),undefined);
});

test('a warmed Pages module still respects cancellation and isolates every invocation',async t=>{
 const root=await directory(t),modulePath=path.join(root,'api.mjs');
 await writeFile(modulePath,"export let calls=0;export default(req,res)=>{calls++;res.json({value:req.query.value})};");
 const options={modulePath,url:'http://localhost/api?value=first',stream:true};
 const read=async result=>{let text='';for await(const chunk of result.body)text+=chunk;return JSON.parse(text)};
 assert.deepEqual(await read(await runApi(options)),{value:'first'});
 const abort=new AbortController();abort.abort(new Error('cancelled'));
 await assert.rejects(runApi({...options,signal:abort.signal}),/cancelled/);
 assert.equal(loadedPagesModule(modulePath).calls,1);
 assert.deepEqual(await read(await runApi({...options,url:'http://localhost/api?value=second'})),{value:'second'});
 assert.equal(loadedPagesModule(modulePath).calls,2);
});
