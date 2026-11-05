import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {TYPE,MAX_VALUE,deltaStream,decodeStream,collectStream,createFlightTransport} from '../compat/flight-delta.cjs';
import {createFlightStore,differentialFlight,compressedDeltaPolicy,createCompressionProbe} from './flight-delta.mjs';
import {parentStreamChannel} from './app-stream-channel.mjs';
import {gzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const stream=(...parts)=>new ReadableStream({start(c){for(const p of parts)c.enqueue(new Uint8Array(p));c.close();}});
const bytes=async body=>new Uint8Array(await new Response(body).arrayBuffer());
const base=Buffer.from(('0:["layout",'+JSON.stringify('shared data '.repeat(300))+']\n').repeat(10));

function clock() {
  let time=0,wallOffset=0,maximumTimers=0,unreferenced=0;
  const timers=new Map();
  return {
    now:()=>time+wallOffset,
    setTimer(callback,delay){
      const handle={unref(){unreferenced++;}};
      timers.set(handle,{callback,at:time+delay});maximumTimers=Math.max(maximumTimers,timers.size);return handle;
    },
    clearTimer:handle=>timers.delete(handle),
    shiftWall:milliseconds=>{wallOffset+=milliseconds;},
    advance(milliseconds){
      const target=time+milliseconds;
      for(let callbacks=0;;callbacks++){
        const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next||next[1].at>target)break;
        assert.ok(callbacks<100,'expiration must not spin on an already elapsed deadline');
        time=next[1].at;timers.delete(next[0]);next[1].callback();
      }
      time=target;
    },
    get active(){return timers.size;},get maximum(){return maximumTimers;},get unreferenced(){return unreferenced;},
  };
}

test('an idle Flight store expires its bytes without another request and uses one unreferenced timer',()=>{
  const time=clock(),store=createFlightStore({...time,ttl:20,maxBytes:100,maxEntries:2});
  assert.equal(time.active,0);
  store.set('first','alice',new Uint8Array(50));
  time.advance(5);store.set('second','bob',new Uint8Array(50));
  assert.equal(time.active,1);assert.equal(time.unreferenced,1);
  assert.equal(store.get('first','bob'),undefined,'timer bookkeeping cannot change authorization');
  time.advance(15);assert.equal(store.bytes,50);assert.equal(store.size,1);
  time.advance(5);assert.equal(store.bytes,0);assert.equal(store.size,0);
  assert.equal(time.active,0);assert.equal(time.maximum,1);
});

test('replacing and evicting Flight entries reschedules expiry without accumulating timers',()=>{
  const time=clock(),store=createFlightStore({...time,ttl:20,maxBytes:4,maxEntries:1});
  store.set('old','alice',new Uint8Array(4));time.advance(5);
  store.set('new','bob',new Uint8Array(4));
  assert.equal(store.get('old','alice'),undefined);assert.equal(store.bytes,4);
  time.advance(15);assert.equal(store.size,1,'an evicted entry deadline cannot expire its replacement');
  store.set('new','bob',new Uint8Array(2));
  time.advance(19);assert.equal(store.bytes,2);
  time.advance(1);assert.equal(store.bytes,0);assert.equal(time.active,0);assert.equal(time.maximum,1);
});

test('Flight expiry rechecks its clock and long deadlines without spinning or overflowing Node timers',()=>{
  const time=clock(),store=createFlightStore({...time,ttl:20});
  store.set('base','alice',new Uint8Array(4));time.advance(10);time.shiftWall(-15);
  time.advance(10);assert.equal(store.bytes,4,'a backward wall clock must not expire a live base early');
  time.advance(15);assert.equal(store.bytes,0);assert.equal(time.active,0);assert.equal(time.maximum,1);
  const long=clock(),longStore=createFlightStore({...long,ttl:2147483648});
  longStore.set('base','alice',new Uint8Array(4));
  long.advance(2147483647);assert.equal(longStore.size,1);
  long.advance(1);assert.equal(longStore.bytes,0);assert.equal(long.active,0);assert.equal(long.maximum,1);
});

test('Flight expiration never keeps a process alive after its application work ends',async()=>{
  const url=new URL('./flight-delta.mjs',import.meta.url).href;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',`import{createFlightStore}from${JSON.stringify(url)};createFlightStore({ttl:60000}).set('base','alice',new Uint8Array(4));`],{timeout:5000,windowsHide:true});
});

