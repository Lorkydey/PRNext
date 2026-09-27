import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { unstable_cache, revalidateTag, updateTag, revalidatePath, unstable_noStore, refresh } from '../compat/cache.cjs';
import { runRequestContext, currentRequest, headers, cookies } from '../compat/headers.cjs';
import {
  cachedValue, deferredValue, createCacheState, flushCacheWork, flushCacheInvalidations,
  getCachePaths, MAX_CACHE_VALUE_BYTES,
} from '../compat/data-cache.cjs';

const key = name => createHash('sha256').update(name).digest('hex');
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
let server, entries, leases, requests, failOperation, busyReads, stalledBody, leaseId = 0;
const savedEnv = { url: process.env.PRNEXT_CACHE_URL, token: process.env.PRNEXT_CACHE_TOKEN };

before(async () => {
  server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer cache-test-secret');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const operation = JSON.parse(Buffer.concat(chunks));
    requests.push(operation);
    if (stalledBody && operation.op === 'read') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"state":');
      stalledBody.resolve();
      return;
    }
    if (operation.op === failOperation) { response.writeHead(500).end(); return; }
    if (operation.op === 'read' && busyReads > 0) { busyReads--; response.writeHead(503).end(); return; }
    let result;
    if (operation.op === 'read') {
      let entry = entries.get(operation.key);
      if (entry) {
        for (const tag of operation.tags) entry.tags.add(tag);
        for (const path of operation.paths) entry.paths.add(path);
      }
      let lease = leases.get(operation.key);
      if (entry && !entry.stale) result = { state: 'fresh', value: entry.value };
      else if (entry && !operation.forceFresh) {
        if (!lease) {
          lease = { id: String(++leaseId), tags: new Set(operation.tags), paths: new Set(operation.paths) };
          leases.set(operation.key, lease);
          result = { state: 'stale', value: entry.value, lease: lease.id };
        } else result = { state: 'stale', value: entry.value };
      } else if (lease) {
        for (const tag of operation.tags) lease.tags.add(tag);
        for (const path of operation.paths) lease.paths.add(path);
        result = { state: 'pending', retryAfterMs: 5 };
      } else {
        lease = { id: String(++leaseId), tags: new Set(operation.tags), paths: new Set(operation.paths) };
        leases.set(operation.key, lease);
        result = { state: 'miss', lease: lease.id };
      }
    } else if (operation.op === 'commit') {
      const lease = leases.get(operation.key);
      const stored = lease?.id === operation.lease;
      if (stored) {
        const old = entries.get(operation.key);
        entries.set(operation.key, { value: operation.value, stale: false, tags: new Set([...(old?.tags || []), ...lease.tags]), paths: new Set([...(old?.paths || []), ...lease.paths]) });
        leases.delete(operation.key);
      }
      result = { stored };
    } else if (operation.op === 'release') {
      if (leases.get(operation.key)?.id === operation.lease) leases.delete(operation.key);
      result = { released: true };
    } else if (operation.op === 'invalidate') {
      for (const [id, entry] of entries) {
        if ((operation.tags || []).some(tag => entry.tags.has(tag)) || (operation.paths || []).some(path => entry.paths.has(path))) {
          if (operation.mode === 'expire') entries.delete(id);
          else entry.stale = true;
        }
      }
      leases.clear();
      result = { invalidated: true };
    } else throw new Error(`Unexpected cache operation: ${operation.op}`);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.PRNEXT_CACHE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PRNEXT_CACHE_TOKEN = 'cache-test-secret';
});
beforeEach(() => { entries = new Map(); leases = new Map(); requests = []; failOperation = undefined; busyReads = 0; stalledBody = undefined; });
after(async () => {
  if (savedEnv.url === undefined) delete process.env.PRNEXT_CACHE_URL;
  else process.env.PRNEXT_CACHE_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.PRNEXT_CACHE_TOKEN;
  else process.env.PRNEXT_CACHE_TOKEN = savedEnv.token;
  await new Promise(resolve => server.close(resolve));
});

