import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { isrFixture } from './isr-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await isrFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
const dataPath = pathname => `/_rustyx/data/${fixture.manifest.buildId}${pathname === '/' ? '/index' : /^\/index(?:\/|$)/.test(pathname) ? '/index' + pathname : pathname}.json`;
async function page(pathname, options) {
  const response = await fetch(server.url + pathname, options);
  return { response, html: await response.text() };
}
async function data(pathname, options) {
  const response = await fetch(server.url + dataPath(pathname), options);
  return { response, data: await response.json() };
}
const revalidate = (pathname, extra = {}) => fetch(server.url + '/api/revalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: pathname, ...extra }), signal: AbortSignal.timeout(8000) });
async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail('ISR did not reach the expected state');
}

test('build seeds serve HTML and Next-shaped JSON directly from the same generation', async () => {
  const result = await page('/seed?from=uncached-query');
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(result.html, /data-testid="reason">build</);
  assert.doesNotMatch(result.html, /uncached-query/);
  const json = await data('/seed');
  assert.equal(json.data.__N_SSG, true);
  assert.equal(json.data.pageProps.count, 1);
  assert.equal(json.data.pageProps.reason, 'build');
  assert.equal(fixture.counts.get('seed'), 1);
  assert.equal((await data('/')).data.pageProps.key, 'index');
  assert.equal((await data('/index')).data.pageProps.key, 'literal-index');
  assert.deepEqual(await (await fetch(server.url + dataPath('/seed').replace('/_rustyx/', '/_next/'))).json(), json.data);
});

test('cold blocking pages coalesce concurrent HTML and JSON fills and exclude caller queries', async () => {
  const release = fixture.hold('blocking/parallel');
  const requests = [page('/blocking/parallel?from=private'), ...Array.from({ length: 4 }, () => data('/blocking/parallel'))];
  try {
    await until(() => fixture.counts.get('blocking/parallel') === 1);
    await delay(75);
    assert.equal(fixture.counts.get('blocking/parallel'), 1);
  } finally { release(); }
  const [html, ...json] = await Promise.all(requests);
  assert.equal(html.response.status, 200);
  assert.doesNotMatch(html.html, /private/);
  assert.ok(json.every(result => result.data.pageProps.count === 1));
  assert.match(html.html, /data-testid="id">parallel</);
  assert.equal((await page('/blocking/parallel')).response.headers.get('x-nextjs-cache'), 'HIT');
});

test('distinct cold-page generation overload returns 503 with a retry hint and releases its queue', async () => {
  const release = fixture.hold('blocking/queued-0');
  const first = page('/blocking/queued-0');
  let others = Promise.resolve([]), overflow;
  try {
    await until(() => fixture.counts.get('blocking/queued-0') === 1);
    others = Promise.all(Array.from({ length: 4 }, (_, index) => page('/blocking/queued-' + (index + 1))));
    await delay(150);
    overflow = await page('/blocking/queued-overflow', { signal: AbortSignal.timeout(2000) });
  } finally {
    release();
    const results = [await first, ...await others];
    assert.ok(results.every(result => result.response.status === 200));
  }
  assert.equal(overflow.response.status, 503);
  assert.equal(overflow.response.headers.get('retry-after'), '1');
  assert.equal((await page('/blocking/queued-overflow')).response.status, 200);
});

test('expired pages serve stale HTML while exactly one regeneration refreshes the HTML/data pair', async () => {
  fixture.values.set('blocking/stale', { revalidate: 1 });
  await page('/blocking/stale');
  await delay(1100);
  fixture.values.set('blocking/stale', { revalidate: 60, value: 7 });
  const release = fixture.hold('blocking/stale');
  try {
    const stale = await page('/blocking/stale', { signal: AbortSignal.timeout(2000) });
    assert.equal(stale.response.headers.get('x-nextjs-cache'), 'STALE');
    assert.match(stale.html, /data-testid="value">0</);
    await until(() => fixture.counts.get('blocking/stale') === 2);
    await Promise.all(Array.from({ length: 6 }, () => page('/blocking/stale')));
    assert.equal(fixture.counts.get('blocking/stale'), 2);
  } finally { release(); }
  await until(async () => (await data('/blocking/stale')).data.pageProps.value === 7);
  assert.match((await page('/blocking/stale')).html, /data-testid="value">7</);
  assert.deepEqual(fixture.reasons.get('blocking/stale'), ['stale', 'stale']);
});