test('an encoder retains its own base while idle expiry frees the store and all slots settle normally',async()=>{
  const time=clock(),store=createFlightStore({...time,ttl:20,maxCaptures:1,maxEncoders:1});
  const client=createFlightTransport();
  const initial=await differentialFlight(response(),options(),store);
  await bytes((await client.response(new Response(initial.body,{headers:initial.headers}))).body);
  const previous=client.snapshot();
  assert.equal(store.get(previous.token,'session=alice'),undefined,'expiry bookkeeping cannot weaken the authorization identity');
  let release,pulls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const source=new ReadableStream({async pull(controller){
    if(++pulls===1)controller.enqueue(base);
    else{await gate;controller.enqueue(base);controller.close();}
  }},{highWaterMark:0});
  const encoded=await differentialFlight({...response(),body:source},options({headers:{...options().headers,'x-prnext-flight-base':previous.token}}),store);
  assert.equal(encoded.headers['content-type'],TYPE);assert.deepEqual(store.inFlight,{captures:1,encoders:1});
  time.advance(20);assert.equal(store.bytes,0);assert.equal(time.active,0);
  assert.deepEqual(store.inFlight,{captures:1,encoders:1},'expiry cannot release active capture/encoder reservations');
  release();
  const restored=await client.response(new Response(encoded.body,{headers:encoded.headers}),previous);
  assert.deepEqual(await bytes(restored.body),new Uint8Array(Buffer.concat([base,base])));
  assert.deepEqual(store.inFlight,{captures:0,encoders:0});assert.equal(store.size,1);
  time.advance(20);assert.equal(store.bytes,0);assert.equal(time.active,0);assert.equal(time.maximum,1);
});
test('Flight delta preserves binary values, shifted records and later streaming chunks',async()=>{
  for(let i=0;i<20;i++){
    const next=Buffer.concat([base,randomBytes(77),base.subarray(17),Buffer.from('changed')]);
    const encoded=await deltaStream(stream(next.subarray(0,12000),next.subarray(12000)),base);
    assert.equal(encoded.delta,true);
    const wire=await bytes(encoded.body);
    assert.ok(wire.length<next.length/3);
    assert.deepEqual(await bytes(decodeStream(stream(wire),base)),new Uint8Array(next));
    if(i===0)assert.deepEqual(await bytes(decodeStream(stream(...[...wire].map(v=>[v])),base)),new Uint8Array(next));
  }
});
test('Unrelated responses keep ordinary streaming Flight',async()=>{
  const next=randomBytes(20000),encoded=await deltaStream(stream(next),base);
  assert.equal(encoded.delta,false);assert.deepEqual(await bytes(encoded.body),new Uint8Array(next));
});
test('a first Flight chunk below the match window never indexes its base or reads ahead',async()=>{
  for(const length of [0,1,31]){
    let indexedBytes=0,pulls=0,assessments=0;
    const stored=new Uint8Array(32768).fill(42),previous=new Proxy(stored,{get(target,key){
      if(typeof key==='string'&&/^\d+$/.test(key))indexedBytes++;
      return Reflect.get(target,key,target);
    }});
    const first=new Uint8Array(length).fill(17),tail=new Uint8Array(64).fill(29);
    const source=new ReadableStream({pull(controller){
      if(++pulls===1)controller.enqueue(first);
      else{controller.enqueue(tail);controller.close();}
    }},{highWaterMark:0});
    const encoded=await deltaStream(source,previous,{assess(){assessments++;return true;}});
    assert.equal(encoded.delta,false);assert.equal(indexedBytes,0,'ordinary Flight cannot need any indexed base bytes');
    assert.equal(assessments,0);assert.equal(pulls,1,'eligibility cannot read the next streaming chunk');
    const reader=encoded.body.getReader();
    assert.deepEqual((await reader.read()).value,first);assert.equal(pulls,1);
    assert.deepEqual((await reader.read()).value,tail);assert.equal((await reader.read()).done,true);
  }
  let cancelled=0,pulls=0;
  const encoded=await deltaStream(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(31));},cancel(){cancelled++;}},{highWaterMark:0}),base);
  await encoded.body.cancel();assert.equal(cancelled,1);assert.equal(pulls,1);
});
test('Malformed delta frames fail closed',async()=>{
  const encoded=await deltaStream(stream(base),base),valid=await bytes(encoded.body);
  for(const wire of [valid.subarray(0,-1),new Uint8Array([...valid,0]),new Uint8Array([80,82,68,50]),new Uint8Array([80,82,68,49,4]),new Uint8Array([80,82,68,49,1,255,255,255,255,0,0,0,1]),new Uint8Array([80,82,68,49,0,0,0,0,0])])
    await assert.rejects(bytes(decodeStream(stream(wire),base)),/delta/i);
});
test('Incomplete and oversized bases are never retained; cancellation reaches source',async()=>{
  let complete=0,cancelled=0;
  const source=new ReadableStream({pull(c){c.enqueue(new Uint8Array(64));},cancel(){cancelled++;}});
  const collected=collectStream(source,{onComplete(){complete++;}}),reader=collected.getReader();
  await reader.read();await reader.cancel();assert.equal(cancelled,1);assert.equal(complete,0);
  await bytes(collectStream(stream(new Uint8Array(MAX_VALUE+1)),{onComplete(){complete++;}}));assert.equal(complete,0);
});

