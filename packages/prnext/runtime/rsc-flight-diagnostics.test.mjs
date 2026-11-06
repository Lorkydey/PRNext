import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';

test('real RSC streaming emits one bounded sanitized completion or cancellation per render',async()=>{
  const root=await mkdtemp(fileURLToPath(new URL('./.app-test-rsc-diagnostics-',import.meta.url))),directory=root+'/inspection';
  await writeFile(root+'/success.mjs',`import React from 'react';export const page={default:()=>React.createElement('p',null,'SYNTHETIC_PRIVATE_MODEL')};export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];`);
  await writeFile(root+'/pending.mjs',`import React from 'react';export const page={default:()=>new Promise(()=>{})};export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];`);
  await writeFile(root+'/missing.mjs',`import React from 'react';export const page={default:()=>{throw Object.assign(Error('missing'),{digest:'NEXT_HTTP_ERROR_FALLBACK;404'});}};export const segments=[{notFound:{default:()=>React.createElement('h1',null,'missing')},layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];`);
  const worker=new Worker(`
    const{parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      process.env.PRNEXT_INSPECT_DIR=workerData.directory;
      const{renderAppPage,closeAppRuntime}=await import(workerData.renderer);
      try{
        const base={distDir:workerData.root,manifest:{app:{clientModules:{}}},production:true,stream:true,url:'http://local/SYNTHETIC_PRIVATE_URL?secret=1',headers:{cookie:'owner=SYNTHETIC_PRIVATE_COOKIE'},route:{pattern:'/observed/[id]',cacheConfig:{maxDuration:2}}};
        const response=await renderAppPage({...base,modulePath:workerData.root+'/success.mjs'});for await(const ignored of response.body){}
        const missing=await renderAppPage({...base,modulePath:workerData.root+'/missing.mjs'});if(missing.status!==404)throw Error('fallback did not select404');for await(const ignored of missing.body){}
        const controller=new AbortController(),pending=renderAppPage({...base,modulePath:workerData.root+'/pending.mjs',signal:controller.signal});
        setTimeout(()=>controller.abort(Error('SYNTHETIC_PRIVATE_ABORT')),20);
        try{await pending;throw Error('pending render was not cancelled');}catch(error){if(!controller.signal.aborted)throw error;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }finally{await closeAppRuntime();}
      const diagnostics=require(workerData.diagnostics);await diagnostics.flush();parentPort.postMessage({ok:true});parentPort.close();
    })().catch(error=>{throw error;});
  `,{eval:true,env:{...process.env,NODE_ENV:'production'},workerData:{root,directory,renderer:new URL('./app-render.mjs',import.meta.url).href,diagnostics:fileURLToPath(new URL('../compat/diagnostics.cjs',import.meta.url))}});
  try{
    assert.deepEqual(await new Promise((resolve,reject)=>{let done=false;const timer=setTimeout(()=>reject(Error('RSC diagnostic worker deadline')),10000);worker.once('message',value=>{done=true;clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',()=>{clearTimeout(timer);if(!done)reject(Error('RSC diagnostics exited without proof'));});}),{ok:true});
    const raw=(await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.jsonl')).map(name=>readFile(directory+'/'+name,'utf8')))).join('');
    assert.equal(raw.includes('SYNTHETIC_PRIVATE_'),false);
    const all=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),events=all.filter(event=>event.type==='flight'&&event.phase==='rsc');
    assert.equal(events.length,3);assert.deepEqual(events.map(event=>event.outcome),['completed','completed','cancelled']);
    assert.ok(events.every(event=>event.route==='/observed/[id]'&&event.method==='GET'&&event.durationMs>=0));
    assert.equal(events[0].status,200);assert.ok(events[0].flightBytes>0&&events[0].flightChunks>0);
    const missing=events.find(event=>event.status===404),html=all.find(event=>event.type==='flight'&&event.phase==='ssr'&&event.status===404);
    assert.ok(missing&&html);assert.equal(missing.flightBytes,html.flightBytes,'discarded first-pass404 work cannot inflate response Flight bytes');
  }finally{await worker.terminate();await rm(root,{recursive:true,force:true});}
});