test('failed regeneration preserves the last good page and permits a later retry', async () => {
  fixture.values.set('blocking/failure', { revalidate: 1, value: 3 });
  await page('/blocking/failure');
  await delay(1100);
  fixture.values.set('blocking/failure', { mode: 'error' });
  assert.match((await page('/blocking/failure')).html, /data-testid="value">3</);
  await until(() => fixture.counts.get('blocking/failure') >= 2);
  await delay(50);
  assert.match((await page('/blocking/failure')).html, /data-testid="value">3</);
  fixture.values.set('blocking/failure', { revalidate: false, value: 9 });
  await until(async () => (await data('/blocking/failure')).data.pageProps?.value === 9);
});

test('res.revalidate commits new HTML and JSON before returning, even with a single request worker', async () => {
  fixture.values.set('seed', { value: 11 });
  const response = await revalidate('/seed');
  assert.equal(response.status, 200, await response.text());
  assert.match((await page('/seed')).html, /data-testid="value">11</);
  assert.equal((await data('/seed')).data.pageProps.value, 11);
  assert.equal(fixture.reasons.get('seed').at(-1), 'on-demand');
});

test('on-demand regeneration failure is observable and keeps the published result', async () => {
  fixture.values.set('seed', { mode: 'error' });
  assert.equal((await revalidate('/seed')).status, 500);
  assert.equal((await data('/seed')).data.pageProps.value, 11);
  fixture.values.set('seed', { value: 12 });
  assert.equal((await revalidate('/seed')).status, 200);
});

test('on-demand revalidation supersedes a stale fill that started before the mutation', async () => {
  const key = 'blocking/race';
  fixture.values.set(key, { revalidate: 1 });
  await page('/blocking/race');
  await delay(1100);
  const release = fixture.hold(key);
  let pending;
  try {
    await page('/blocking/race');
    await until(() => fixture.counts.get(key) === 2);
    fixture.values.set(key, { value: 21 });
    pending = revalidate('/blocking/race');
    await delay(40);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await data('/blocking/race')).data.pageProps.value, 21);
  assert.equal(fixture.reasons.get(key).at(-1), 'on-demand');
});

test('runtime pages persist across server restarts and new builds get a new namespace', async () => {
  await page('/blocking/persist');
  await server.close();
  server = await startServer(fixture.root, ['--workers', '1']);
  assert.equal((await data('/blocking/persist')).data.pageProps.count, 1);
  assert.equal((await page('/blocking/persist')).response.headers.get('x-nextjs-cache'), 'HIT');
  assert.equal(fixture.counts.get('blocking/persist'), 1);
  const oldDataPath = dataPath('/blocking/persist');
  await server.close();
  fixture.manifest = await fixture.build();
  server = await startServer(fixture.root, ['--workers', '1']);
  assert.equal((await fetch(server.url + oldDataPath)).status, 404);
  assert.equal((await data('/blocking/persist')).data.pageProps.count, 2);
});

test('fallback:false rejects paths outside the build while onlyGenerated skips unknown pages', async () => {
  assert.equal((await page('/closed/missing')).response.status, 404);
  assert.equal((await data('/closed/missing')).response.status, 404);
  assert.equal((await revalidate('/blocking/not-generated', { onlyGenerated: true })).status, 200);
  assert.equal(fixture.counts.get('blocking/not-generated'), undefined);
  assert.equal((await revalidate('/not-a-route')).status, 500);
});

test('data and revalidation preserve fixed SSR route precedence over a dynamic SSG route', async () => {
  assert.match((await page('/blocking/special')).html, /Specific SSR route/);
  const result = await data('/blocking/special');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.__N_SSP, true);
  assert.equal(result.data.__N_SSG, undefined);
  assert.equal(result.data.__RUSTYX_ROUTER__.pathname, '/blocking/special');
  assert.deepEqual(result.data.pageProps, {});
  assert.equal(result.response.headers.get('x-nextjs-cache'), null);
  assert.equal((await revalidate('/blocking/special')).status, 500);
  assert.equal(fixture.counts.get('blocking/special'), undefined);
});

test('fallback:true returns a shell immediately and its JSON blocks until generation finishes', async () => {
  const release = fixture.hold('fallback/shell');
  let pending;
  try {
    const shell = await page('/fallback/shell', { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(2000) });
    assert.equal(shell.response.status, 200);
    assert.match(shell.html, /data-testid="fallback"/);
    let complete = false;
    pending = data('/fallback/shell').then(result => { complete = true; return result; });
    await until(() => fixture.counts.get('fallback/shell') === 1);
    await delay(50);
    assert.equal(complete, false);
  } finally { release(); }
  assert.equal((await pending).data.pageProps.count, 1);
  assert.doesNotMatch((await page('/fallback/shell')).html, /data-testid="fallback"/);
});