test('arbitrary Flight producers may reuse Uint8Array or pooled Buffer storage without corrupting the retained base',async()=>{
  for(const reused of [new Uint8Array(32),Buffer.allocUnsafe(32)]){
    let pulls=0,captured;
    const source=new ReadableStream({pull(controller){
      if(pulls===2){controller.close();return;}
      reused.fill(++pulls);controller.enqueue(reused);
    }},{highWaterMark:0});
    await bytes(collectStream(source,{onComplete:value=>{captured=value;}}));
    assert.deepEqual(captured,new Uint8Array([...new Uint8Array(32).fill(1),...new Uint8Array(32).fill(2)]));
  }
});

test('transferred worker Flight capture retains owned chunks until one final copy without per-chunk copies',async()=>{
  const expected=randomBytes(1024*1024),wanted=new Uint8Array(expected),original=Uint8Array;
  let position=0,copies=0,captured;const forwarded=[];
  const channel=parentStreamChannel({postMessage(message){
    if(message.type!=='credit')return;
    if(position===expected.length){channel.end();return;}
    const chunk=Uint8Array.from(expected.subarray(position,position+32768));position+=chunk.length;
    const transferred=structuredClone(chunk.buffer,{transfer:[chunk.buffer]});
    assert.equal(chunk.buffer.byteLength,0,'producer ownership ended at transfer');
    channel.chunk(transferred);
  }},1,()=>{});
  try{
    globalThis.Uint8Array=new Proxy(original,{construct(target,args,newTarget){if(args[0] instanceof original)copies++;return Reflect.construct(target,args,newTarget);}});
    const reader=collectStream(channel.body,{onComplete:value=>{captured=value;}}).getReader();
    for(;;){const item=await reader.read();if(item.done)break;forwarded.push(item.value);}
  }finally{globalThis.Uint8Array=original;}
  assert.equal(copies,0);
  assert.deepEqual(new Uint8Array(Buffer.concat(forwarded)),wanted);
  assert.deepEqual(captured,wanted);
});

test('owned partial Flight views copy only visible bytes instead of retaining large backing allocations',async()=>{
  const original=Uint8Array;
  for(const offset of [0,37]){
    let position=0,captured;const copied=[],forwarded=[];
    const channel=parentStreamChannel({postMessage(message){
      if(message.type!=='credit')return;
      if(position===32){channel.end();return;}
      const backing=new Uint8Array(65536);backing[offset]=position++;
      const transferred=structuredClone(backing.buffer,{transfer:[backing.buffer]});
      channel.chunk(transferred,offset,1);
    }},1,()=>{});
    try{
      globalThis.Uint8Array=new Proxy(original,{construct(target,args,newTarget){const value=Reflect.construct(target,args,newTarget);if(args[0] instanceof original)copied.push(value);return value;}});
      const reader=collectStream(channel.body,{onComplete:value=>{captured=value;}}).getReader();
      for(;;){const item=await reader.read();if(item.done)break;forwarded.push(item.value);}
    }finally{globalThis.Uint8Array=original;}
    assert.equal(copied.length,32);assert.ok(copied.every(value=>value.byteLength===1&&value.buffer.byteLength===1));
    assert.equal(copied.reduce((total,value)=>total+value.buffer.byteLength,0),32,'retained allocation equals captured visible bytes');
    assert.deepEqual(new Uint8Array(Buffer.concat(forwarded)),Uint8Array.from({length:32},(_,index)=>index));
    assert.deepEqual(captured,Uint8Array.from({length:32},(_,index)=>index));
  }
});