const request = (callback, input = {}) => runRequestContext({ phase: 'render', url: 'http://app.test/products/one', route: { pattern: '/products/[id]' }, ...input }, callback);

test('unstable_cache keys include function, key parts and JSON arguments; tags do not change identity', async () => {
  let calls = 0;
  const producer = async id => ({ id, number: ++calls, date: new Date('2020-01-01'), omitted: undefined });
  const cached = unstable_cache(producer, ['products'], { tags: ['one'], revalidate: 60 });
  const shared = unstable_cache(producer, ['products'], { tags: ['two'] });
  const first = await request(() => cached('a'));
  assert.ok(first.date instanceof Date);
  first.number = 99;
  assert.deepEqual(await request(() => shared('a')), { id: 'a', number: 1, date: '2020-01-01T00:00:00.000Z' });
  assert.equal((await request(() => cached('b'))).number, 2);
  assert.equal((await request(() => unstable_cache(producer, ['different'])('a'))).number, 3);
  assert.equal((await request(() => unstable_cache(async id => ({ id, other: true }), ['products'])('a'))).other, true);
  assert.equal(calls, 3);
  assert.deepEqual([...entries.values()][0].tags, new Set(['one', 'two']));
});

test('concurrent misses compute once, attach every route and discard the local owner after completion', async () => {
  const ready = gate();
  let calls = 0;
  const cached = unstable_cache(async () => { calls++; await ready.promise; return { version: calls }; });
  const reads = Array.from({ length: 8 }, (_, i) => request(() => cached(), { url: `http://app.test/products/${i}` }));
  while (!calls) await delay(1);
  assert.equal(calls, 1);
  ready.resolve();
  assert.deepEqual(await Promise.all(reads), Array(8).fill({ version: 1 }));
  const entry = [...entries.values()][0];
  for (let i = 0; i < 8; i++) assert.ok(entry.paths.has(`page:/products/${i}`));
  entries.clear();
  assert.deepEqual(await request(() => cached()), { version: 2 });
});

test('stale tags return immediately, refresh once in the background and preserve the old value on failure', async () => {
  let version = 1;
  let held;
  let shouldFail = false;
  const cached = unstable_cache(async () => { if (held) await held.promise; if (shouldFail) throw new Error('origin failed'); return version; }, ['swr'], { tags: ['products'] });
  assert.equal(await request(() => cached()), 1);
  await request(async () => { revalidateTag('products', 'max'); await flushCacheInvalidations(); }, { phase: 'route' });
  assert.equal(requests.find(operation => operation.op === 'invalidate').expire, 31536000);
  version = 2;
  held = gate();
  const state = createCacheState();
  assert.equal(await request(() => cached(), { cacheState: state }), 1);
  assert.equal(await request(() => cached()), 1);
  assert.equal(state.pending.size, 1);
  held.resolve();
  held = undefined;
  await flushCacheWork({ cacheState: state });
  assert.equal(await request(() => cached()), 2);
  await request(async () => { revalidateTag('products', 'max'); await flushCacheInvalidations(); }, { phase: 'route' });
  shouldFail = true;
  assert.equal(await request(() => cached(), { cacheState: state }), 2);
  await flushCacheWork({ cacheState: state });
  assert.equal([...entries.values()][0].stale, true);
  assert.equal(leases.size, 0);
});

test('fast background refresh still returns stale values in actions until updateTag immediately expires them', async () => {
  let version = 1;
  const cached = unstable_cache(async () => version, ['fast-swr'], { tags: ['items'] });
  assert.equal(await request(() => cached()), 1);
  await request(async () => { revalidateTag('items', 'max'); await flushCacheWork(); }, { phase: 'route' });
  version = 2;
  await request(async () => { assert.equal(await cached(), 1); await flushCacheWork(); });
  await request(async () => { revalidateTag('items', 'max'); await flushCacheWork(); }, { phase: 'route' });
  version = 3;
  await request(async () => { assert.equal(await cached(), 2); await flushCacheWork(); }, { phase: 'action' });
  version = 4;
  await request(async () => { updateTag('items'); assert.equal(await cached(), 4); }, { phase: 'action' });
});

