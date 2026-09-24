import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { cacheFixture } from './cache-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await cacheFixture(); server = await startServer(fixture.root, ['--workers', '2']); });
after(async () => { await server?.close(); await fixture?.remove(); });

async function json(route, options) {
  const response = await fetch(server.url + route, options);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const invalidate = data => json('/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); }
  assert.ok(check(), 'Expected cache operation to reach the external origin');
}

test('concurrent cold requests across Node workers share one native cache fill', async () => {
  const release = fixture.hold('parallel');
  // Fill both sets of sixteen async lanes before releasing the origin.
  const requests = Array.from({ length: 32 }, () => json('/api/data?key=parallel'));
  try {
    await until(() => fixture.counts.get('parallel') === 1);
    await delay(60);
    assert.equal(fixture.counts.get('parallel'), 1);
  } finally { release(); }
  const results = await Promise.all(requests);
  assert.equal(new Set(results.map(result => result.worker)).size, 2);
  assert.equal(new Set(results.map(result => result.producer)).size, 1);
  assert.ok(results.every(result => result.count === 1));
});

test('function and fetch entries persist across a native server restart and a rebuild', async () => {
  const data = await json('/api/data?key=persist');
  const fetched = await json('/api/fetch?key=persist-fetch');
  await server.close();
  await fixture.build();
  server = await startServer(fixture.root, ['--workers', '2']);
  assert.deepEqual((({ worker, ...entry }) => entry)(await json('/api/data?key=persist')), (({ worker, ...entry }) => entry)(data));
  assert.equal((await json('/api/fetch?key=persist-fetch')).count, fetched.count);
  assert.equal(fixture.counts.get('persist'), 1);
  assert.equal(fixture.counts.get('persist-fetch'), 1);
});

test('fetch cache keys separate credentials and tag invalidation is committed before the response', async () => {
  const a = await json('/api/fetch?key=auth', { headers: { authorization: 'Bearer a' } });
  const b = await json('/api/fetch?key=auth', { headers: { authorization: 'Bearer b' } });
  assert.equal(a.authorization, 'Bearer a');
  assert.equal(b.authorization, 'Bearer b');
  assert.equal((await json('/api/fetch?key=auth', { headers: { authorization: 'Bearer a' } })).count, a.count);
  fixture.values.set('auth', 7);
  await invalidate({ tag: 'fetch:auth' });
  assert.equal((await json('/api/fetch?key=auth', { headers: { authorization: 'Bearer a' } })).value, 7);
});

test('path invalidation refreshes data accessed by that route and preserves unrelated fetch entries', async () => {
  await json('/api/data?key=path');
  const untouched = await json('/api/fetch?key=unrelated');
  fixture.values.set('path', 9);
  await invalidate({ path: '/api/data' });
  assert.equal((await json('/api/data?key=path')).value, 9);
  assert.equal((await json('/api/fetch?key=unrelated')).count, untouched.count);
});

test('stale-while-revalidate returns old data before a gated refresh finishes', async () => {
  const old = await json('/api/data?key=stale');
  fixture.values.set('stale', 11);
  const release = fixture.hold('stale');
  try {
    await invalidate({ tag: 'functions', mode: 'stale' });
    const response = await json('/api/data?key=stale', { signal: AbortSignal.timeout(2000) });
    assert.equal(response.value, old.value);
    await until(() => fixture.counts.get('stale') === 2);
  } finally { release(); }
  for (let i = 0; i < 50; i++) {
    const current = await json('/api/data?key=stale');
    if (current.value === 11) return;
    await delay(10);
  }
  assert.fail('The refreshed value was never committed');
});

test('hard invalidation during a fill prevents its obsolete result from repopulating the cache', async () => {
  const release = fixture.hold('race');
  const first = json('/api/data?key=race');
  try {
    await until(() => fixture.counts.get('race') === 1);
    fixture.values.set('race', 13);
    await invalidate({ tag: 'functions' });
  } finally { release(); }
  await first;
  assert.equal((await json('/api/data?key=race')).value, 13);
});

test('Server Action updateTag reads fresh data immediately and updates the returned component tree', async () => {
  await (await fetch(server.url)).text();
  const manifest = JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
  const id = Object.keys(manifest.app.actions)[0];
  const response = await fetch(server.url, { method: 'POST', headers: { 'Next-Action': id, origin: server.url, 'content-type': 'text/plain' }, body: '[]' });
  assert.equal(response.status, 200);
  const flight = await response.text();
  assert.match(flight, /"actionResult":\{"key":"page","value":1/);
  assert.match(await (await fetch(server.url)).text(), /data-testid="cached-value">1</);
  const invalid = await fetch(server.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update: 'functions' }) });
  assert.equal(invalid.status, 500, 'updateTag is restricted to Server Actions');
});

test('GET fetch memoization shares data across Server Components for one render only', async () => {
  for (let index = 1; index <= 2; index++) {
    const response = await fetch(server.url + '/memo');
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(fixture.counts.get('memo'), index);
  }
});

test('force-dynamic layouts and force-no-store handlers override explicit fetch caching', async () => {
  for (let index = 1; index <= 2; index++) {
    assert.equal((await json('/api/forced')).count, index);
    const response = await fetch(server.url + '/forced');
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(fixture.counts.get('forced-page'), index);
  }
});

test('a dynamic page pattern invalidates its visited URLs while preserving other routes', async () => {
  for (const id of ['alpha', 'beta']) await (await fetch(server.url + '/catalog/' + id)).text();
  const untouched = await json('/api/fetch?key=pattern-control');
  fixture.values.set('catalog-alpha', 21);
  fixture.values.set('catalog-beta', 22);
  await invalidate({ path: '/catalog/[id]', type: 'page' });
  for (const [id, value] of [['alpha', 21], ['beta', 22]]) {
    assert.match(await (await fetch(server.url + '/catalog/' + id)).text(), new RegExp(`data-testid="catalog-value">${value}<`));
  }
  assert.equal((await json('/api/fetch?key=pattern-control')).count, untouched.count);
});
