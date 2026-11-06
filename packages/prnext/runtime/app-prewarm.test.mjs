import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { prewarmAppRenderer, preloadAppRoutes, closeAppRuntime, renderAppPage } from './app-render.mjs';

const roots=[];
after(async()=>{await closeAppRuntime();await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
const options=()=>({timeoutMs:10000,maxRssMb:2048});

test('synthetic framework warm-up consumes bounded Flight and HTML without visiting supplied application files',async()=>{
  const root=await mkdtemp(fileURLToPath(new URL('./.app-test-prewarm-',import.meta.url)));roots.push(root);
  const marker=path.join(root,'visited');const application=path.join(root,'page.mjs');
  await writeFile(application,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'visited');throw Error('application must not be imported by framework warm-up');`);
  const result=await prewarmAppRenderer({...options(),files:[application],modulePath:application});
  assert.equal(result.synthetic,true);assert.ok(result.flightBytes>0&&result.flightBytes<=65536);assert.ok(result.htmlBytes>result.flightBytes&&result.htmlBytes<=65536);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  // The warmed framework cannot supply its synthetic tree for a later private
  // render. Two ordinary requests still execute their own application model.
  await writeFile(application,`import React from 'react';import{cookies}from${JSON.stringify(new URL('../compat/headers.cjs',import.meta.url).href)};export const page={default:async()=>React.createElement('p',null,(await cookies()).get('owner')?.value)};export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];`);
  for(const owner of['one','two']){
    const response=await renderAppPage({modulePath:application,distDir:root,manifest:{app:{clientModules:{}}},production:true,url:'http://localhost/private',headers:{cookie:'owner='+owner}});
    assert.match(response.body.toString(),new RegExp('<p>'+owner+'</p>'));assert.equal(response.body.includes('PRNext framework'),false);
  }
});

test('prewarm cancellation and exhausted budgets cannot report synthetic readiness or poison the next warm-up',async()=>{
  const reason=new Error('stop framework preparation');
  await assert.rejects(prewarmAppRenderer({...options(),signal:AbortSignal.abort(reason)}),error=>error===reason);
  await assert.rejects(prewarmAppRenderer({...options(),maxRssMb:1}),/budget exhausted/);
  const controller=new AbortController();queueMicrotask(()=>controller.abort(reason));
  await assert.rejects(prewarmAppRenderer({...options(),signal:controller.signal}),error=>error===reason||/cancelled/.test(error.message));
  const ready=await prewarmAppRenderer(options());assert.equal(ready.synthetic,true);
  for(const invalid of[{timeoutMs:0,maxRssMb:2048},{timeoutMs:NaN,maxRssMb:2048},{timeoutMs:100,maxRssMb:Infinity}])await assert.rejects(prewarmAppRenderer(invalid),TypeError);
});

test('failed preload message delivery cleans listeners and deadlines without retiring the healthy worker',async()=>{
  const original=Worker.prototype.postMessage;let worker,failCancellation=false;
  Worker.prototype.postMessage=function(value,...rest){
    if(value.type==='preload')worker=this;
    if(value.type==='preload-cancel'&&failCancellation)throw new Error('simulated closed preload transport');
    return original.call(this,value,...rest);
  };
  try{
    await preloadAppRoutes([],options());assert.ok(worker.threadId>0);
    const threadId=worker.threadId,counts=()=>['message','error','exit'].map(event=>worker.listenerCount(event)),before=counts();
    await assert.rejects(preloadAppRoutes([],{...options(),timeoutMs:50,uncloneable(){}}),error=>error.name==='DataCloneError');
    assert.deepEqual(counts(),before,'synchronous start failure must remove its installed listeners');
    const controller=new AbortController(),reason=new Error('cancel even if transport has closed');failCancellation=true;
    const cancelled=preloadAppRoutes([],{...options(),timeoutMs:50,signal:controller.signal});
    controller.abort(reason);await assert.rejects(cancelled,error=>error===reason);
    assert.deepEqual(counts(),before,'failed cancel delivery must still clean local state');
    await delay(100);
    assert.equal(worker.threadId,threadId,'cleared preload deadlines cannot later terminate the healthy isolate');
    failCancellation=false;assert.equal((await prewarmAppRenderer(options())).synthetic,true);
  }finally{Worker.prototype.postMessage=original;}
});
