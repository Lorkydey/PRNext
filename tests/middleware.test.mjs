import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { middlewareFixture } from './middleware-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await middlewareFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
async function get(url, options = {}) {
  const response = await fetch(server.url + url, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...options });
  return { response, text: await response.text() };
}
async function json(url, options) { const result = await get(url, options); return { ...result, data: JSON.parse(result.text) }; }
async function until(check, message = 'middleware did not reach its expected state') {
  for (let index = 0; index < 300; index++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
function state(html, attribute) {
  const value = new RegExp(`<pre ${attribute}>(.*?)</pre>`).exec(html)?.[1];
  assert.ok(value, html.slice(0, 500));
  return JSON.parse(value.replace(/&(?:amp|quot|lt|gt|#x27);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#x27;': "'" })[entity]));
}

test('the build and unmatched cached/static requests never execute the middleware module', async () => {
  assert.equal(fixture.counts.get('boot') || 0, 0);
  const result = await get('/static');
  assert.equal(result.response.status, 200); assert.match(result.text, /Cached application page/);
  assert.equal(result.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.equal(fixture.counts.get('boot') || 0, 0);
  const redirect = await get('/mw/config-redirect');
  assert.equal(redirect.response.status, 307); assert.equal(redirect.response.headers.get('location'), '/static');
  assert.equal(fixture.counts.get('boot') || 0, 0);
});

test('request overrides reach the handler privately and middleware response headers take precedence', async () => {
  const result = await json('/mw/next?from=visitor', { headers: { 'x-remove': 'gone', cookie: 'original=client' } });
  assert.equal(result.response.status, 200); assert.equal(fixture.counts.get('boot'), 1);
  assert.equal(result.data.url, server.url + '/mw/next?from=visitor');
  assert.equal(result.data.headers['x-remove'], undefined);
  assert.equal(result.data.headers['x-added'], 'added');
  assert.equal(result.data.headers['x-shared'], 'middleware');
  assert.equal(result.response.headers.get('x-added'), null);
  assert.equal(result.response.headers.get('x-shared'), 'middleware');
  assert.equal(result.response.headers.get('x-own'), 'handler');
  assert.equal(result.response.headers.get('x-config'), 'yes');
  assert.equal(result.response.headers.get('x-middleware-next'), null);
  assert.equal(result.response.headers.get('x-middleware-override-headers'), null);
  assert.ok(![...result.response.headers.keys()].some(key => key.startsWith('x-middleware-request-')));
});

test('replacement deletes unlisted fields, preserves the original URL and matches empty-list behavior', async () => {
  const headers = { 'x-remove': 'client', cookie: 'original=client' };
  const replaced = await json('/mw/next?mode=replace', { headers });
  assert.equal(replaced.data.url, server.url + '/mw/next?mode=replace');
  assert.equal(replaced.data.headers['x-remove'], undefined);
  assert.equal(replaced.data.headers.cookie, undefined);
  const empty = await json('/mw/next?mode=empty', { headers });
  assert.equal(empty.data.headers['x-remove'], 'client');
  assert.equal(empty.data.headers.cookie, 'original=client');
  const cookie = await json('/mw/next?mode=cookie-override', { headers });
  assert.deepEqual(cookie.data.requestCookies, [{ name: 'original', value: 'override' }]);
});

test('native matchers apply header, cookie, query, missing and negative lookahead conditions', async () => {
  const endpoint = '/conditional/check?go=1';
  assert.equal((await json(endpoint)).data.header, null);
  assert.equal((await json(endpoint, { headers: { 'x-run': 'yes', cookie: 'enabled=1' } })).data.header, 'middleware');
  assert.equal((await json(endpoint, { headers: { 'x-run': 'yes', cookie: 'enabled=1', 'next-router-prefetch': '1' } })).data.header, null);
  assert.equal((await json('/conditional/check?go=2', { headers: { 'x-run': 'yes', cookie: 'enabled=1' } })).data.header, null);
  assert.equal((await json('/negative/include')).data.header, 'middleware');
  assert.equal((await json('/negative/skip')).data.header, null);
});

test('internal request controls cannot skip middleware or inject cookies into unmatched handlers', async () => {
  const headers = { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware', 'x-middleware-next': '1', 'x-middleware-rewrite': '/static', 'x-middleware-set-cookie': 'injected=secret; Path=/' };
  const denied = await json('/mw/guard', { headers });
  assert.equal(denied.response.status, 401); assert.deepEqual(denied.data, { denied: true });
  const direct = await json('/api/plain', { headers });
  assert.deepEqual(direct.data.cookies, []);
  assert.ok(!Object.keys(direct.data.headers).some(key => key.startsWith('x-middleware-')));
});

test('middleware sees normalized request data while internal Flight fields survive downstream overrides', async () => {
  const headers = { RSC: '1', 'next-router-prefetch': '1', 'next-router-state-tree': 'tree', 'next-router-segment-prefetch': '/segment', 'next-hmr-refresh': '1', 'next-url': '/visible' };
  const inspected = await json('/mw/inspect?_rsc=private&visible=yes', { headers });
  assert.equal(inspected.data.url, server.url + '/mw/inspect?visible=yes');
  for (const key of ['rsc', 'next-router-prefetch', 'next-router-state-tree', 'next-router-segment-prefetch', 'next-hmr-refresh']) assert.equal(inspected.data.headers[key], undefined);
  assert.equal(inspected.data.headers['next-url'], '/visible');
  const downstream = await json('/mw/next?mode=replace', { headers });
  for (const [key, value] of Object.entries(headers)) if (key !== 'next-url') assert.equal(downstream.data.headers[key.toLowerCase()], value);
});

test('response cookies merge in order and are visible to App rendering without changing API request cookies', async () => {
  const result = await json('/mw/cookies', { headers: { cookie: 'original=client' } });
  assert.equal(result.response.headers.get('x-middleware-set-cookie'), null);
  const cookies = result.response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  assert.match(cookies[0], /^mwc=fresh;/); assert.match(cookies[1], /^expires=with-date;.*Expires=/); assert.match(cookies[2], /^handler=last;/);
  assert.deepEqual(result.data.requestCookies, [{ name: 'original', value: 'client' }]);
  assert.deepEqual(result.data.ambientCookies.map(({ name, value }) => ({ name, value })), [{ name: 'original', value: 'client' }]);
  const page = await get('/mw/app?visible=visitor', { headers: { cookie: 'original=client' } });
  assert.deepEqual(state(page.text, 'data-testid="server-state"'), { query: { dest: 'middleware' }, header: 'middleware', cookie: 'fresh' });
});

test('middleware rewrites feed beforeFiles rules and preserve original URL semantics', async () => {
  const result = await json('/mw/before?original=visitor');
  assert.equal(result.data.url, server.url + '/mw/before?original=visitor');
  assert.deepEqual(result.data.params, { segments: ['target'] });
  assert.equal(result.response.headers.get('x-middleware-rewrite'), '/chain?phase=middleware');
  const pages = await get('/mw/pages?original=visitor');
  const props = state(pages.text, 'id="pages-state"');
  assert.equal(props.url, '/mw/pages?original=visitor');
  assert.equal(props.resolvedUrl, '/pages-target?original=visitor');
  assert.deepEqual(props.query, { dest: 'middleware' });
  assert.equal(props.headers['x-added'], 'added');
});

test('public files and cached HTML retain middleware headers and per-visitor rewrite metadata', async () => {
  const asset = await get('/mw/asset.txt');
  assert.equal(asset.text, 'public middleware asset'); assert.equal(asset.response.headers.get('x-shared'), 'middleware');
  const page = await get('/mw/static?visible=one');
  assert.equal(page.response.status, 200); assert.equal(page.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(page.response.headers.get('cache-control'), /private.*no-store|no-store.*private/);
  assert.equal(page.response.headers.get('etag'), null);
  assert.match(page.text, /Cached application page/); assert.match(page.text, /__RUSTYX_REWRITE__/);
  const flight = await get('/mw/static?visible=two', { headers: { RSC: '1' } });
  assert.match(flight.response.headers.get('content-type'), /text\/x-component/);
  assert.ok(flight.response.headers.get('x-rustyx-rewrite'));
  assert.equal(flight.response.headers.get('x-nextjs-rewritten-path'), '/static');
});

test('Pages data aliases match their normalized page pathname', async () => {
  for (const prefix of ['_next', '_rustyx']) {
    const result = await json(`/${prefix}/data/${fixture.manifest.buildId}/ssg.json`);
    assert.equal(result.response.status, 200); assert.equal(result.response.headers.get('x-proxy-seen-path'), '/ssg');
    assert.equal(result.data.pageProps.message, 'cached Pages data');
  }
  const redirect = await get(`/_next/data/${fixture.manifest.buildId}/ssg.json?mode=redirect`, { headers: { 'x-nextjs-data': '1' } });
  assert.equal(redirect.response.status, 307);
  assert.equal(redirect.response.headers.get('location'), null);
  assert.equal(redirect.response.headers.get('x-nextjs-redirect'), '/static?redirect=data');
});

test('middleware request cloning preserves POST bytes for downstream handlers and external rewrites', async () => {
  const body = Buffer.from([0, 255, 42, ...Buffer.from('é🚀')]);
  const result = await json('/mw/body', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(result.data.body, body.toString('base64'));
  assert.equal(result.data.headers['x-body-sha'], createHash('sha256').update(body).digest('hex'));
  const external = await json('/mw/external', { method: 'POST', body, headers: { 'x-remove': 'private' } });
  assert.equal(external.data.path, '/upstream?dest=middleware'); assert.equal(external.data.method, 'POST');
  assert.equal(external.data.body, body.toString('base64')); assert.equal(external.data.headers['x-added'], 'added');
  assert.equal(external.data.headers['x-remove'], undefined); assert.equal(external.response.headers.get('x-origin'), 'yes');
});

test('direct responses, HEAD and redirects keep their method and HTTP status semantics', async () => {
  const direct = await get('/mw/direct');
  assert.equal(direct.response.status, 201); assert.equal(direct.text, 'direct response');
  assert.equal(direct.response.headers.get('location'), '/static');
  const head = await get('/mw/direct', { method: 'HEAD' }); assert.equal(head.response.status, 201); assert.equal(head.text, '');
  const priority = await get('/mw/direct-control');
  assert.equal(priority.response.status, 201); assert.equal(priority.text, 'direct response with continuation');
  const redirect = await get('/mw/redirect', { method: 'POST', body: 'preserve method' });
  assert.equal(redirect.response.status, 307); assert.equal(redirect.response.headers.get('location'), '/static?redirect=middleware');
});

test('waitUntil work does not delay downstream handling or the next middleware request', async () => {
  const release = fixture.hold('background');
  try {
    const result = await json('/mw/background');
    assert.equal(result.response.status, 200);
    await until(() => fixture.counts.get('background') === 1);
    assert.equal(fixture.completed.get('background') || 0, 0);
    assert.equal((await json('/mw/next')).response.status, 200);
  } finally { release(); }
  await until(() => fixture.completed.get('background-done') === 1);
  assert.equal((await json('/mw/background-error')).response.status, 200);
  assert.equal((await json('/mw/next')).response.status, 200);
});

test('middleware streams their first bytes before deferred work and support bodies larger than 16 MiB', async () => {
  const release = fixture.hold('stream');
  let reader;
  try {
    const response = await fetch(server.url + '/mw/stream', { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000) });
    reader = response.body.getReader();
    const first = await reader.read(); assert.equal(new TextDecoder().decode(first.value), 'first\n');
    release();
    const chunks = []; for (;;) { const result = await reader.read(); if (result.done) break; chunks.push(Buffer.from(result.value)); }
    assert.equal(Buffer.concat(chunks).toString(), 'last\n');
  } finally { release(); await reader?.cancel(); }
  const response = await fetch(server.url + '/mw/large', { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000) });
  let size = 0; for await (const chunk of response.body) { size += chunk.length; assert.ok(chunk.every(byte => byte === 42)); }
  assert.equal(size, 17 * 1024 * 1024);
});

test('middleware admits a small burst by waiting and releases it after blocked work ends', async () => {
  const release = fixture.hold('gate');
  const pending = Array.from({ length: 5 }, () => get('/mw/gate'));
  for (const promise of pending) promise.catch(() => {});
  let sixth, settled = false;
  try {
    await until(() => fixture.counts.get('gate') >= 1);
    sixth = get('/mw/gate');
    sixth.then(() => { settled = true; }, () => { settled = true; });
    await delay(50);
    assert.equal(settled, false, 'The sixth request waits without being rejected or bypassing the proxy');
  } finally { release(); }
  assert.ok((await Promise.all([...pending, sixth])).every(result => result.response.status === 200));
  assert.equal((await get('/mw/next')).response.status, 200);
});

test('canceling a middleware stream releases its worker without waiting for application work', async () => {
  const release = fixture.hold('stream');
  let reader;
  try {
    const response = await fetch(server.url + '/mw/stream', { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10000) });
    reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first\n');
    await reader.cancel();
    assert.equal((await json('/mw/next')).response.status, 200);
  } finally { release(); await reader?.cancel(); }
});

test('oversized middleware uploads are refused before dispatch and do not retain admission', async () => {
  const result = await get('/mw/body', { method: 'POST', body: Buffer.alloc(8 * 1024 * 1024 + 1, 42) });
  assert.equal(result.response.status, 413);
  assert.equal((await json('/mw/next')).response.status, 200);
});

test('middleware failures are bounded responses and do not expose production exception details', async () => {
  const result = await get('/mw/failure');
  assert.ok(result.response.status >= 500); assert.doesNotMatch(result.text, /private middleware failure/);
  assert.equal((await get('/mw/next')).response.status, 200);
});

test('Server Action origin validation uses the incoming request before middleware replaces its headers', async () => {
  for (const headers of [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await get('/mw/action?mode=replace', { method: 'POST', headers, body: 'ignored' });
    assert.equal(result.response.status, 403);
  }
  const sameOrigin = await get('/mw/action?mode=replace', { method: 'POST', headers: { origin: server.url }, body: 'ignored' });
  assert.notEqual(sameOrigin.response.status, 403);
});
