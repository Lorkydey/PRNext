import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from './toolchain/node_modules/redis/dist/index.js';
import { createRedisIncrementalCache } from '../packages/prnext/compat/redis-cache.cjs';
import { redisServer } from './redis-test-support.mjs';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let server;
before(async () => { server = await redisServer(); }); after(async () => server?.close());
async function handlers(t, extra = {}) {
  const namespace = randomUUID(), clients = [createClient({ url: server.url }), createClient({ url: server.url })];
  for (const client of clients) { client.on('error', () => {}); await client.connect(); }
  const values = clients.map(client => new (createRedisIncrementalCache({ namespace, client, ...extra }))());
  t.after(async () => { for (const value of values) await value.close(); for (const client of clients) if (client.isOpen) client.destroy(); });
  return values;
}
const options = lease => ({ prnextLease: lease, tags: ['products', '_N_T_/catalog/page'], cacheControl: { revalidate: 60 } });
const value = text => ({ kind: 'APP_PAGE', html: text, rscData: Buffer.from([0, 128, 255]), segmentData: new Map([['a', Buffer.from('segment')]]), _prnext: { revalidate: 60 } });

test('incremental Redis preserves binary RSC, Maps and stable entry versions across instances', async t => {
  const [a, b] = await handlers(t), lease = await a.acquire('page');
  assert.equal(await a.set('page', value('first'), options(lease)), true); await a.release('page', lease);
  const first = await b.get('page'); await delay(10); const second = await a.get('page');
  assert.deepEqual(first.value, value('first')); assert.equal(first.lastModified, second.lastModified);
  await b.revalidateTag('products');
  const stale = await a.get('page'); assert.equal(stale.isStale, true); assert.equal(stale.lastModified, first.lastModified);
  await b.revalidateTag('_N_T_/catalog/page', { expire: 0 }); assert.equal(await a.get('page'), null);
});

test('invalidated or expired producers cannot publish or remove a newer incremental generation', async t => {
  const [a, b] = await handlers(t, { leaseMs: 1000 });
  const invalid = await a.acquire('page'); await b.revalidateTag(['products'], { expire: 0 });
  assert.equal(await a.set('page', value('obsolete'), options(invalid)), false); await a.release('page', invalid);
  const old = await a.acquire('page'); await delay(1100); const current = await b.acquire('page');
  assert.equal(await b.set('page', value('fresh'), options(current)), true);
  assert.equal(await a.set('page', value('late'), options(old)), false);
  await a.set('page', null, options(old)); await a.release('page', old);
  assert.equal((await b.get('page')).value.html, 'fresh'); await b.release('page', current);
  await assert.rejects(a.set('page', value('unfenced'), {}), /valid generation lease/);
});

test('independent processes share one unstable_cache producer through the incremental handler', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-redis-incremental-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'server'));
  const provider = new URL('../packages/prnext/compat/redis-cache.cjs', import.meta.url).href;
  const redis = new URL('./toolchain/node_modules/redis/dist/index.js', import.meta.url).href;
  await writeFile(path.join(root, 'server/handler.mjs'), `import{createRedisIncrementalCache}from ${JSON.stringify(provider)};import{createClient}from ${JSON.stringify(redis)};export const client=createClient({url:${JSON.stringify(server.url)}});client.on('error',()=>{});await client.connect();export default createRedisIncrementalCache({namespace:${JSON.stringify(randomUUID())},client});`);
  const headers = new URL('../packages/prnext/compat/headers.cjs', import.meta.url).href;
  const cache = new URL('../packages/prnext/compat/cache.cjs', import.meta.url).href;
  const incremental = new URL('../packages/prnext/compat/incremental-cache.cjs', import.meta.url).href;
  const source = `import{runRequestContext,currentRequest}from ${JSON.stringify(headers)};import{unstable_cache}from ${JSON.stringify(cache)};import{load}from ${JSON.stringify(incremental)};import{appendFile}from'node:fs/promises';const read=unstable_cache(async()=>{await appendFile(${JSON.stringify(path.join(root, 'producers'))},'x');await new Promise(r=>setTimeout(r,150));return{value:'shared'}},['same'],{revalidate:60,tags:['products']});await runRequestContext({distDir:${JSON.stringify(root)},cacheHandler:'server/handler.mjs',phase:'route',url:'http://local/catalog',routePattern:'/catalog'},async()=>{try{console.log(JSON.stringify(await read()))}finally{const {handler}=await load(currentRequest());await handler.close()}});const {client}=await import(${JSON.stringify(new URL('file:///' + path.join(root, 'server/handler.mjs').replaceAll('\\', '/')).href)});client.destroy();`;
  const execute = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['--input-type=module', '-e', source], { maxBuffer: 1024 * 1024 })));
  for (const result of results) assert.deepEqual(JSON.parse(result.stdout.trim()), { value: 'shared' });
  assert.equal(await readFile(path.join(root, 'producers'), 'utf8'), 'x');
});
