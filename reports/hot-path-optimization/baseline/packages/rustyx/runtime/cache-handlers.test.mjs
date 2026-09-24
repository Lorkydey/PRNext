import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { invokeCache, cacheTag, cacheLife } from '../compat/use-cache.cjs';
import { runRequestContext, currentRequest, cookies } from '../compat/headers.cjs';
import { revalidateTag, revalidatePath } from '../compat/cache.cjs';
import { flushCacheWork } from '../compat/data-cache.cjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-handlers-unit-'));
  await mkdir(path.join(root, 'server'));
  const filename = path.join(root, 'server/handler.mjs');
  await writeFile(filename, `
export const entries = new Map(), times = new Map(), calls = [];
export let mode = '';
export const configure = value => { mode = value };
export default {
 async refreshTags(){calls.push(['refresh']); if(mode==='offline')throw Error('offline')},
 async getExpiration(tags){return Math.max(0,...tags.map(tag=>times.get(tag)||0))},
 async get(key,softTags){calls.push(['get',softTags]); if(mode==='oversize')return {tags:[],timestamp:Date.now(),stale:0,revalidate:99,expire:999,value:new ReadableStream({start(c){c.enqueue(new Uint8Array(2097153));c.close()}})}; const entry=entries.get(key);if(!entry||[...entry.tags,...softTags].some(tag=>(times.get(tag)||0)>=entry.timestamp))return; return {...entry,value:new ReadableStream({start(c){c.enqueue(entry.bytes);c.close()}})}},
 async set(key,pending){calls.push(['set']); const entry=await pending; const bytes=new Uint8Array(await new Response(entry.value).arrayBuffer());entries.set(key,{...entry,bytes})},
 async updateTags(tags,durations){calls.push(['update',tags,durations]);for(const tag of tags)times.set(tag,Date.now())}
};`);
  const handler = await import(pathToFileURL(filename).href);
  const options = { distDir: root, cacheHandlers: { remote: 'server/handler.mjs', analytics: 'server/handler.mjs' }, url: 'http://local/products/one', routePattern: '/products/[id]', phase: 'route' };
  return { handler, options, remove: () => rm(root, { recursive: true, force: true }) };
}

test('custom handlers preserve data, named kinds, coalescing, tags, implicit paths and request-local refresh', async () => {
  const f = await fixture();
  let calls = 0;
  const read = () => invokeCache('products', 'remote', [], [], async () => { calls++; await delay(10); cacheTag('products'); cacheLife('hours'); return { calls, date: new Date(0), amount: 12n }; });
  const request = callback => runRequestContext(f.options, async () => { try { return await callback(); } finally { await flushCacheWork(); } });
  try {
    const first = await request(async () => { const results = await Promise.all(Array.from({ length: 8 }, read)); assert.ok(results.every(value => value.calls === 1)); return results[0]; });
    assert.equal(calls, 1);
    assert.deepEqual(await request(read), first);
    assert.equal(f.handler.calls.filter(([name]) => name === 'refresh').length, 2);
    const tags = f.handler.calls.find(([name]) => name === 'get')[1];
    assert.ok(tags.includes('_N_T_/layout')); assert.ok(tags.includes('_N_T_/products/[id]/page'));
    await request(async () => { revalidateTag('products', { expire: 0 }); });
    assert.equal((await request(read)).calls, 2);
    assert.equal(f.handler.calls.filter(([name]) => name === 'update').length, 1, 'one handler object shared by two names is invalidated once');
    await request(async () => { revalidatePath('/products', 'layout'); });
    assert.equal((await request(read)).calls, 3);
    const other = await request(() => invokeCache('products', 'analytics', [], [], async () => ++calls));
    assert.equal(other, 4, 'named directives have distinct keys');
    const handlerCalls = f.handler.calls.length;
    await runRequestContext({ ...f.options, headers: { cookie: 'tenant=alice' } }, async () => assert.equal(await invokeCache('private', 'private', [], [], async () => (await cookies()).get('tenant').value), 'alice'));
    assert.equal(f.handler.calls.length, handlerCalls, 'private directives never call a custom handler');
  } finally { await f.remove(); }
});

