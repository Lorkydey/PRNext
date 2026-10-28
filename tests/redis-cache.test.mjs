import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createClient} from './toolchain/node_modules/redis/dist/index.js';
import {createRedisCache} from '../packages/prnext/compat/redis-cache.cjs';
import {redisServer} from './redis-test-support.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

let server;
before(async()=>{server=await redisServer();});after(async()=>server?.close());
async function handlers(t,options={}){
  const namespace=randomUUID(),clients=[createClient({url:server.url}),createClient({url:server.url})];for(const client of clients){client.on('error',()=>{});await client.connect();}
  const values=clients.map(client=>createRedisCache({namespace,client,...options}));t.after(async()=>{for(const value of values)await value.close();for(const client of clients)if(client.isOpen)client.destroy();});return {a:values[0],b:values[1],client:clients[0],namespace};
}
const entry=(bytes,tags=['products'])=>({tags,value:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),timestamp:Date.now(),stale:30,revalidate:60,expire:3600});
async function store(handler,key,bytes,tags){const lease=await handler.acquire(key);try{await handler.set(key,Promise.resolve(entry(bytes,tags)),{lease});}finally{await lease.release();}}
async function bytes(value){return value?Buffer.from(await new Response(value.value).arrayBuffer()):undefined;}

test('real Redis shares opaque binary values, separates namespaces and preserves unrelated tags',async t=>{
  const {a,b,client}=await handlers(t),value=Buffer.alloc(2*1024*1024);for(let i=0;i<value.length;i++)value[i]=i%256;
  await store(a,'large',value);assert.deepEqual(await bytes(await b.get('large')),value);
  await store(a,'other',Buffer.from('other'),['other']);await b.updateTags(['products'],{expire:0});assert.equal(await a.get('large'),undefined);assert.equal((await bytes(await a.get('other'))).toString(),'other');
  const isolated=createRedisCache({namespace:randomUUID(),client});assert.equal(await isolated.get('other'),undefined);await isolated.close();
  await store(a,'empty',Buffer.alloc(0));assert.equal((await bytes(await b.get('empty'))).length,0);
});
test('soft invalidation becomes stale immediately and honors the requested hard expiration',async t=>{
  const {a,b}=await handlers(t);await store(a,'key',Buffer.from('cached'));await b.updateTags(['products']);
  const stale=await a.get('key');assert.equal(stale.revalidate,0);assert.equal((await bytes(stale)).toString(),'cached');
  await b.updateTags(['products'],{expire:0.05});await delay(100);assert.equal(await a.get('key'),undefined);
});
test('invalidated and expired lease owners cannot overwrite a newer generation or unlock its owner',async t=>{
  const {a,b}=await handlers(t,{leaseMs:1000});const old=await a.acquire('key');await b.updateTags(['products'],{expire:0});await a.set('key',Promise.resolve(entry(Buffer.from('obsolete'))),{lease:old});assert.equal(await b.get('key'),undefined);await old.release();
  const expired=await a.acquire('key');await delay(1100);const current=await b.acquire('key');await expired.release();
  await b.set('key',Promise.resolve(entry(Buffer.from('fresh'))),{lease:current});await a.set('key',Promise.resolve(entry(Buffer.from('late'))),{lease:expired});assert.equal((await bytes(await a.get('key'))).toString(),'fresh');await current.release();
});
test('losing the tag registry cannot resurrect cached entries after Redis eviction',async t=>{
  const {a,b,client,namespace}=await handlers(t);await store(a,'key',Buffer.from('old'));
  const root='prnext:v1:{'+createHash('sha256').update(namespace).digest('hex')+'}:tags';await client.del(root);assert.equal(await b.get('key'),undefined);
  const lease=await b.acquire('new');await lease.release();assert.equal(await a.get('key'),undefined);
});
test('blocked values and excessive entries are bounded and invalidation failures remain visible',async t=>{
  const {a,client}=await handlers(t,{commandTimeoutMs:100,waitMs:200});const lease=await a.acquire('key');
  await assert.rejects(a.set('unfenced',Promise.reject(new Error('producer failure'))),/require the lease/);
  await assert.rejects(a.set('key',Promise.resolve({...entry(Buffer.from('x')),value:new ReadableStream({pull(){return new Promise(()=>{});}})}),{lease}),/timed out/);await lease.release();
  const large=await a.acquire('large');await assert.rejects(a.set('large',Promise.resolve(entry(Buffer.alloc(2*1024*1024+1))),{lease:large}),/2 MiB/);await large.release();
  client.destroy();await assert.rejects(a.updateTags(['products'],{expire:0}));
});

test('high-cardinality invalidations keep a bounded registry and safely rotate its incarnation',async t=>{
  const {a,client,namespace}=await handlers(t);await store(a,'old',Buffer.from('old'));
  for(let i=0;i<4097;i+=256)await a.updateTags(Array.from({length:Math.min(256,4097-i)},(_,n)=>'tag-'+(i+n)),{expire:0});
  assert.equal(await a.get('old'),undefined);
  const root='prnext:v1:{'+createHash('sha256').update(namespace).digest('hex')+'}:tags';assert.ok(await client.hLen(root)<=4098);
});

test('separate Node processes coalesce real Cache Components and never publish a fill invalidated in flight',{timeout:60000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-redis-processes-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));await mkdir(path.join(root,'server'));
  const namespace=randomUUID(),provider=new URL('../packages/prnext/compat/redis-cache.cjs',import.meta.url).href,redis=new URL('./toolchain/node_modules/redis/dist/index.js',import.meta.url).href;
  await writeFile(path.join(root,'server/handler.mjs'),`import{createRedisCache}from ${JSON.stringify(provider)};import{createClient}from ${JSON.stringify(redis)};export const client=createClient({url:${JSON.stringify(server.url)}});client.on('error',()=>{});await client.connect();export default createRedisCache({namespace:${JSON.stringify(namespace)},client});`);
  const execute=promisify(execFile),worker=fileURLToPath(new URL('./redis-producer-worker.mjs',import.meta.url));
  const run=(gated=false)=>execute(process.execPath,[worker,root,...(gated?['gate']:[])],{maxBuffer:1024*1024});
  const responses=await Promise.all(Array.from({length:4},()=>run()));
  for(const response of responses)assert.deepEqual(JSON.parse(response.stdout.trim()),{value:'shared',date:'1970-01-01T00:00:00.000Z',amount:'12'});
  assert.equal(await readFile(path.join(root,'producers'),'utf8'),'x','one producer across independent processes');
  const imported=await import(pathToFileURL(path.join(root,'server/handler.mjs')).href);t.after(()=>{if(imported.client.isOpen)imported.client.destroy();});
  await imported.default.updateTags(['products'],{expire:0});await rm(path.join(root,'started'));
  const pending=run(true);let started=false;for(let i=0;i<200;i++){try{await readFile(path.join(root,'started'));started=true;break;}catch{await delay(10);}}assert.equal(started,true);
  await imported.default.updateTags(['products'],{expire:0});await writeFile(path.join(root,'release'),'go');await pending;
  await run();assert.equal(await readFile(path.join(root,'producers'),'utf8'),'xxx','the invalidated in-flight fill must not repopulate the shared cache');
});