test('too many tiny Flight capture parts disable only retention and settle admission once',async()=>{
  for(const owned of [false,true]){
    const expected=Uint8Array.from({length:2050},(_,index)=>index%251);
    let position=0,complete=0,finished=0;
    const produce=controller=>{
      if(position===expected.length){controller.close();return;}
      controller.enqueue(new Uint8Array([expected[position++]]));
    };
    let source;
    if(owned){
      const channel=parentStreamChannel({postMessage(message){
        if(message.type!=='credit')return;
        if(position===expected.length){channel.end();return;}
        const value=new Uint8Array([expected[position++]]);
        channel.chunk(structuredClone(value.buffer,{transfer:[value.buffer]}));
      }},1,()=>{});
      source=channel.body;
    }else source=new ReadableStream({pull:produce},{highWaterMark:0});
    const collected=collectStream(source,{onComplete(){complete++;},onFinally(){finished++;}});
    assert.deepEqual(await bytes(collected),expected);
    assert.equal(complete,0,'the abandoned capture cannot enter the bounded base store');assert.equal(finished,1);
  }
});
test('Store bounds, authorization identity and expiry',()=>{
  let now=1;const store=createFlightStore({maxBytes:100,maxEntries:2,ttl:20,now:()=>now});
  store.set('a','alice',new Uint8Array(50));assert.equal(store.get('a','bob'),undefined);
  store.set('b','bob',new Uint8Array(50));store.set('c','alice',new Uint8Array(50));assert.equal(store.get('a','alice'),undefined);
  assert.equal(store.bytes,100);now=22;assert.equal(store.get('c','alice'),undefined);assert.equal(store.bytes,0);
});
const options=(extra={})=>({manifest:{cacheId:'deployment',app:{actionKey:'private-build-secret'}},headers:{rsc:'1','x-prnext-flight-accept':'v1',cookie:'session=alice'},...extra});
const response=()=>({status:200,headers:{'content-type':'text/x-component'},body:stream(base)});
test('Fresh rendering negotiates delta only for same identity and deployment',async()=>{
  const store=createFlightStore(),client=createFlightTransport();
  const first=await differentialFlight(response(),options(),store);
  await bytes((await client.response(new Response(first.body,{headers:first.headers}))).body);
  const previous=client.snapshot();assert.ok(previous);
  const headers={...options().headers,'x-prnext-flight-base':previous.token};
  const next=await differentialFlight(response(),options({headers}),store);
  assert.equal(next.headers['content-type'],TYPE);
  const restored=await client.response(new Response(next.body,{headers:next.headers}),previous);
  assert.deepEqual(await bytes(restored.body),new Uint8Array(base));
  for(const changed of [options({headers:{...headers,cookie:'session=bob'}}),options({manifest:{cacheId:'other',app:{actionKey:'private-build-secret'}},headers})]){
    const full=await differentialFlight(response(),changed,store);assert.notEqual(full.headers['content-type'],TYPE);await bytes(full.body);
  }
});
test('Actions, prefetch and non-negotiating clients preserve original response',async()=>{
  for(const change of [{method:'POST'},{headers:{rsc:'1'}},{headers:{...options().headers,'x-prnext-prefetch':'1'}}]){
    const original=response();assert.equal(await differentialFlight(original,options(change)),original);await bytes(original.body);
  }
});
test('Client cancels a delta with an unknown base',async()=>{
  let cancelled=false;const body=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(createFlightTransport().response(new Response(body,{headers:{'content-type':TYPE}})),/base/);assert.equal(cancelled,true);
});
test('navigation EOF is observed for ordinary and delta Flight without waiting for a later row',async()=>{
  for(const delta of [false,true]){
    let release,pulls=0,ended=0;
    const source=new ReadableStream({pull(controller){if(++pulls===1)controller.enqueue(base);else return new Promise(resolve=>{release=()=>{controller.close();resolve();};});}},{highWaterMark:0});
    const encoded=delta?await deltaStream(source,base):{body:source};
    const client=createFlightTransport(),snapshot={token:'a'.repeat(48),bytes:new Uint8Array(base)};
    const headers=delta?{'content-type':TYPE,'x-prnext-flight-base':snapshot.token}:{'content-type':'text/x-component'};
    const response=await client.response(new Response(encoded.body,{headers}),delta?snapshot:undefined,{onEnd(){ended++;}}),reader=response.body.getReader();
    const first=await reader.read();assert.ok(first.value.length>0);assert.equal(ended,0);assert.equal(pulls,1);
    const eof=reader.read();while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,0);release();assert.equal((await eof).done,true);assert.equal(ended,1);
  }
});
test('cancellation and genuine Flight source failures never mark navigation as complete',async()=>{
  for(const failure of [false,true]){
    let ended=0,cancelled=0;
    const source=new ReadableStream({pull(controller){if(failure)controller.error(new Error('real source failure'));else controller.enqueue(new Uint8Array([1]));},cancel(){cancelled++;}},{highWaterMark:0});
    const response=await createFlightTransport().response(new Response(source),undefined,{onEnd(){ended++;}});
    if(failure)await assert.rejects(bytes(response.body),/real source failure/);
    else{const reader=response.body.getReader();await reader.read();await reader.cancel();assert.equal(cancelled,1);}
    assert.equal(ended,0);
  }
});
test('cancelling an in-flight Flight pull cannot promote its cancellation result as EOF',async()=>{
  let started,release,ended=0,cancelled=0,captured=0,finished=0;
  const ready=new Promise(resolve=>{started=resolve;});
  const source=new ReadableStream({pull(){started();return new Promise(resolve=>{release=resolve;});},cancel(){cancelled++;release();}},{highWaterMark:0});
  const collected=collectStream(source,{onEnd(){ended++;},onComplete(){captured++;},onFinally(){finished++;}}),client=createFlightTransport();
  const response=await client.response(new Response(collected,{headers:{'x-prnext-flight-token':'a'.repeat(48)}}),undefined,{onEnd(){ended++;}}),reader=response.body.getReader();
  const pending=reader.read();await ready;await reader.cancel('superseded');assert.equal((await pending).done,true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,1);assert.equal(ended,0);assert.equal(captured,0);assert.equal(finished,1);assert.equal(client.snapshot(),undefined);
});
test('Concurrent captures and encoders have hard budgets and cancellation releases them',async()=>{
  const store=createFlightStore({maxCaptures:1,maxEncoders:1});
  const held=await differentialFlight(response(),options(),store);
  assert.deepEqual(store.inFlight,{captures:1,encoders:0});
  const overload=await differentialFlight(response(),options(),store);assert.equal(overload.headers['x-prnext-flight-token'],undefined);
  await overload.body.cancel();await held.body.cancel();assert.deepEqual(store.inFlight,{captures:0,encoders:0});
  const seed=await differentialFlight(response(),options(),store),token=seed.headers['x-prnext-flight-token'];await bytes(seed.body);
  const headers={...options().headers,'x-prnext-flight-base':token};
  const delta=await differentialFlight(response(),options({headers}),store);assert.equal(delta.headers['content-type'],TYPE);
  assert.deepEqual(store.inFlight,{captures:1,encoders:1});
  const full=await differentialFlight(response(),options({headers}),store);assert.notEqual(full.headers['content-type'],TYPE);
  await full.body.cancel();await delta.body.cancel();assert.deepEqual(store.inFlight,{captures:0,encoders:0});
});
test('A failed source releases all transport reservations',async()=>{
  const store=createFlightStore(),source=new ReadableStream({pull(){throw Error('source failure');}});
  const result=await differentialFlight({...response(),body:source},options(),store);
  await assert.rejects(bytes(result.body),/source failure/);assert.deepEqual(store.inFlight,{captures:0,encoders:0});
});
test('Rejected stream setup releases its reserved capture',async()=>{
  const store=createFlightStore(),source=stream(base),reader=source.getReader();
  await assert.rejects(differentialFlight({...response(),body:source},options(),store),/locked/i);
  assert.deepEqual(store.inFlight,{captures:0,encoders:0});await reader.cancel();
});

