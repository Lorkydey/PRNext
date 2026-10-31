import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';

test('the real RSC cache codec preserves owned bytes for small and multi-chunk values and runs its producer once',async()=>{
  const worker=new Worker(`
    const{parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const{codecSymbol}=await import(workerData.cache);
      await import(workerData.codec);
      const codec=globalThis[codecSymbol],context={distDir:process.cwd(),clientModules:{},actions:{}};
      let calls=0;
      const results=[];
      for(const length of [0,16,128*1024]){
        const original=new Uint8Array(length).fill(42);
        const encoded=await codec.arguments([],context);
        const bytes=await codec.render(()=>{calls++;return{value:original,text:'cache value',date:new Date(0)};},encoded,context);
        // React's byte stream may already have transferred/detached a binary
        // value. Mutate only storage the producer still owns after rendering.
        if(original.byteLength)original.fill(255);
        const decoded=await codec.decode(bytes,encoded,context);
        results.push({length:decoded.value.byteLength,every:decoded.value.every(value=>value===42),text:decoded.text,date:decoded.date.getTime(),bytes:bytes.length});
      }
      parentPort.postMessage({calls,results});
      parentPort.close();
    })().catch(error=>{throw error;});
  `,{eval:true,execArgv:['--conditions=react-server'],workerData:{
    cache:new URL('../compat/use-cache.cjs',import.meta.url).href,
    codec:new URL('./cache-components-rsc.mjs',import.meta.url).href,
  }});
  try{
    const result=await new Promise((resolve,reject)=>{
      let completed=false;
      const timer=setTimeout(()=>reject(new Error('RSC cache codec worker did not complete')),10000);
      const clean=()=>clearTimeout(timer);
      worker.once('message',value=>{completed=true;clean();resolve(value);});worker.once('error',error=>{clean();reject(error);});
      worker.once('exit',()=>{clean();if(!completed)reject(new Error('RSC cache codec worker exited before returning its result'));});
    });
    assert.equal(result.calls,3);
    assert.deepEqual(result.results.map(({length,every,text,date})=>({length,every,text,date})),[0,16,128*1024].map(length=>({length,every:true,text:'cache value',date:0})));
    assert.ok(result.results.every(value=>value.bytes>0));
  }finally{await worker.terminate();}
});