test('Pages, static App renders and standalone cached functions await fresh stale entries', async () => {
  for (const scope of ['pages', 'static', 'standalone']) {
    let version = 1, held;
    const cached = unstable_cache(async () => { if (held) await held.promise; return version; }, [scope], { tags: [scope] });
    const read = () => scope === 'pages' ? request(() => cached(), { phase: 'pages' })
      : scope === 'static' ? request(() => cached(), { staticGeneration: { mode: 'auto' } }) : cached();
    assert.equal(await read(), 1);
    await request(async () => { revalidateTag(scope, 'max'); await flushCacheWork(); }, { phase: 'route' });
    version = 2;
    held = gate();
    const pending = read();
    await delay(10);
    held.resolve();
    assert.equal(await pending, 2);
  }
});

test('synchronous invalidation APIs complete before a same-action cached read and reject failed invalidation', async () => {
  let calls = 0;
  const cached = unstable_cache(async () => ++calls, ['own-writes'], { tags: ['item'] });
  assert.equal(await request(() => cached()), 1);
  await request(async () => {
    assert.equal(updateTag('item'), undefined);
    assert.equal(await cached(), 2);
    refresh();
    assert.equal(currentRequest().cacheState.refresh, true);
  }, { phase: 'action' });
  failOperation = 'invalidate';
  await request(async () => {
    revalidateTag('item', { expire: 0 });
    await assert.rejects(cached(), /invalidate failed/);
    await assert.rejects(flushCacheWork(), /invalidate failed/);
  }, { phase: 'route' });
  assert.equal(calls, 2);
});

test('page, layout and route-pattern dependencies normalize escaped URLs and route groups', async () => {
  assert.deepEqual(getCachePaths({ url: 'http://app.test/caf%C3%A9/%61%2fb/?q=1', route: { pattern: '/(shop)/café/[id]' } }), [
    'page:/caf%C3%A9/a%2Fb', 'layout:/', 'layout:/caf%C3%A9', 'layout:/caf%C3%A9/a%2Fb',
    'page:/caf%C3%A9/[id]', 'layout:/caf%C3%A9/[id]',
  ]);
  let calls = 0;
  const cached = unstable_cache(async id => `${id}:${++calls}`, ['paths']);
  assert.equal(await request(() => cached('one')), 'one:1');
  assert.equal(await request(() => cached('two'), { url: 'http://app.test/other/two', route: { pattern: '/other/[id]' } }), 'two:2');
  await request(async () => { revalidatePath('/products/[id]', 'page'); await flushCacheWork(); }, { phase: 'route' });
  assert.equal(await request(() => cached('one')), 'one:3');
  assert.equal(await request(() => cached('two'), { url: 'http://app.test/other/two', route: { pattern: '/other/[id]' } }), 'two:2');
  await request(async () => { revalidatePath('/', 'layout'); await flushCacheWork(); }, { phase: 'action' });
  assert.equal(entries.size, 0);
});

test('cache scopes prohibit request-specific APIs and mutation, while noStore leaves explicit caching enabled', async () => {
  await request(async () => {
    for (const read of [headers, cookies]) {
      await assert.rejects(unstable_cache(async () => read(), [read.name])(), /inside unstable_cache/);
    }
    await assert.rejects(unstable_cache(async () => updateTag('item'))(), /inside unstable_cache/);
    assert.equal((await headers()).get('x-user'), 'safe-outside');
    const explicit = unstable_cache(async () => { unstable_noStore(); return 'still cached'; }, ['no-store']);
    assert.equal(await explicit(), 'still cached');
    assert.equal(currentRequest().cacheState.noStore, false);
    unstable_noStore();
    assert.equal(currentRequest().cacheState.noStore, true);
    assert.equal(await explicit(), 'still cached');
  }, { phase: 'action', headers: { 'x-user': 'safe-outside' } });
});

