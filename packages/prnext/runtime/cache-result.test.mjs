import test from 'node:test';
import assert from 'node:assert/strict';
import {primitiveCacheResult,flightCacheResult,isCacheResultPacket,readCacheResult,CACHE_RESULT_LIMIT} from './cache-result.mjs';

test('versioned scalar cache packets preserve primitive values and well-formed Unicode',()=>{
  for(const value of[null,undefined,true,false,0,-0,NaN,Infinity,-Infinity,1.25,2n**128n,-42n,'','hello','🎉'.repeat(8192),'x'.repeat(1024*1024)]){
    const packet=primitiveCacheResult(value);assert.ok(Buffer.isBuffer(packet));assert.ok(Object.is(readCacheResult(packet).value,value));
  }
});

test('ordinary Flight retains its exact bytes with owned single and multi-chunk aggregates',()=>{
  for(const split of[false,true]){
    const bytes=Buffer.from('0:"ordinary Flight"\n'),chunks=split?[bytes.subarray(0,3),bytes.subarray(3)]:[bytes];
    const result=flightCacheResult(chunks,bytes.length);assert.deepEqual(result,bytes);assert.equal(isCacheResultPacket(result),false);
    assert.notEqual(result,bytes);bytes.fill(0);assert.ok(result.includes('ordinary Flight'));
  }
  assert.throws(()=>flightCacheResult([],CACHE_RESULT_LIMIT+1),/16 MiB/);
});

test('the entire reserved first-byte family is escaped once, including empty leading chunks and scalar collisions',()=>{
  for(const raw of[Buffer.from('Pfuture official protocol'),primitiveCacheResult(42)]){
    for(const chunks of[[raw],[Buffer.alloc(0),raw],[Buffer.alloc(0),raw.subarray(0,1),raw.subarray(1)]]){
      const escaped=flightCacheResult(chunks,raw.length);assert.equal(isCacheResultPacket(escaped),true);assert.equal(escaped[5],0);
      assert.deepEqual(readCacheResult(escaped).flight,raw);assert.notDeepEqual(escaped,raw);
    }
  }
  const source=Buffer.from('Powned'),escaped=flightCacheResult([source],source.length);source.fill(0);assert.equal(readCacheResult(escaped).flight.toString(),'Powned');
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
  const oldVersion=Buffer.from(valid);oldVersion[4]=1;assert.throws(()=>readCacheResult(oldVersion),/Invalid/);
  const unknownVersion=Buffer.from(valid);unknownVersion[4]=3;assert.throws(()=>readCacheResult(unknownVersion),/Invalid/);
  for(const raw of[Buffer.from('P'),Buffer.from('Pnot a private packet')])assert.throws(()=>readCacheResult(raw),/Invalid/);
  const emptyEscape=primitiveCacheResult(null);emptyEscape[5]=0;assert.throws(()=>readCacheResult(emptyEscape),/Invalid/);
  const unnecessaryEscape=Buffer.concat([emptyEscape,Buffer.from('0:"raw"\n')]);assert.throws(()=>readCacheResult(unnecessaryEscape),/Invalid/);
  const utf8=primitiveCacheResult('x');utf8[6]=255;assert.throws(()=>readCacheResult(utf8),/Invalid/);
  const reserved=primitiveCacheResult('x');reserved[5]=8;assert.throws(()=>readCacheResult(reserved),/Invalid/);
  assert.equal(primitiveCacheResult('x'.repeat(CACHE_RESULT_LIMIT-32*1024)),undefined);
  assert.equal(primitiveCacheResult('x'.repeat(CACHE_RESULT_LIMIT+1)),undefined);
  assert.equal(primitiveCacheResult('🎉'.repeat(CACHE_RESULT_LIMIT/3)),undefined);
});
