import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {TYPE,MAX_VALUE,deltaStream,decodeStream,collectStream,createFlightTransport} from '../compat/flight-delta.cjs';
import {createFlightStore,differentialFlight} from './flight-delta.mjs';

const stream=(...parts)=>new ReadableStream({start(c){for(const p of parts)c.enqueue(new Uint8Array(p));c.close();}});
const bytes=async body=>new Uint8Array(await new Response(body).arrayBuffer());
const base=Buffer.from(('0:["layout",'+JSON.stringify('shared data '.repeat(300))+']\n').repeat(10));
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