test('cache API restrictions and options fail clearly before mutation', async () => {
  assert.throws(() => unstable_cache(null), /requires a function/);
  assert.throws(() => unstable_cache(async () => 1, [1]), /array of strings/);
  for (const revalidate of [0, -1, NaN, '1']) assert.throws(() => unstable_cache(async () => 1, [], { revalidate }), /revalidate/);
  assert.doesNotThrow(() => unstable_cache(async () => 1, [], { revalidate: Infinity }));
  assert.throws(() => unstable_cache(async () => 1, [], { tags: ['x'.repeat(257)] }), /256/);
  assert.throws(() => unstable_cache(async () => 1, [], { tags: Array(129).fill('x') }), /128/);
  for (const operation of [() => updateTag('tag'), () => revalidateTag('tag'), () => revalidatePath('/'), refresh]) {
    assert.throws(operation, /Server Action/);
    request(() => assert.throws(operation, /outside rendering/));
  }
  request(() => {
    assert.throws(() => updateTag('x'), /Server Action/);
    assert.throws(refresh, /Server Action/);
    assert.throws(() => revalidatePath('/items/[id]'), /requires a page or layout type/);
    assert.throws(() => revalidatePath('/x', 'invalid'), /page or layout/);
    assert.throws(() => revalidatePath('https://app.test/x'), /application paths/);
    assert.throws(() => revalidatePath('/' + 'x'.repeat(1024)), /1024/);
    assert.throws(() => revalidateTag('x', 'custom'), /Unknown cache lifetime/);
    assert.throws(() => revalidateTag('x', { expire: -1 }), /nonnegative/);
    currentRequest().cacheState.closed = true;
    assert.throws(() => revalidateTag('x'), /headers have been sent/);
  }, { phase: 'route' });
  assert.equal(requests.length, 0);
});

test('nested unstable_cache and force-no-store routes execute without reading shared cache entries', async () => {
  let calls = 0;
  const inner = unstable_cache(async () => ++calls, ['inner']);
  assert.equal(await request(() => inner()), 1);
  const outer = unstable_cache(async () => inner(), ['outer']);
  assert.equal(await request(() => outer()), 2);
  assert.equal(await request(() => outer()), 2);
  assert.equal(await request(() => inner()), 1);
  assert.equal(await request(() => inner(), { cacheConfig: { forceNoStore: true } }), 3);
  assert.equal(await request(() => inner(), { cacheConfig: { forceNoStore: true } }), 4);
  let recurse = true;
  const recursive = unstable_cache(async () => {
    if (recurse) { recurse = false; return recursive(); }
    return 'completed without joining its own lease';
  }, ['same-key-recursion']);
  assert.equal(await request(() => recursive()), 'completed without joining its own lease');
});

test('deferred fetch owners return live responses before EOF while followers wait for cache fill', async () => {
  const eof = gate();
  const state = createCacheState();
  const id = key('deferred');
  let calls = 0;
  const producer = async () => { calls++; return deferredValue(new Response('owner'), eof.promise); };
  const first = await request(() => cachedValue(id, producer), { cacheState: state });
  assert.ok(first instanceof Response);
  assert.equal(await first.text(), 'owner');
  assert.equal(entries.size, 0);
  assert.equal(state.pending.size, 1);
  let followerDone = false;
  const follower = request(() => cachedValue(id, producer)).then(value => { followerDone = true; return value; });
  await delay(10);
  assert.equal(followerDone, false);
  eof.resolve(Buffer.from('cached-body'));
  assert.equal((await follower).toString(), 'cached-body');
  await flushCacheWork({ cacheState: state });
  assert.equal(calls, 1);
  assert.equal(state.pending.size, 0);
});

