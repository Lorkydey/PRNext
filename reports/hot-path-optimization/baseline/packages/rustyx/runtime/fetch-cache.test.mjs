import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { installFetchCache } from './fetch-cache.mjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { flushCacheWork, runCacheScope, MAX_CACHE_VALUE_BYTES } from '../compat/data-cache.cjs';

let origin, service, originUrl;
let entries, leases, operations, counts, gates, failCommit;
let nextLease = 0;
const saved = { url: process.env.RUSTYX_CACHE_URL, token: process.env.RUSTYX_CACHE_TOKEN, fetch: globalThis.fetch };
const context = (callback, options = {}) => runRequestContext({ phase: 'route', production: true, url: 'http://app.test/products/one', routePattern: '/products/[id]', ...options }, callback);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function textFetch(path, init, options) {
  return context(async () => { const response = await fetch(originUrl + path, init); const body = await response.text(); await flushCacheWork(); return { response, body }; }, options);
}

before(async () => {
  service = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fetch-cache-secret');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const operation = JSON.parse(Buffer.concat(chunks));
    operations.push(operation);
    let result;
    if (operation.op === 'read') {
      const entry = entries.get(operation.key);
      if (entry) result = { state: 'fresh', value: entry };
      else if (leases.has(operation.key)) result = { state: 'pending', retryAfterMs: 5 };
      else { const lease = String(++nextLease); leases.set(operation.key, lease); result = { state: 'miss', lease }; }
    } else if (operation.op === 'commit') {
      if (failCommit) { response.writeHead(503).end(); return; }
      const stored = leases.get(operation.key) === operation.lease;
      if (stored) { entries.set(operation.key, operation.value); leases.delete(operation.key); }
      result = { stored };
    } else if (operation.op === 'release') {
      if (leases.get(operation.key) === operation.lease) leases.delete(operation.key);
      result = { released: true };
    } else if (operation.op === 'invalidate') { entries.clear(); leases.clear(); result = { invalidated: true }; }
    else throw new Error('Unexpected cache operation');
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  origin = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://origin.test');
    const count = (counts.get(url.pathname) || 0) + 1;
    counts.set(url.pathname, count);
    response.setHeader('x-origin-count', String(count));
    if (url.pathname === '/redirect') { response.writeHead(302, { location: '/data?redirected=1' }).end(); return; }
    if (url.pathname === '/set-cookie') response.setHeader('set-cookie', ['session=one; Path=/', 'other=two; Path=/']);
    if (url.pathname === '/failure') response.statusCode = 500;
    if (url.pathname === '/stream') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('prefix');
      await gates.get(url.searchParams.get('gate')).promise;
      response.end('suffix');
      return;
    }
    if (url.pathname === '/large') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(65536, 71);
      for (let index = 0; index < 40 && !response.destroyed; index++) {
        if (!response.write(chunk)) await new Promise(resolve => {
          const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
          response.once('drain', done); response.once('close', done);
        });
      }
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ count, method: request.method, authorization: request.headers.authorization,
      cookie: request.headers.cookie, variant: request.headers['x-variant'], body: Buffer.concat(chunks).toString(), query: url.search }));
  });
  await Promise.all([new Promise(resolve => service.listen(0, '127.0.0.1', resolve)), new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))]);
  originUrl = `http://127.0.0.1:${origin.address().port}`;
  process.env.RUSTYX_CACHE_URL = `http://127.0.0.1:${service.address().port}`;
  process.env.RUSTYX_CACHE_TOKEN = 'fetch-cache-secret';
  installFetchCache();
});
beforeEach(() => { entries = new Map(); leases = new Map(); operations = []; counts = new Map(); gates = new Map(); failCommit = false; });
after(async () => {
  for (const value of gates.values()) value.resolve();
  globalThis.fetch = saved.fetch;
  if (saved.url === undefined) delete process.env.RUSTYX_CACHE_URL; else process.env.RUSTYX_CACHE_URL = saved.url;
  if (saved.token === undefined) delete process.env.RUSTYX_CACHE_TOKEN; else process.env.RUSTYX_CACHE_TOKEN = saved.token;
  await Promise.all([origin, service].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
});

test('persistent fetch caching is explicit; default, tags alone, conflicts and forced-dynamic routes bypass it', async () => {
  const first = await textFetch('/data', { cache: 'force-cache', next: { tags: ['products'], revalidate: 90 } });
  const second = await textFetch('/data', { cache: 'force-cache', next: { tags: ['products'], revalidate: 10 } });
  assert.equal(first.body, second.body);
  assert.notEqual(first.response, second.response);
  assert.equal(counts.get('/data'), 1);
  assert.ok(operations.some(operation => operation.op === 'read' && operation.revalidate === 10));
  assert.ok(operations.some(operation => operation.paths?.includes('page:/products/one') && operation.tags?.includes('products')));
  for (const init of [{}, { next: { tags: ['only-tag'] } }, { cache: 'no-store' }, { cache: 'no-store', next: { revalidate: 10 } }, { cache: 'force-cache', next: { revalidate: 0 } }]) {
    await textFetch('/uncached', init); await textFetch('/uncached', init);
  }
  assert.equal(counts.get('/uncached'), 10);
  await textFetch('/dynamic', { cache: 'force-cache' }, { cacheConfig: { forceNoStore: true } });
  await textFetch('/dynamic', { cache: 'force-cache' }, { cacheConfig: { forceNoStore: true } });
  assert.equal(counts.get('/dynamic'), 2);
  await textFetch('/pages', { cache: 'force-cache' }, { phase: 'pages' });
  await textFetch('/pages', { cache: 'force-cache' }, { phase: 'pages' });
  assert.equal(counts.get('/pages'), 2);
  assert.equal((await textFetch('/indefinite', { next: { revalidate: false } })).body, (await textFetch('/indefinite', { next: { revalidate: false } })).body);
});

test('request keys isolate authorization, cookies, headers, methods, bodies and Request overrides', async () => {
  for (const authorization of ['Bearer alice', 'Bearer bob']) {
    const init = { cache: 'force-cache', headers: { authorization, cookie: `session=${authorization}`, 'x-variant': 'one' } };
    const result = await textFetch('/private', init);
    assert.equal(result.body, (await textFetch('/private', init)).body);
    assert.equal(JSON.parse(result.body).authorization, authorization);
  }
  assert.equal(counts.get('/private'), 2);
  for (const body of ['first', 'second']) {
    const init = { method: 'POST', body, cache: 'force-cache', headers: { 'content-type': 'text/plain' } };
    assert.equal((await textFetch('/post', init)).body, (await textFetch('/post', init)).body);
  }
  assert.equal(counts.get('/post'), 2);
  await textFetch('/post', { method: 'POST', body: 'first' });
  await textFetch('/post', { method: 'POST', body: 'first' });
  assert.equal(counts.get('/post'), 4);
  await context(async () => {
    for (let index = 0; index < 2; index++) {
      const request = new Request(originUrl + '/override', { headers: { 'x-variant': 'old' } });
      const response = await fetch(request, { method: 'POST', body: 'overridden', cache: 'force-cache', headers: { 'x-variant': 'new' } });
      const value = await response.json();
      assert.equal(value.method, 'POST'); assert.equal(value.variant, 'new'); assert.equal(value.body, 'overridden');
      await flushCacheWork();
    }
  });
  assert.equal(counts.get('/override'), 1);
  for (const content of ['same file', 'same file', 'changed file']) {
    const body = new FormData();
    body.append('title', 'example');
    body.append('file', new File([content], 'test.txt', { type: 'text/plain' }));
    await textFetch('/form', { method: 'POST', cache: 'force-cache', body });
  }
  assert.equal(counts.get('/form'), 2, 'random multipart boundaries do not change logical FormData identity');
});

test('render GET memoization gives independent bodies, opts out with a signal and is bounded', async () => {
  await context(async () => {
    const [first, second] = await Promise.all([fetch(originUrl + '/memo'), fetch(originUrl + '/memo')]);
    assert.notEqual(first, second);
    assert.equal(await first.text(), await second.text());
    assert.equal(counts.get('/memo'), 1);
    assert.equal(entries.size, 0);
    const signal = new AbortController().signal;
    await (await fetch(originUrl + '/memo', { signal })).text();
    await (await fetch(originUrl + '/memo', { signal })).text();
    assert.equal(counts.get('/memo'), 3);
    for (let index = 0; index < 135; index++) await (await fetch(originUrl + `/bounded?item=${index}`)).text();
    const memo = currentRequest().cacheState.fetchMemo;
    assert.ok(memo.entries.size <= 128); assert.ok(memo.bytes <= 8 * 1024 * 1024);
  }, { phase: 'render' });
});

test('fetch exposes streaming headers and its first body bytes before a cached origin completes', async () => {
  const held = gate(); gates.set('headers', held);
  try {
    await context(async () => {
      const response = await Promise.race([
        fetch(originUrl + '/stream?gate=headers', { cache: 'force-cache' }),
        delay(500).then(() => { throw new Error('fetch waited for the body before returning headers'); }),
      ]);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), 'prefix');
      first.value.fill(88); // Consumer mutation must not change the cached copy.
      held.resolve();
      let rest = '';
      for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
      assert.equal(rest, 'suffix');
      await flushCacheWork();
    });
    const hit = await textFetch('/stream?gate=headers', { cache: 'force-cache' });
    assert.equal(hit.body, 'prefixsuffix');
    assert.equal(counts.get('/stream'), 1);
  } finally { held.resolve(); }
});