test('Unprofitable later chunks switch to an exact raw tail without per-chunk expansion',async()=>{
  const suffix=Array.from({length:10000},(_,n)=>new Uint8Array([n%251]));
  const encoded=await deltaStream(stream(base,...suffix),base);assert.equal(encoded.delta,true);
  const wire=await bytes(encoded.body);assert.ok(wire.length<base.length+suffix.length);
  assert.deepEqual(await bytes(decodeStream(stream(wire),base)),new Uint8Array(Buffer.concat([base,...suffix])));
});

test('Changing row data cannot turn thousands of references into thousands of writes',async()=>{
  const table=revision=>Buffer.from(Array.from({length:1500},(_,i)=>JSON.stringify({id:i,title:'row '+i,value:i*7,revision})).join('\n'));
  const previous=table('before'),next=table('after');
  const encoded=await deltaStream(stream(next),previous),reader=encoded.body.getReader(),parts=[];
  while(true){const item=await reader.read();if(item.done)break;parts.push(item.value);}
  assert.ok(parts.length<=Math.ceil(next.length/(32*1024))+1,'bounded transport blocks');
  const wire=Buffer.concat(parts);
  assert.deepEqual(encoded.delta?await bytes(decodeStream(stream(wire),previous)):new Uint8Array(wire),new Uint8Array(next));
  const compressed=await deltaStream(stream(next),previous,{assess:compressedDeltaPolicy('gzip, br')});
  const body=await bytes(compressed.body);
  assert.ok(gzipSync(body).length<=gzipSync(next).length*1.05,'no pathological gzip expansion');
});

