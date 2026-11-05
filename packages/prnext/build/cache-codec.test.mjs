import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {cacheHash,readCacheRecord,writeCacheRecord} from './persistent-cache.mjs';
const key=cacheHash('record'),other=cacheHash('other'),MAGIC=Buffer.from('PRNC2\0'),HEADER=MAGIC.length+68;
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'prnext-codec-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('large JSON compresses once, stays checksum/key bounded and round-trips byte-for-byte',async t=>{
  const directory=await fixture(t),value={source:'export const text = "é東京\\n";\n'.repeat(18000),assets:[{name:'logo',data:Buffer.alloc(3000,1).toString('base64')}]};
  assert.equal(await writeCacheRecord(directory,key,value),true);
  const packed=await readFile(path.join(directory,key+'.json'));assert.ok(packed.subarray(0,6).equals(MAGIC));
  assert.ok(packed.length<Buffer.byteLength(JSON.stringify(value))*0.2);assert.deepEqual(await readCacheRecord(directory,key),value);
  await writeFile(path.join(directory,other+'.json'),packed);assert.equal(await readCacheRecord(directory,other),null,'renaming a cache entry cannot change its identity');
  assert.equal(await readCacheRecord(directory,key,packed.length+1),null,'uncompressed length obeys the reader limit');
});

test('legacy raw JSON remains readable and small writes preserve version one',async t=>{
  const directory=await fixture(t),value={entries:[['one','small result']]},payload=JSON.stringify(value);
  await writeFile(path.join(directory,key+'.json'),JSON.stringify({version:1,key,checksum:cacheHash(payload),payload}));
  assert.deepEqual(await readCacheRecord(directory,key),value);
  assert.equal(await writeCacheRecord(directory,key,value),true);assert.equal(JSON.parse(await readFile(path.join(directory,key+'.json'),'utf8')).version,1);
});

test('truncated, altered, oversized and decompression-bomb records are misses',async t=>{
  const directory=await fixture(t),file=path.join(directory,key+'.json');
  await writeCacheRecord(directory,key,{source:'x'.repeat(65536)});const valid=await readFile(file);
  for(const bytes of [valid.subarray(0,20),valid.subarray(0,-5),Buffer.concat([valid.subarray(0,HEADER),randomBytes(30)]),Buffer.from(valid)]){
    if(bytes.length===valid.length)bytes[MAGIC.length+40]^=1;
    await writeFile(file,bytes);assert.equal(await readCacheRecord(directory,key),null);
  }
  const header=Buffer.from(valid.subarray(0,HEADER));header.writeUInt32BE(32,MAGIC.length);
  await writeFile(file,Buffer.concat([header,deflateRawSync(Buffer.alloc(1024*1024,1))]));
  assert.equal(await readCacheRecord(directory,key),null,'inflate must stop at declared output bound');
  header.writeUInt32BE(0xffffffff,MAGIC.length);await writeFile(file,header);assert.equal(await readCacheRecord(directory,key),null);
  for(const limit of [NaN,Infinity,-1,0,0.5,128*1024*1024]){
    assert.equal(await readCacheRecord(directory,key,limit),null);assert.equal(await writeCacheRecord(directory,key,{},limit),false);
  }
  assert.equal(await writeCacheRecord(directory,key,{source:'x'.repeat(30000)},10000),false,'compression does not bypass the decoded input limit');
});

test('parallel compressed writers publish complete records and namespace file caps work',async t=>{
  const directory=await fixture(t),values=Array.from({length:12},(_,i)=>({source:String(i).repeat(25000)}));
  await Promise.all(values.map(value=>writeCacheRecord(directory,key,value)));
  const restored=await readCacheRecord(directory,key);assert.ok(values.some(value=>value.source===restored.source));
  for(let i=0;i<5;i++)await writeCacheRecord(directory,cacheHash('key'+i),{i},undefined,{maxFiles:2});
  assert.equal((await readdir(directory)).filter(name=>name.endsWith('.json')).length,2);
  assert.equal((await readdir(directory)).filter(name=>name.endsWith('.tmp')).length,0);
});
