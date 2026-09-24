import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { unstable_cache, revalidateTag, revalidatePath } from '../compat/cache.cjs';
import { flushCacheWork } from '../compat/data-cache.cjs';
import { installFetchCache } from './fetch-cache.mjs';
import { runIncrementalCache } from './incremental-cache.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-incremental-'));
  await mkdir(path.join(root, 'server'));
  const filename = path.join(root, 'server/handler.mjs');
  await writeFile(filename, `export const entries=new Map(),calls=[];export let mode='';export const configure=value=>{mode=value};
export default class Handler {
 constructor(options){calls.push(['constructor',options]);this.options=options}
 resetRequestCache(){calls.push(['reset'])}
 async get(key,ctx){calls.push(['get',key,ctx]);if(mode==='offline')throw Error('offline');return entries.get(key)||null}
 async set(key,value,ctx){calls.push(['set',key,ctx]);if(mode==='offline')throw Error('offline');entries.set(key,{value,lastModified:Date.now(),tags:ctx.tags})}
 async revalidateTag(tags,durations){calls.push(['invalidate',tags,durations]);if(mode==='invalidation-error')throw Error('backend invalidation failed');for(const [key,entry]of entries)if(tags.some(tag=>entry.tags.includes(tag)))entries.delete(key)}
}`);
  const module = await import(pathToFileURL(filename).href);
  const options = { distDir: root, cacheHandler: 'server/handler.mjs', cacheMaxMemorySize: 0, url: 'http://local/products/a', routePattern: '/products/[id]', phase: 'route', production: true };
  const request = (callback, extra = {}) => runRequestContext({ ...options, ...extra }, async () => { try { return await callback(); } finally { await flushCacheWork(); } });
  return { module, options, request, remove: () => rm(root, { recursive: true, force: true }) };
}

test('legacy cache handles constructor context, FETCH entries, deduplication, tag/path invalidation and reset per request', async () => {
  const f = await fixture(); let count = 0;
  const read = unstable_cache(async () => { await delay(10); return { count: ++count }; }, ['product'], { tags: ['products'], revalidate: 60 });
  try {
    assert.deepEqual(await f.request(() => Promise.all(Array.from({ length: 6 }, () => read())), { headers: { 'x-tenant': 'alice' } }), Array(6).fill({ count: 1 }));
    assert.deepEqual(await f.request(read, { headers: { 'x-tenant': 'bob' } }), { count: 1 });
    const constructors = f.module.calls.filter(([name]) => name === 'constructor');
    assert.equal(constructors.length, 2);
    assert.equal(constructors[0][1]._requestHeaders['x-tenant'], 'alice');
    assert.equal(constructors[1][1]._requestHeaders['x-tenant'], 'bob');
    assert.equal(constructors[0][1].maxMemoryCacheSize, 0);
    assert.equal(f.module.calls.filter(([name]) => name === 'reset').length, 2);
    const entry = [...f.module.entries.values()][0];
    assert.equal(entry.value.kind, 'FETCH'); assert.deepEqual(JSON.parse(entry.value.data.body), { count: 1 });
    assert.ok(entry.tags.includes('_N_T_/products/[id]/page'));
    await f.request(() => revalidateTag('products', { expire: 0 }));
    assert.deepEqual(await f.request(read), { count: 2 });
    await f.request(() => revalidatePath('/products', 'layout'));
    assert.deepEqual(await f.request(read), { count: 3 });
  } finally { await f.remove(); }
});