test('large unknown-length responses stream exactly and are never persisted or memoized', async () => {
  for (let run = 0; run < 2; run++) await context(async () => {
    const response = await fetch(originUrl + '/large', { cache: 'force-cache' });
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      assert.ok(chunk.every(value => value === 71));
    }
    assert.equal(total, 40 * 65536);
    await flushCacheWork();
    assert.equal(entries.size, 0);
    assert.equal(currentRequest().cacheState.fetchMemo?.entries.size || 0, 0);
  }, { phase: 'render' });
  assert.equal(counts.get('/large'), 2);
  assert.equal(leases.size, 0);
});

test('aborted fills do not store partial bytes and a later request can fill the same key', async () => {
  const held = gate(); gates.set('abort', held);
  try {
    await context(async () => {
      const controller = new AbortController();
      const response = await fetch(originUrl + '/stream?gate=abort', { cache: 'force-cache', signal: controller.signal });
      const reader = response.body.getReader(); await reader.read();
      controller.abort();
      await assert.rejects(reader.read());
      await flushCacheWork();
      assert.equal(entries.size, 0); assert.equal(leases.size, 0);
    });
    held.resolve();
    assert.equal((await textFetch('/stream?gate=abort', { cache: 'force-cache' })).body, 'prefixsuffix');
    assert.equal(counts.get('/stream'), 2);
  } finally { held.resolve(); }
});