test('custom cache failures and oversized streams fall back to the producer; Draft Mode bypasses handlers', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    for (const mode of ['offline', 'oversize']) {
      f.handler.configure(mode);
      assert.equal(await runRequestContext(f.options, () => invokeCache(mode, 'remote', [], [], async () => ++calls)), calls);
    }
    const previous = f.handler.calls.length;
    await runRequestContext(f.options, async () => {
      currentRequest().draftMode = true;
      assert.equal(await invokeCache('draft', 'remote', [], [], async () => ++calls), 3);
    });
    assert.equal(f.handler.calls.length, previous);
  } finally { await f.remove(); }
});

test('invalidation during a pending producer prevents publication and external dependencies propagate', async () => {
  const f = await fixture();
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  try {
    const work = runRequestContext(f.options, () => invokeCache('race', 'remote', [], [], async () => { cacheTag('race'); started(); await blocked; return 'old'; }));
    await entered;
    await runRequestContext(f.options, async () => { revalidateTag('race', { expire: 0 }); await flushCacheWork(); });
    release(); assert.equal(await work, 'old');
    assert.equal(f.handler.entries.size, 0);
    await runRequestContext({ ...f.options, staticGeneration: { mode: 'auto' } }, async () => {
      assert.equal(await invokeCache('parent', 'default', [], [], () => invokeCache('child', 'remote', [], [], async () => 'fresh')), 'fresh');
      assert.equal(currentRequest().staticState.externalCache, true);
    });
  } finally { release?.(); await f.remove(); }
});

test('a read after invalidation cannot join an older in-flight custom-cache producer', async () => {
  const f = await fixture();
  let release, started, value = 'old';
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const read = () => runRequestContext(f.options, () => invokeCache('pending-generation', 'remote', [], [], async () => {
    cacheTag('pending-generation'); const captured = value;
    if (captured === 'old') { started(); await blocked; }
    return captured;
  }));
  try {
    const old = read(); await entered;
    value = 'new';
    await runRequestContext(f.options, async () => { revalidateTag('pending-generation', { expire: 0 }); await flushCacheWork(); });
    const fresh = read();
    await delay(20);
    release();
    assert.equal(await old, 'old');
    assert.equal(await fresh, 'new');
    assert.equal(await read(), 'new');
  } finally { release?.(); await f.remove(); }
});

test('a joined reader observes distant invalidation without replaying the original producer', async () => {
  const f = await fixture();
  let release, started, value = 'old', calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const read = () => runRequestContext(f.options, () => invokeCache('distant-generation', 'remote', [], [], async () => {
    calls++; cacheTag('distant-generation'); const captured = value;
    if (captured === 'old') { started(); await blocked; }
    return captured;
  }));
  try {
    const old = read(); await entered;
    value = 'new';
    // An external backend update has no access to this worker's revision map.
    await f.handler.default.updateTags(['distant-generation'], { expire: 0 });
    const fresh = read(); await delay(20); release();
    assert.equal(await old, 'old');
    assert.equal(await fresh, 'new');
    assert.equal(calls, 2);
    assert.equal(await read(), 'new');
    assert.equal(calls, 2);
  } finally { release?.(); await f.remove(); }
});

test('an infinite handler expiration delegates to get and does not replay joined producers', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    f.handler.default.getExpiration = async () => Infinity;
    const read = () => runRequestContext(f.options, () => invokeCache('infinite-expiration', 'remote', [], [], async () => { calls++; await delay(20); return 'shared'; }));
    assert.deepEqual(await Promise.all([read(), read()]), ['shared', 'shared']);
    assert.equal(calls, 1);
    assert.equal(await read(), 'shared');
    assert.equal(calls, 1);
  } finally { await f.remove(); }
});

test('a joined reader rechecks get when infinite expiration hides a distant invalidation', async () => {
  const f = await fixture();
  let release, started, value = 'old', calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const read = () => runRequestContext(f.options, () => invokeCache('infinite-distant-generation', 'remote', [], [], async () => {
    calls++; cacheTag('infinite-distant-generation'); const captured = value;
    if (captured === 'old') { started(); await blocked; }
    return captured;
  }));
  try {
    f.handler.default.getExpiration = async () => Infinity;
    const old = read(); await entered;
    // The backend deliberately exposes invalidation only through get().
    await delay(2); value = 'new';
    await f.handler.default.updateTags(['infinite-distant-generation'], { expire: 0 });
    const fresh = read(); await delay(20); release();
    assert.equal(await old, 'old');
    assert.equal(await fresh, 'new');
    assert.equal(calls, 2);
    assert.equal(await read(), 'new');
    assert.equal(calls, 2);
  } finally { release?.(); await f.remove(); }
});
