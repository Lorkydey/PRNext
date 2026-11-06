import test from 'node:test';
import assert from 'node:assert/strict';
import {primitiveCacheResult,flightCacheResult,readCacheResult,CACHE_RESULT_LIMIT} from './cache-result.mjs';

test('versioned scalar cache packets preserve primitive values and well-formed Unicode',()=>{
  for(const value of[null,undefined,true,false,0,-0,NaN,Infinity,-Infinity,1.25,2n**128n,-42n,'','hello','🎉'.repeat(8192),'x'.repeat(1024*1024)]){
    const packet=primitiveCacheResult(value);assert.ok(Buffer.isBuffer(packet));assert.ok(Object.is(readCacheResult(packet).value,value));
  }
  const bytes=Buffer.from('0:"ordinary Flight"\n'),packet=flightCacheResult([bytes],bytes.length);
  assert.deepEqual(readCacheResult(packet).flight,bytes);bytes.fill(0);assert.ok(readCacheResult(packet).flight.includes('ordinary Flight'));
});

test('scalar eligibility never observes object, function, proxy or getter state',()=>{
  let reads=0;const value=new Proxy({get then(){reads++;throw Error('must not read');}},{get(){reads++;throw Error('must not inspect');},ownKeys(){reads++;throw Error('must not enumerate');}});
  for(const candidate of[value,{},[],()=>{},Symbol.for('fallback'),'\ud800x\udc00','\ufeffhello','hello\ufeff'])assert.equal(primitiveCacheResult(candidate),undefined);
  assert.equal(reads,0);
});

test('official byte streams transfer enqueue storage to their reader',async()=>{
  const source=new Uint8Array([1,2,3]),stream=new ReadableStream({type:'bytes',start(controller){controller.enqueue(source);controller.close();}});
  assert.equal(source.byteLength,0);const reader=stream.getReader();
  try{const first=await reader.read();assert.deepEqual([...first.value],[1,2,3]);assert.equal((await reader.read()).done,true);assert.deepEqual([...first.value],[1,2,3]);}finally{reader.releaseLock();}
});

test('cache result protocol rejects legacy bytes, unknown variants, invalid encodings and oversized values',()=>{
  const valid=primitiveCacheResult(1);
  for(const bytes of[Buffer.from('0:"legacy"\n'),valid.subarray(0,5),Buffer.concat([primitiveCacheResult(null),Buffer.from([0])]),Buffer.concat([valid,Buffer.from([0])])])assert.throws(()=>readCacheResult(bytes),/Invalid/);
  const unknown=Buffer.from(valid);unknown[5]=255;assert.throws(()=>readCacheResult(unknown),/Invalid/);
  const utf8=primitiveCacheResult('x');utf8[6]=255;assert.throws(()=>readCacheResult(utf8),/Invalid/);
  const reserved=primitiveCacheResult('x');reserved[5]=8;assert.throws(()=>readCacheResult(reserved),/Invalid/);
  assert.equal(primitiveCacheResult('x'.repeat(CACHE_RESULT_LIMIT-32*1024)),undefined);
  assert.equal(primitiveCacheResult('x'.repeat(CACHE_RESULT_LIMIT+1)),undefined);
  assert.equal(primitiveCacheResult('🎉'.repeat(CACHE_RESULT_LIMIT/3)),undefined);
});