test('an idle cache fill releases its lease while the foreground stream remains readable', async () => {
  const held = gate(); gates.set('idle', held);
  try {
    await context(async () => {
      const response = await fetch(originUrl + '/stream?gate=idle', { cache: 'force-cache' });
      await delay(1100);
      await flushCacheWork();
      assert.equal(entries.size, 0); assert.equal(leases.size, 0);
      held.resolve();
      assert.equal(await response.text(), 'prefixsuffix');
    });
  } finally { held.resolve(); }
});

test('status, cookies, redirects, cache failures and nested cache scopes preserve fetch behavior', async () => {
  for (const url of ['/failure', '/set-cookie']) {
    const first = await textFetch(url, { cache: 'force-cache' });
    const second = await textFetch(url, { cache: 'force-cache' });
    assert.notEqual(first.body, second.body);
    assert.equal(counts.get(url), 2);
  }
  const first = await textFetch('/redirect', { cache: 'force-cache' });
  const second = await textFetch('/redirect', { cache: 'force-cache' });
  assert.equal(first.body, second.body);
  assert.equal(first.response.url, originUrl + '/data?redirected=1');
  assert.equal(second.response.url, first.response.url);
  assert.equal(second.response.redirected, true);
  assert.equal(second.response.status, 200);
  assert.equal(second.response.statusText, 'OK');
  failCommit = true;
  await textFetch('/mutation', { method: 'POST', body: 'once', cache: 'force-cache' });
  assert.equal(counts.get('/mutation'), 1, 'cache commit failure never repeats a mutation');
  await context(() => runCacheScope(async () => {
    await (await fetch(originUrl + '/nested', { cache: 'force-cache' })).text();
    await (await fetch(originUrl + '/nested', { cache: 'force-cache' })).text();
  }));
  assert.equal(counts.get('/nested'), 2);
});

