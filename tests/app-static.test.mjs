import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { appStaticFixture } from './app-static-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await appStaticFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
async function get(pathname, options) {
  const response = await fetch(server.url + pathname, options);
  return { response, text: await response.text() };
}
const flight = (pathname, options = {}) => get(pathname, { ...options, headers: { ...options.headers, RSC: '1' } });
async function invalidate(body) {
  const response = await fetch(server.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.text());
}
async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail('App static cache did not reach the expected state');
}
const htmlValue = text => Number(/data-testid="value">(\d+)</.exec(text)?.[1]);

test('automatic static generation serves paired HTML and Flight without repeating server work', async () => {
  const page = await get('/?from=private');
  assert.equal(page.response.status, 200);
  assert.equal(page.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(page.text, /data-testid="value">0</);
  assert.doesNotMatch(page.text, /private/);
  const rsc = await flight('/?from=another');
  assert.equal(rsc.response.status, 200);
  assert.match(rsc.response.headers.get('content-type'), /^text\/x-component/);
  assert.equal(rsc.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(rsc.response.headers.get('vary'), /RSC/);
  assert.doesNotMatch(rsc.text, /another/);
  assert.equal(fixture.counts.get('home'), 1);
  assert.ok(fixture.manifest.prerendered.some(page => page.path === '/plain'));
  assert.equal((await get(`/_next/data/${fixture.manifest.buildId}/plain.json`)).response.status, 404);
});

test('nested generators, groups and catch-all parameters produce concrete build paths', async () => {
  for (const [pathname, marker] of [
    ['/nested/a/a-one', 'a:a-one'], ['/nested/b/b-one', 'b:b-one'],
    ['/grouped/a/b', 'a / b'], ['/optional', 'optional root'], ['/optional/hello', 'hello'],
  ]) {
    const result = await get(pathname);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-nextjs-cache'), 'HIT');
    assert.match(result.text, new RegExp(marker));
  }
  assert.equal((await get('/nested/c/c-one')).response.status, 404);
  assert.equal((await get('/closed/missing')).response.status, 404);
  assert.equal((await flight('/closed/missing')).response.status, 404);
});

test('runtime static parameters share one generation across simultaneous HTML and Flight misses', async () => {
  const release = fixture.hold('catalog/parallel');
  const pending = Promise.all([get('/catalog/parallel?from=__RUSTYX_PRIVATE_QUERY_SENTINEL__'), ...Array.from({ length: 4 }, () => flight('/catalog/parallel'))]);
  try {
    await until(() => fixture.counts.get('catalog/parallel') === 1);
    await delay(60);
    assert.equal(fixture.counts.get('catalog/parallel'), 1);
  } finally { release(); }
  const [html, ...rsc] = await pending;
  assert.equal(html.response.status, 200);
  assert.doesNotMatch(html.text, /__RUSTYX_PRIVATE_QUERY_SENTINEL__/);
  assert.ok(rsc.every(result => !result.text.includes('__RUSTYX_PRIVATE_QUERY_SENTINEL__')));
  assert.ok(rsc.every(result => result.response.status === 200));
  assert.match(html.text, /Product parallel \| Static fixture/);
  assert.equal((await get('/catalog/parallel')).response.headers.get('x-nextjs-cache'), 'HIT');
});

test('dynamic request APIs and explicit no-store data bypass the full route cache', async () => {
  for (const marker of ['first', 'second']) {
    const response = await get('/dynamic-cookie', { headers: { 'x-marker': marker, cookie: `marker=${marker}` } });
    assert.match(response.text, new RegExp(`data-testid="request">${marker}:${marker}<`));
    assert.notEqual(response.response.headers.get('x-nextjs-cache'), 'HIT');
    assert.match((await get('/search?from=' + marker)).text, new RegExp(`data-testid="search">${marker}<`));
  }
  const before = fixture.counts.get('uncached') || 0;
  await get('/uncached'); await get('/uncached');
  assert.equal(fixture.counts.get('uncached'), before + 2);
});

test('force-static replaces request inputs with empty values and dynamicParams restrictions survive bailouts', async () => {
  const response = await get('/force-static?from=private', { headers: { 'x-marker': 'private', cookie: 'marker=private' } });
  assert.equal(response.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.doesNotMatch(response.text, /private/);
  assert.match(response.text, /&quot;header&quot;:null/);
  assert.equal((await get('/closed-dynamic/missing')).response.status, 404);
  assert.match((await get('/closed-dynamic/built', { headers: { 'x-marker': 'allowed' } })).text, />allowed</);
  assert.match((await get('/catalog/specific')).text, /Specific dynamic route/);
  assert.equal(fixture.counts.get('catalog/specific'), undefined);
});

test('hard tag invalidation expires build seeds as well as persisted data', async () => {
  fixture.values.set('home', { value: 17 });
  await invalidate({ tag: 'static:home' });
  assert.equal(htmlValue((await get('/')).text), 17);
  assert.match((await flight('/')).text, /"data-testid":"value","children":17/);
  assert.equal((await get('/')).response.headers.get('x-nextjs-cache'), 'HIT');
});

test('path patterns invalidate all matching static pages without evicting unrelated pages', async () => {
  await get('/catalog/parallel');
  const unchanged = fixture.counts.get('closed/built');
  fixture.values.set('catalog/built', { value: 21 });
  fixture.values.set('catalog/parallel', { value: 22 });
  await invalidate({ path: '/catalog/[id]', type: 'page' });
  assert.equal(htmlValue((await get('/catalog/built')).text), 21);
  assert.equal(htmlValue((await get('/catalog/parallel')).text), 22);
  await get('/closed/built');
  assert.equal(fixture.counts.get('closed/built'), unchanged);
});

test('path invalidation refreshes a static page even when it has no data-cache dependencies', async () => {
  const initial = (await get('/plain')).text;
  await invalidate({ path: '/plain' });
  const refreshed = (await get('/plain')).text;
  const value = text => /data-testid="generated">(\d+)</.exec(text)?.[1];
  assert.ok(value(initial));
  assert.notEqual(value(refreshed), value(initial));
  assert.equal(value((await get('/plain')).text), value(refreshed));
});

test('revalidateTag max serves the previous page until a fresh-data regeneration commits', async () => {
  const pathname = '/catalog/stale';
  await get(pathname);
  fixture.values.set('catalog/stale', { value: 31 });
  const release = fixture.hold('catalog/stale');
  try {
    await invalidate({ tag: 'static:catalog/stale', mode: 'stale' });
    const old = await get(pathname, { signal: AbortSignal.timeout(2000) });
    assert.equal(htmlValue(old.text), 0);
    assert.equal(old.response.headers.get('x-nextjs-cache'), 'STALE');
    await until(() => fixture.counts.get('catalog/stale') === 2);
  } finally { release(); }
  await until(async () => htmlValue((await get(pathname)).text) === 31);
});

test('fetch revalidation lowers the full-route lifetime and failed refresh retains the last good page', async () => {
  const pathname = '/ttl/timed';
  await get(pathname);
  await delay(1100);
  fixture.values.set('ttl/timed', { mode: 'error' });
  const stale = await get(pathname);
  assert.equal(stale.response.headers.get('x-nextjs-cache'), 'STALE');
  assert.equal(htmlValue(stale.text), 0);
  await until(() => fixture.counts.get('ttl/timed') >= 2);
  fixture.values.set('ttl/timed', { value: 37 });
  await until(async () => htmlValue((await get(pathname)).text) === 37);
});

test('invalidation during a fill prevents obsolete HTML and Flight from becoming the cached version', async () => {
  const release = fixture.hold('catalog/race');
  const pending = get('/catalog/race');
  try {
    await until(() => fixture.counts.get('catalog/race') === 1);
    fixture.values.set('catalog/race', { value: 41 });
    await invalidate({ tag: 'static:catalog/race' });
  } finally { release(); }
  await pending;
  assert.equal(htmlValue((await get('/catalog/race')).text), 41);
  assert.match((await flight('/catalog/race')).text, /"data-testid":"value","children":41/);
});

test('Server Actions bypass cached GET responses and invalidate the published page', async () => {
  const id = Object.keys(fixture.manifest.app.actions)[0];
  const response = await fetch(server.url, { method: 'POST', headers: { 'Next-Action': id, origin: server.url, 'content-type': 'text/plain' }, body: '[]' });
  assert.equal(response.status, 200);
  const result = await response.text();
  assert.match(result, /"actionResult":\{"key":"home","value":18/);
  assert.equal(htmlValue((await get('/')).text), 18);
});

test('cached notFound, redirects, ETags and HEAD retain their HTTP and Flight semantics', async () => {
  for (const read of [get, flight]) {
    const missing = await read('/missing');
    assert.equal(missing.response.status, 404);
    assert.match(missing.text, /Static missing page/);
    const redirect = await read('/redirect', { redirect: 'manual' });
    if (read === get) {
      assert.equal(redirect.response.status, 307);
      assert.equal(redirect.response.headers.get('location'), '/plain');
    } else {
      assert.equal(redirect.response.status, 200);
      assert.match(redirect.text, /NEXT_REDIRECT;replace;\/plain;307/);
    }
  }
  for (const headers of [{}, { RSC: '1' }]) {
    const initial = await get('/catalog/built', { headers });
    const etag = initial.response.headers.get('etag');
    assert.ok(etag);
    assert.equal((await get('/catalog/built', { headers: { ...headers, 'if-none-match': etag } })).response.status, 304);
    const head = await get('/catalog/built', { method: 'HEAD', headers });
    assert.equal(head.response.status, 200);
    assert.equal(head.text, '');
  }
});

test('runtime generations and invalidations survive native server restarts', async () => {
  const count = fixture.counts.get('catalog/parallel');
  await server.close();
  server = await startServer(fixture.root, ['--workers', '1']);
  assert.equal(htmlValue((await get('/catalog/parallel')).text), 22);
  assert.equal(fixture.counts.get('catalog/parallel'), count);
  fixture.values.set('home', { value: 51 });
  await invalidate({ tag: 'static:home' });
  await server.close();
  server = await startServer(fixture.root, ['--workers', '1']);
  assert.equal(htmlValue((await get('/')).text), 51);
});