test('Compression negotiation, bounded probing and useful compressed deltas',async()=>{
  assert.equal(compressedDeltaPolicy('identity, gzip;q=0, br;q=0.0'),undefined);
  assert.equal(compressedDeltaPolicy('gzip;q=0.5')(new Uint8Array(65537),new Uint8Array(5)),false);
  const next=Buffer.concat([base,Buffer.from('fresh request')]);
  const encoded=await deltaStream(stream(next),base,{assess:compressedDeltaPolicy('gzip')});
  assert.equal(encoded.delta,true);
  assert.deepEqual(await bytes(decodeStream(encoded.body,base)),new Uint8Array(next));
});

test('A coalesced encoder flushes before a delayed next chunk and cancels upstream',async()=>{
  let release,cancelled=false,pulls=0;
  const source=new ReadableStream({async pull(c){if(++pulls===1)c.enqueue(base);else await new Promise(resolve=>{release=resolve;});},cancel(){cancelled=true;release?.();}},{highWaterMark:0});
  const encoded=await deltaStream(source,base),reader=encoded.body.getReader();
  const first=await reader.read();assert.ok(first.value.length>4);assert.equal(pulls,1);
  await reader.cancel();assert.equal(cancelled,true);
});

test('async compression admission has no wait queue and abort holds its native slot until all jobs settle',async()=>{
  const jobs=[];
  const probe=createCompressionProbe({maxConcurrent:1,compress:value=>new Promise((resolve,reject)=>jobs.push({value,resolve,reject}))});
  const raw=new Uint8Array(4096),encoded=new Uint8Array(64),abort=new AbortController();
  const pending=probe(raw,encoded,abort.signal);
  const rejected=assert.rejects(pending,error=>error===abort.signal.reason);
  await Promise.resolve();assert.equal(jobs.length,2);assert.equal(probe.inFlight,1);
  assert.equal(probe(raw,encoded),false,'overload falls back immediately');
  abort.abort(new Error('navigation cancelled'));await rejected;
  assert.equal(probe.inFlight,1,'cancellation cannot admit replacements over still-running native work');
  jobs[0].reject(new Error('zlib failed'));
  await Promise.resolve();assert.equal(probe.inFlight,1,'the other native job is still alive');
  jobs[1].resolve(new Uint8Array(1000));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(probe.inFlight,0);
  const next=probe(raw,encoded);await Promise.resolve();
  jobs[2].resolve(new Uint8Array(20));jobs[3].resolve(new Uint8Array(1000));
  assert.equal(await next,true);assert.equal(probe.inFlight,0);
});

test('failed asynchronous compression keeps exact ordinary Flight and does not strand encoder admission',async()=>{
  const probe=createCompressionProbe({compress:async()=>{throw new Error('unavailable compressor');}});
  const encoded=await deltaStream(stream(base),base,{assess:probe});
  assert.equal(encoded.delta,false);assert.deepEqual(await bytes(encoded.body),new Uint8Array(base));assert.equal(probe.inFlight,0);
});

test('an async delta assessment cannot read ahead into a delayed Suspense chunk',async()=>{
  let resolveAssessment,started,pulls=0,cancelled=false;
  const ready=new Promise(resolve=>{started=resolve;});
  const source=new ReadableStream({pull(controller){pulls++;controller.enqueue(base);},cancel(){cancelled=true;}},{highWaterMark:0});
  const assessing=deltaStream(source,base,{assess:()=>new Promise(resolve=>{resolveAssessment=resolve;started();})});
  await ready;assert.equal(pulls,1);
  resolveAssessment(true);
  const encoded=await assessing,reader=encoded.body.getReader();
  assert.ok((await reader.read()).value.length>4);assert.equal(pulls,1);
  await reader.cancel();assert.equal(cancelled,true);assert.equal(pulls,1);
});