test('installation is idempotent, outside-context fetch stays native and invalid options fail early', async () => {
  assert.equal(installFetchCache(), globalThis.fetch);
  assert.equal(installFetchCache(), globalThis.fetch);
  await (await fetch(originUrl + '/outside', { cache: 'force-cache' })).text();
  await (await fetch(originUrl + '/outside', { cache: 'force-cache' })).text();
  assert.equal(counts.get('/outside'), 2);
  await context(async () => {
    await assert.rejects(fetch(originUrl + '/invalid', { next: { revalidate: -1 } }), /revalidate/);
    await assert.rejects(fetch(originUrl + '/invalid', { next: { tags: 'not-an-array' } }), /tags/);
  });
  assert.equal(counts.has('/invalid'), false);
  for (const value of entries.values()) assert.ok(Buffer.from(value, 'base64').byteLength <= MAX_CACHE_VALUE_BYTES);
});

test('copied runtime installations dispatch to their own active request contexts without fetch recursion', async () => {
  const root = await mkdtemp(fileURLToPath(new URL('./.fetch-copy-', import.meta.url)));
  try {
    await Promise.all(['runtime', 'compat'].map(directory => mkdir(path.join(root, directory))));
    for (const file of ['runtime/fetch-cache.mjs', 'compat/data-cache.cjs', 'compat/incremental-cache.cjs', 'compat/use-cache.cjs', 'compat/cache-handlers.cjs', 'compat/cache-life.cjs', 'compat/headers.cjs', 'compat/cookies.cjs', 'compat/draft.cjs', 'compat/preview.cjs', 'compat/static-generation.cjs', 'compat/instant-samples.cjs']) {
      await copyFile(fileURLToPath(new URL('../' + file, import.meta.url)), path.join(root, file));
    }
    const stagedFetch = await import(pathToFileURL(path.join(root, 'runtime/fetch-cache.mjs')).href);
    const stagedHeaders = await import(pathToFileURL(path.join(root, 'compat/headers.cjs')).href);
    const stagedCache = await import(pathToFileURL(path.join(root, 'compat/data-cache.cjs')).href);
    assert.equal(stagedFetch.installFetchCache(), globalThis.fetch);
    await stagedHeaders.runRequestContext({ phase: 'render', production: true, url: 'http://staged.test/route' }, async () => {
      const first = await fetch(originUrl + '/staged', { cache: 'force-cache', next: { tags: ['staged'] } });
      await first.text(); await stagedCache.flushCacheWork();
      await (await fetch(originUrl + '/staged', { cache: 'force-cache', next: { tags: ['staged'] } })).text();
    });
    assert.equal(counts.get('/staged'), 1);
    assert.ok(operations.some(operation => operation.paths?.includes('page:/route') && operation.tags?.includes('staged')));
    await textFetch('/original', { cache: 'force-cache' });
    await textFetch('/original', { cache: 'force-cache' });
    assert.equal(counts.get('/original'), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