test('uncacheable deferred responses and thrown sentinels never share a live response between callers', async () => {
  let calls = 0;
  const id = key('uncacheable');
  const producer = async () => {
    const ordinal = ++calls;
    return deferredValue(new Response(`response-${ordinal}`), delay(5).then(() => null));
  };
  const state = createCacheState();
  const responses = await Promise.all([request(() => cachedValue(id, producer), { cacheState: state }), request(() => cachedValue(id, producer), { cacheState: state })]);
  assert.deepEqual(await Promise.all(responses.map(value => value.text())), ['response-1', 'response-2']);
  await flushCacheWork({ cacheState: state });
  assert.equal(entries.size, 0);
  const failures = await Promise.allSettled([1, 2].map(() => cachedValue(key('sentinel'), async () => { await delay(5); throw new Error(`uncacheable-${++calls}`); })));
  assert.notEqual(failures[0].reason, failures[1].reason);
  assert.equal(leases.size, 0);
});

test('cache commit failure does not repeat a producer, and oversized values stay uncached', async () => {
  let calls = 0;
  failOperation = 'commit';
  assert.equal((await cachedValue(key('commit-failed'), async () => Buffer.from(String(++calls)))).toString(), '1');
  assert.equal(calls, 1);
  assert.equal(leases.size, 0);
  failOperation = undefined;
  const large = Buffer.alloc(MAX_CACHE_VALUE_BYTES + 1, 7);
  const producer = async () => { calls++; return large; };
  assert.equal(await cachedValue(key('large'), producer), large);
  assert.equal(await cachedValue(key('large'), producer), large);
  assert.equal(calls, 3);
  assert.equal(entries.size, 0);
});

test('temporary native admission pressure retries without bypassing coalescing', async () => {
  busyReads = 3;
  let calls = 0;
  const producer = async () => Buffer.from(String(++calls));
  assert.equal((await cachedValue(key('busy-native'), producer)).toString(), '1');
  assert.equal((await cachedValue(key('busy-native'), producer)).toString(), '1');
  assert.equal(calls, 1);
  assert.equal(requests.filter(operation => operation.op === 'read').length, 5);
});

test('cache RPC deadlines cover response bodies after successful headers', { timeout: 8000 }, async t => {
  stalledBody = gate();
  const controller = new AbortController();
  t.after(() => controller.abort());
  let calls = 0;
  const value = await cachedValue(key('stalled-json'), () => { calls++; return Buffer.from('origin'); }, { signal: controller.signal });
  assert.equal(value.toString(), 'origin');
  assert.equal(calls, 1);
});

test('parent cancellation interrupts a cache RPC body without invoking its producer', async () => {
  stalledBody = gate();
  const controller = new AbortController();
  const pending = cachedValue(key('canceled-json'), () => assert.fail('canceled read must not invoke its producer'), { signal: controller.signal });
  await stalledBody.promise;
  const reason = new Error('request canceled during cache JSON');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('aborted producers release leases and cannot commit late results', async () => {
  const started = gate();
  const ready = gate();
  const controller = new AbortController();
  const pending = cachedValue(key('aborted'), async () => { started.resolve(); await ready.promise; return Buffer.from('obsolete'); }, { signal: controller.signal });
  await started.promise;
  controller.abort(new Error('cancelled request'));
  await assert.rejects(pending, /cancelled request/);
  ready.resolve();
  await delay(5);
  assert.equal(entries.size, 0);
  assert.equal(leases.size, 0);
  assert.equal((await cachedValue(key('aborted'), async () => Buffer.from('new'))).toString(), 'new');
});

test('build-time calls without a cache endpoint compute directly and cache RPC uses the captured native fetch', async () => {
  const url = process.env.PRNEXT_CACHE_URL;
  delete process.env.PRNEXT_CACHE_URL;
  let calls = 0;
  const cached = unstable_cache(async () => ++calls, ['build-fallback']);
  try {
    assert.equal(await cached(), 1);
    assert.equal(await cached(), 2);
    request(() => assert.throws(() => revalidateTag('x'), /running PRNext server/), { phase: 'route' });
  } finally { process.env.PRNEXT_CACHE_URL = url; }
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('patched fetch must not handle cache RPC'); };
  try { assert.equal(await cached(), 3); assert.equal(await cached(), 3); }
  finally { globalThis.fetch = fetch; }
});