test('legacy fetch cache preserves live responses, response metadata and persistent bytes', async () => {
  const f = await fixture(); let count = 0;
  const server = createServer((req, res) => { res.setHeader('x-count', String(++count)); res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(Buffer.from([0, 1, 255])); setTimeout(() => res.end('end'), 20); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/bytes`;
  installFetchCache();
  try {
    for (let index = 0; index < 2; index++) {
      await f.request(async () => {
        const response = await fetch(url, { cache: 'force-cache', next: { tags: ['bytes'] } });
        assert.equal(response.headers.get('x-count'), '1'); assert.equal(response.url, url);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 1, 255, 101, 110, 100]));
      });
    }
    assert.equal(count, 1);
    const entry = [...f.module.entries.values()][0];
    assert.equal(entry.value.kind, 'FETCH');
    assert.equal(entry.value.data.body, 'AAH/ZW5k');
    await f.request(() => revalidateTag('bytes', { expire: 0 }));
    await f.request(async () => { await (await fetch(url, { cache: 'force-cache' })).arrayBuffer(); });
    assert.equal(count, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.remove(); }
});

test('stale entries refresh once in the background and failures retain successful origin responses', async () => {
  const f = await fixture(); let calls = 0;
  const read = unstable_cache(async () => { await delay(10); return ++calls; }, ['stale'], { revalidate: 1 });
  try {
    assert.equal(await f.request(read), 1);
    [...f.module.entries.values()][0].lastModified = Date.now() - 2000;
    assert.equal(await f.request(read), 1);
    assert.equal(await f.request(read), 2);
    f.module.configure('offline');
    assert.equal(await f.request(read), 3);
    f.module.configure('invalidation-error');
    await assert.rejects(f.request(() => revalidateTag('anything')), /backend invalidation failed/);
  } finally { await f.remove(); }
});

test('private draft requests and oversized values do not enter the incremental backend', async () => {
  const f = await fixture(); let calls = 0;
  const read = unstable_cache(async () => ++calls, ['draft']);
  try {
    assert.equal(await f.request(() => { currentRequest().draftMode = true; return read(); }), 1);
    assert.equal(f.module.calls.length, 0);
    const large = unstable_cache(async () => 'x'.repeat(2 * 1024 * 1024 + 1), ['large']);
    assert.equal((await f.request(large)).length, 2 * 1024 * 1024 + 1);
    assert.equal(f.module.entries.size, 0);
  } finally { await f.remove(); }
});

test('stored FETCH lifetime still expires when the next reader requests an unlimited lifetime', async () => {
  const f = await fixture(); let calls = 0;
  const producer = async () => ++calls;
  const short = unstable_cache(producer, ['stored-lifetime'], { revalidate: 1 });
  const unlimited = unstable_cache(producer, ['stored-lifetime'], { revalidate: false });
  try {
    assert.equal(await f.request(short), 1);
    [...f.module.entries.values()][0].lastModified = Date.now() - 2000;
    assert.equal(await f.request(unlimited), 1);
    assert.equal(await f.request(unlimited), 2);
    assert.equal(calls, 2);
  } finally { await f.remove(); }
});

test('a local invalidation fences pending writes and subsequent readers do not join old production', async () => {
  const f = await fixture(); let value = 'old', release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const read = unstable_cache(async () => { const captured = value; if (captured === 'old') { started(); await blocked; } return captured; }, ['race'], { tags: ['race'] });
  try {
    const old = f.request(read); await entered; value = 'new';
    await f.request(() => revalidateTag('race', { expire: 0 }));
    assert.equal(await f.request(read), 'new'); release(); assert.equal(await old, 'old');
    assert.equal(await f.request(read), 'new');
  } finally { release?.(); await f.remove(); }
});

test('native cache bridge carries Pages, App and Route Handler pairs and avoids retransferring unchanged content', async () => {
  const f = await fixture();
  const htmlFile = path.join(f.options.distDir, 'html');
  const dataFile = path.join(f.options.distDir, 'data');
  const call = input => runIncrementalCache({ ...f.options, manifest: { config: { cacheHandler: f.options.cacheHandler } }, body: Buffer.from(JSON.stringify(input)).toString('base64') });
  try {
    for (const kind of ['PAGES', 'APP_PAGE', 'APP_ROUTE']) {
      const html = kind === 'APP_ROUTE' ? Buffer.from([0, 255, 1]) : Buffer.from('<p>native pair</p>');
      const data = kind === 'APP_PAGE' ? Buffer.from('0:["flight"]\n') : Buffer.from('{"pageProps":{"count":1}}');
      await writeFile(htmlFile, html); await writeFile(dataFile, data);
      const request = { key: 'rustyx:build:' + kind, kind };
      assert.equal((await call({ ...request, op: 'get' })).status, 204);
      assert.equal((await call({ ...request, op: 'set', htmlFile, dataFile, status: 200, headers: { 'content-type': 'application/octet-stream' }, revalidate: 60, tags: ['pair'], paths: ['layout:/'] })).status, 204);
      const response = await call({ ...request, op: 'get' });
      assert.equal(response.status, 200); assert.equal(response.isr.revalidate, 60);
      assert.deepEqual(response.body[0], html);
      assert.deepEqual(response.body[1], kind === 'APP_ROUTE' ? Buffer.alloc(0) : data);
      assert.equal(response.headers['x-next-cache-tags'], undefined);
      assert.equal((await call({ ...request, op: 'get', knownVersion: response.isr.cacheVersion })).status, 304);
      assert.equal((await call({ ...request, op: 'invalidate', tags: ['pair'] })).status, 204);
      assert.equal((await call({ ...request, op: 'get' })).status, 204);
    }
  } finally { await f.remove(); }
});

test('cancelling an incremental producer releases local admission for a subsequent request', async () => {
  const f = await fixture(); let blocked = true;
  const read = unstable_cache(async () => blocked ? new Promise(() => {}) : 'ready', ['abort']);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancel producer')), 25);
  try {
    await assert.rejects(f.request(read, { signal: controller.signal }), /cancel producer/);
    blocked = false;
    assert.equal(await f.request(read, { signal: AbortSignal.timeout(1000) }), 'ready');
  } finally { clearTimeout(timer); await f.remove(); }
});