test('crawlers receive the complete generated page for fallback:true', async () => {
  const result = await page('/fallback/crawler', { headers: { 'user-agent': 'Googlebot' } });
  assert.equal(result.response.status, 200);
  assert.doesNotMatch(result.html, /data-testid="fallback"/);
  assert.match(result.html, /data-testid="id">crawler</);
});

test('encoded parameters retain one stable cache identity for HTML and data routes', async () => {
  for (const id of ['caf%C3%A9', 'two%20words', 'a%25b']) {
    const pathname = '/blocking/' + id;
    const first = await page(pathname);
    assert.equal(first.response.status, 200);
    const result = await data(pathname);
    assert.equal(result.data.pageProps.key, 'blocking/' + decodeURIComponent(id));
    assert.equal(result.data.pageProps.count, 1);
    assert.equal((await page(pathname)).response.headers.get('x-nextjs-cache'), 'HIT');
    assert.equal(fixture.counts.get('blocking/' + decodeURIComponent(id)), 1);
  }
});

test('notFound and redirect results are cached and can be regenerated back into pages', async () => {
  for (const mode of ['notFound', 'redirect']) {
    const pathname = '/blocking/' + mode;
    fixture.values.set('blocking/' + mode, { mode });
    const html = await page(pathname, { redirect: 'manual' });
    assert.equal(html.response.status, mode === 'notFound' ? 404 : 307);
    for (const headers of [{ range: 'bytes=0-0' }, { 'if-modified-since': new Date(Date.now() + 365 * 86400_000).toUTCString() }]) {
      const conditional = await page(pathname, { redirect: 'manual', headers });
      assert.equal(conditional.response.status, mode === 'notFound' ? 404 : 307);
      if (mode === 'notFound') {
        const missing = await data(pathname, { headers });
        assert.equal(missing.response.status, 404);
        assert.equal(missing.data.notFound, true);
      }
    }
    const json = await data(pathname);
    if (mode === 'notFound') assert.equal(json.data.notFound, true);
    else assert.equal(json.data.pageProps.__N_REDIRECT, '/target?from=blocking%2Fredirect');
    assert.equal(fixture.counts.get('blocking/' + mode), 1);
    fixture.values.set('blocking/' + mode, { value: 31 });
    assert.equal((await revalidate(pathname)).status, 200);
    assert.equal((await data(pathname)).data.pageProps.value, 31);
  }
});

test('revalidate:0 computes every request without publishing a persistent result', async () => {
  fixture.values.set('blocking/zero', { revalidate: 0 });
  const first = await data('/blocking/zero');
  const second = await data('/blocking/zero');
  assert.equal(second.data.pageProps.count, first.data.pageProps.count + 1);
  assert.match(second.response.headers.get('cache-control'), /no-store/);
});

test('cached pages preserve conditional GET, HEAD and gzip semantics', async () => {
  const original = await page('/blocking/persist');
  const etag = original.response.headers.get('etag');
  assert.ok(etag);
  const conditional = await fetch(server.url + '/blocking/persist', { headers: { 'if-none-match': etag } });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), '');
  const head = await fetch(server.url + '/blocking/persist', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('etag'), etag);
  const compressed = await page('/blocking/persist', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.response.headers.get('content-encoding'), 'gzip');
  assert.match(compressed.response.headers.get('vary'), /accept-encoding/i);
  assert.equal(compressed.html, original.html);
  assert.equal(fixture.counts.get('blocking/persist'), 2);
});

test('development rebuilds run getStaticProps on every request and preserve fallback:false exclusions', async () => {
  await server.close();
  fixture.manifest = await fixture.build(['--dev']);
  server = await startServer(fixture.root, ['--workers', '1']);
  const first = await data('/seed');
  fixture.values.set('seed', { value: 57 });
  const second = await data('/seed');
  assert.equal(second.data.pageProps.count, first.data.pageProps.count + 1);
  assert.equal(second.data.pageProps.value, 57);
  assert.match(second.response.headers.get('cache-control'), /no-store/);
  assert.equal((await page('/closed/dev-missing')).response.status, 404);
  assert.equal(fixture.counts.get('closed/dev-missing'), undefined);
});
