import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';

test('the real RSC cache codec preserves owned bytes for small and multi-chunk values and runs its producer once',async()=>{
  const worker=new Worker(`
    const{parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const{codecSymbol}=await import(workerData.cache);
      const codecModule=await import(workerData.codec);
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

async function inRsc(body){
  const worker=new Worker(`
    const{parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const assert=require('node:assert/strict');
      const cache=await import(workerData.cache),request=await import(workerData.request);
      const codecModule=await import(workerData.codec);
      const codec=globalThis[cache.codecSymbol],context={distDir:process.cwd(),clientModules:{},actions:{}};
      ${body}
      parentPort.postMessage({ok:true});parentPort.close();
    })().catch(error=>{throw error;});
  `,{eval:true,execArgv:['--conditions=react-server'],env:{...process.env,NODE_ENV:'production'},workerData:{
    cache:new URL('../compat/use-cache.cjs',import.meta.url).href,
    request:new URL('../compat/headers.cjs',import.meta.url).href,
    codec:new URL('./cache-components-rsc.mjs',import.meta.url).href,
  }});
  try{
    assert.deepEqual(await new Promise((resolve,reject)=>{let done=false;const timer=setTimeout(()=>reject(Error('RSC result test deadline')),10000);worker.once('message',value=>{done=true;clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.once('exit',()=>{clearTimeout(timer);if(!done)reject(Error('RSC result worker exited before proof'));});}),{ok:true});
  }finally{await worker.terminate();}
}

test('primitive cache misses enter React once and hits preserve values, lifetime, tags and request isolation',()=>inRsc(`
  const React=await import('react'),{currentCacheScope}=await import(${JSON.stringify(new URL('../compat/data-cache.cjs',import.meta.url).href)});
  let produced=0,memoCalls=0;
  const memo=React.cache(()=>{memoCalls++;return 'memo';});
  const values=[null,undefined,false,true,0,-0,NaN,Infinity,-Infinity,2n**128n,'\\ufeff🎉','\\ud800x','x'.repeat(128*1024)];
  for(const owner of ['one','two'])await request.runRequestContext({...context,url:'http://local/',headers:{cookie:'owner='+owner}},async()=>{
    for(let index=0;index<values.length;index++){
      const before=memoCalls;
      const producer=()=>{produced++;assert.equal(memo(),'memo');assert.equal(memo(),'memo');cache.cacheTag('value-'+index);cache.cacheLife({revalidate:5,expire:20});assert.equal(currentCacheScope().life.revalidate,5);return values[index];};
      const a=await cache.invokeCache('primitive-'+index,'private',[],[],producer);
      const b=await cache.invokeCache('primitive-'+index,'private',[],[],()=>{throw Error('cache hit executed producer');});
      assert.ok(Object.is(a,values[index]));assert.ok(Object.is(b,values[index]));assert.equal(memoCalls-before,1);
      const entry=[...request.currentRequest().privateCache.values()].at(-1);const bytes=await entry,offset=4+bytes.readUInt32BE(0),metadata=JSON.parse(bytes.subarray(4,offset));
      assert.ok(metadata.tags.includes('value-'+index));assert.equal(metadata.revalidate,5);assert.equal(metadata.expire,20);
    }
  });
  assert.equal(produced,values.length*2);assert.equal(memoCalls,produced);
  await request.runRequestContext({...context,url:'http://local/',headers:{}},async()=>{
    const ctx=request.currentRequest(),args=await codec.arguments([[],[]],ctx),hash=require('node:crypto').createHash;
    const oldKey=hash('sha256').update('versioned').update('private').update(':flight:').update(args.key).digest('hex');
    ctx.privateCache=new Map([[oldKey,Promise.resolve(Buffer.from('must never decode this legacy entry'))]]);
    assert.equal(await cache.invokeCache('versioned','private',[],[],()=> 'new namespace'),'new namespace');
    assert.equal(ctx.privateCache.size,2);
  });
`));

test('object fallback keeps getters, temporary references and mutation isolation; errors and aborts never expose a sentinel',()=>inRsc(`
  const {renderToReadableStream}=await import('react-server-dom-webpack/server.node');
  async function reference(callback,encoded){let execution,failure;const model={then(resolve,reject){(execution||=Promise.resolve().then(callback)).then(resolve,reject);}};const stream=renderToReadableStream(model,{}, {temporaryReferences:encoded.serverTemporaryReferences,onError(error){failure=error;return 'reference';}}),chunks=[];let size=0;for await(const chunk of stream){size+=chunk.byteLength;if(size>16*1024*1024)throw Error('Cached React result exceeds the 16 MiB rendering limit');chunks.push(chunk);}if(failure)throw failure;return Buffer.concat(chunks);}
  let actualReads=0,referenceReads=0;
  const make=increment=>({get value(){increment();return 'getter';},get then(){increment();return undefined;}});
  const encoded=await codec.arguments([],context);
  await reference(()=>make(()=>referenceReads++),encoded);
  const bytes=await codec.render(()=>make(()=>actualReads++),encoded,context),decoded=await codec.decode(bytes,encoded,context);
  assert.equal(decoded.value,'getter');assert.equal(actualReads,referenceReads,'fallback must not add getter observations');
  const{createFromReadableStream}=await import('react-server-dom-webpack/client.edge');
  for(const text of['\\ud800x','\\ud800'+'x'.repeat(128*1024),'🎉'.repeat(32768),'\\ufeffhello','x\\ufeffy','\\ufeff'+'x'.repeat(1024),'\\ufeff'+'x'.repeat(128*1024),'x'.repeat(32768)+'\\ufeff'+'🎉'.repeat(16384)]){
    const raw=await reference(()=>text,encoded),legacy=await createFromReadableStream(new ReadableStream({start(controller){controller.enqueue(raw);controller.close();}}),{serverConsumerManifest:codecModule.flightConsumer(context)});
    const actual=await codec.decode(await codec.render(()=>text,encoded,context),encoded,context);
    assert.ok(actual===legacy,'primitive result must match official Flight text semantics at length'+text.length);
  }
  const near='x'.repeat(16*1024*1024-32*1024),nearRaw=await reference(()=>near,encoded),legacyNear=await createFromReadableStream(new ReadableStream({start(controller){controller.enqueue(nearRaw);controller.close();}}),{serverConsumerManifest:codecModule.flightConsumer(context)});
  assert.equal(await codec.decode(await codec.render(()=>near,encoded,context),encoded,context),legacyNear);
  const oversized='x'.repeat(16*1024*1024+1);await assert.rejects(reference(()=>oversized,encoded),/16 MiB/);await assert.rejects(codec.render(()=>oversized,encoded,context),/16 MiB/);
  let thenReads=0,thenCalls=0;
  const thenable={get then(){thenReads++;return resolve=>{thenCalls++;resolve('settled');};}};
  assert.equal(await codec.decode(await codec.render(()=>thenable,encoded,context),encoded,context),'settled');assert.equal(thenReads,1);assert.equal(thenCalls,1);
  const fn=()=>42,refs=await codec.arguments([fn],context);
  assert.equal(await codec.decode(await codec.render(()=>refs.values[0],refs,context),refs,context),fn);
  const React=await import('react'),element=React.createElement('p',null,'cached React node');
  const node=await codec.decode(await codec.render(()=>element,encoded,context),encoded,context);
  assert.equal(node.type,'p');assert.equal(node.props.children,'cached React node');
  const symbol=Symbol.for('cached global symbol');assert.equal(await codec.decode(await codec.render(()=>symbol,encoded,context),encoded,context),symbol);
  const iterator=ReadableStream.prototype[Symbol.asyncIterator];
  ReadableStream.prototype[Symbol.asyncIterator]=function(...args){
    const source=iterator.call(this,...args);let previous;
    return{[Symbol.asyncIterator](){return this;},async next(){previous?.fill(0);const value=await source.next();if(!value.done){previous=Buffer.from(value.value);return{...value,value:previous};}return value;},return(...args){return source.return(...args);}};
  };
  try{const owned=await codec.render(()=>({label:'Buffer source survives mutation'}),encoded,context);assert.equal((await codec.decode(owned,encoded,context)).label,'Buffer source survives mutation');}
  finally{ReadableStream.prototype[Symbol.asyncIterator]=iterator;}
  await request.runRequestContext({...context,url:'http://local/',headers:{}},async()=>{
    const callback=()=>({list:[1,2],map:new Map([['value',3n]]),date:new Date(42)});
    const a=await cache.invokeCache('object','private',[],[],callback);a.list[0]=99;a.map.set('value',99n);a.date.setTime(99);
    const b=await cache.invokeCache('object','private',[],[],()=>{throw Error('hit replay');});assert.deepEqual(b.list,[1,2]);assert.equal(b.map.get('value'),3n);assert.equal(b.date.getTime(),42);
  });
  const failure=Error('async cache failure');await assert.rejects(codec.render(async()=>{await Promise.resolve();throw failure;},encoded,context),error=>error===failure);
  const cancelled=Error('cancel primitive');let called=false;
  await assert.rejects(codec.render(()=>{called=true;return 'not visible';},encoded,{...context,signal:AbortSignal.abort(cancelled)}),error=>error===cancelled);assert.equal(called,false);
  const controller=new AbortController();const pending=codec.render(()=>new Promise(()=>{}),encoded,{...context,signal:controller.signal});setTimeout(()=>controller.abort(cancelled),10);await assert.rejects(pending,error=>error===cancelled);
  await assert.rejects(codec.decode(Buffer.from('0:"legacy"\\n'),encoded,context),/Invalid RSC cache result envelope/);
`));
