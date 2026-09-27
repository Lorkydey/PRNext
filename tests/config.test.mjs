import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { configFixture } from './config-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
async function start() {
  const old = process.env.CONFIG_FIXTURE_PROCESS;
  process.env.CONFIG_FIXTURE_PROCESS = 'from-process';
  try { return await startServer(fixture.root, ['--workers', '1']); }
  finally { if (old === undefined) delete process.env.CONFIG_FIXTURE_PROCESS; else process.env.CONFIG_FIXTURE_PROCESS = old; }
}
before(async () => { fixture = await configFixture(); server = await start(); });
after(async () => { await server?.close(); await fixture?.remove(); });
async function get(url, options = {}) {
  const response = await fetch(server.url + url, { signal: AbortSignal.timeout(8000), ...options });
  return { response, text: await response.text() };
}
function pre(text, id) {
  const contents = new RegExp(`<pre data-testid="${id}">([^<]*)</pre>`).exec(text)?.[1];
  assert.notEqual(contents, undefined, `missing ${id} in ${text.slice(0, 500)}`);
  return JSON.parse(contents.replace(/&(?:amp|quot|lt|gt|#x27);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#x27;': "'" })[entity]));
}
async function files(folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename)); else result.push(filename);
  }
  return result;
}
async function until(check, message) {
  for (let index = 0; index < 300; index++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}

test('async phase config, environment precedence, public definitions and output options work together', async () => {
  assert.equal(fixture.manifest.buildId, 'config-fixed-build');
  assert.equal(typeof fixture.manifest.cacheId, 'string');
  const env = JSON.parse((await get('/api/env')).text);
  assert.deepEqual(env, { private: 'PRIVATE_CONFIG_FIXTURE_BUILD_ONLY', public: 'public-frozen', config: 'configured-public', order: 'production-local', base: 'base-only', mode: 'production-only', local: 'local-only', expanded: 'production-local-expanded', process: 'from-process' });
  const builtFiles = await files(path.join(fixture.root, '.prnext'));
  assert.ok(builtFiles.some(file => /\/assets\/.*\.js\.map$/.test(file)), 'productionBrowserSourceMaps emits browser maps');
  assert.ok(!builtFiles.some(file => file.endsWith('.gz')), 'compress:false skips build gzip variants');
  const browserFiles = builtFiles.filter(file => /\/assets\/.*\.(?:js|map)$/.test(file));
  const browserSource = (await Promise.all(browserFiles.map(file => readFile(file, 'utf8')))).join('\n');
  assert.ok(browserSource.includes('public-frozen'));
  assert.ok(browserSource.includes('configured-public'));
  assert.ok(!browserSource.includes('PRIVATE_CONFIG_FIXTURE_BUILD_ONLY'));
  for (const url of ['/', '/target/env', '/compressible.txt']) {
    const result = await get(url, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('content-encoding'), null);
    assert.equal(result.response.headers.get('x-powered-by'), null);
    assert.equal(result.response.headers.get('x-configured'), 'yes');
  }
});

test('private environment is reloaded at runtime while browser and server public values remain built', async () => {
  await server.close();
  await fixture.writeRuntimeEnv('PRIVATE_CONFIG_FIXTURE_RUNTIME_ONLY', 'public-changed-after-build');
  server = await start();
  const env = JSON.parse((await get('/api/env')).text);
  assert.equal(env.private, 'PRIVATE_CONFIG_FIXTURE_RUNTIME_ONLY');
  assert.equal(env.public, 'public-frozen');
  assert.equal(env.config, 'configured-public');
  assert.equal(env.process, 'from-process');
  assert.match((await get('/')).text, /data-testid="public-env">public-frozen</);
});

test('redirects retain status, regex and optional/repeated captures, query values and fragments', async () => {
  const temporary = await get('/temporary/123?from=visible&fixed=old&tag=one&tag=two', { redirect: 'manual' });
  assert.equal(temporary.response.status, 307);
  const location = new URL(temporary.response.headers.get('location'), server.url);
  assert.equal(location.pathname, '/target/123');
  assert.equal(location.hash, '#section');
  assert.equal(location.searchParams.get('from'), 'visible');
  assert.equal(location.searchParams.get('fixed'), 'dest');
  assert.deepEqual(location.searchParams.getAll('tag'), ['one', 'two']);
  assert.equal((await get('/temporary/not-a-number', { redirect: 'manual' })).response.status, 404);
  assert.equal((await get('/numeric/456', { redirect: 'manual' })).response.status, 303);
  for (const url of ['/optional', '/optional/value']) {
    const result = await get(url, { redirect: 'manual' });
    assert.equal(result.response.status, 307);
    assert.equal(result.response.headers.get('location'), '/target');
  }
  const repeated = await get('/permanent/a/b%2Fc?from=visible', { redirect: 'manual' });
  assert.equal(repeated.response.status, 308);
  assert.equal(new URL(repeated.response.headers.get('location'), server.url).pathname, '/target/a/b%2Fc');
  assert.equal((await get('/permanent', { redirect: 'manual' })).response.headers.get('location'), '/target');
});

test('custom headers match header, cookie, query and host conditions and later rules override earlier values', async () => {
  const headers = { 'x-trigger': 'yes', cookie: 'session=alice' };
  const match = await get('/headers/book?mode=preview', { headers });
  assert.equal(match.response.status, 200);
  assert.equal(match.response.headers.get('x-order'), 'last');
  assert.equal(match.response.headers.get('x-captures'), 'book|yes|alice|preview|127.0.0.1');
  const blocked = await get('/headers/book?mode=preview', { headers: { ...headers, 'x-disabled': 'yes' } });
  assert.equal(blocked.response.headers.get('x-order'), 'first');
  assert.equal(blocked.response.headers.get('x-captures'), null);
  const noCookie = await get('/headers/book?mode=preview', { headers: { 'x-trigger': 'yes' } });
  assert.equal(noCookie.response.headers.get('x-order'), 'first');
  assert.equal((await get('/headers/book?mode=preview-extra', { headers })).response.headers.get('x-order'), 'first');
  const redirect = await get('/conditional/book', { headers: { 'x-destination': 'chosen' }, redirect: 'manual' });
  assert.equal(redirect.response.status, 307);
  assert.equal(redirect.response.headers.get('location'), '/target/chosen?slug=book');
  assert.equal((await get('/conditional/book', { headers: { 'x-destination': 'chosen', cookie: 'disabled=1' }, redirect: 'manual' })).response.status, 404);
});

test('query existence conditions preserve repeated values while regex conditions inspect the last value', async () => {
  const repeated = await get('/query-presence?tag=one&tag=two', { redirect: 'manual' });
  assert.equal(repeated.response.status, 307);
  const destination = new URL(repeated.response.headers.get('location'), server.url);
  assert.equal(destination.pathname, '/target/one/two');
  assert.equal(destination.searchParams.get('joined'), 'one/two');
  assert.deepEqual(destination.searchParams.getAll('tag'), ['one', 'two']);
  const scalar = await get('/query-presence?tag=single', { redirect: 'manual' });
  assert.equal(scalar.response.status, 307);
  assert.equal(new URL(scalar.response.headers.get('location'), server.url).pathname, '/target/single');
  for (const pathname of ['/query-presence', '/query-presence?tag=']) {
    assert.equal((await get(pathname, { redirect: 'manual' })).response.status, 404);
  }
  const headers = { 'x-trigger': 'yes', cookie: 'session=alice' };
  assert.equal((await get('/headers/book?mode=wrong&mode=preview', { headers })).response.headers.get('x-order'), 'last');
  assert.equal((await get('/headers/book?mode=preview&mode=wrong', { headers })).response.headers.get('x-order'), 'first');
});

test('config cookies accumulate while explicit handler and origin headers retain precedence', async () => {
  const configured = await get('/configured-cookies');
  assert.equal(configured.response.status, 200);
  assert.deepEqual(configured.response.headers.getSetCookie(), ['configured-one=one; Path=/', 'configured-two=two; Path=/']);
  for (const url of ['/api/web-priority', '/api/pages-priority', '/proxy-priority']) {
    const result = await get(url);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-priority'), url === '/proxy-priority' ? 'origin' : 'handler');
    assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(result.response.headers.getSetCookie(), url === '/proxy-priority'
      ? ['proxy=one; Path=/', 'proxy-two=two; HttpOnly; Path=/']
      : ['handler-one=one; Path=/', 'handler-two=two; Path=/']);
    assert.equal(result.response.headers.get('x-configured'), 'yes', 'non-overridden configuration headers still apply');
  }
});

test('beforeFiles rewrites chain and override public files while preserving original Pages request context', async () => {
  const alias = await get('/alias/book?from=visible&collision=visible');
  assert.equal(alias.response.status, 200);
  assert.deepEqual(pre(alias.text, 'pages-data'), {
    url: '/alias/book?from=visible&collision=visible',
    resolvedUrl: '/target/book?from=visible&collision=visible',
    query: { from: 'visible', collision: 'dest', injected: 'dest', slug: 'book' },
  });
  const chained = pre((await get('/chain?from=visible')).text, 'pages-data');
  assert.equal(chained.url, '/chain?from=visible');
  assert.equal(chained.resolvedUrl, '/target/chained?from=visible');
  assert.deepEqual(chained.query, { from: 'visible', first: 'one', second: 'two', slug: 'chained' });
  const override = await get('/override.txt');
  assert.equal(pre(override.text, 'pages-data').query.slug, 'override');
  assert.ok(!override.text.includes('public-before-rewrite'));
  const forwarded = pre((await get('/query-forward/book/extra?original=yes&extra=old')).text, 'pages-data');
  assert.deepEqual(forwarded.query, { original: 'yes', extra: 'extra', picked: 'book', slug: 'forward' });
  const repeated = pre((await get('/repeat-query/a/b')).text, 'pages-data');
  assert.deepEqual(repeated.query, { parts: ['a', 'b'], joined: 'a/b', embedded: 'prefix-ab', slug: 'repeated' });
});

test('fixed routes and public files win before afterFiles; afterFiles wins before dynamic routes and fallback only handles misses', async () => {
  assert.match((await get('/priority/fixed')).text, /Fixed winner/);
  assert.equal((await get('/priority/public')).text, 'public-winner');
  const after = pre((await get('/priority/value')).text, 'pages-data');
  assert.equal(after.query.phase, 'after');
  assert.equal(after.query.slug, 'value');
  const fallback = pre((await get('/unmatched/new')).text, 'pages-data');
  assert.equal(fallback.query.phase, 'fallback');
  const handled = await get('/api/handler-missing');
  assert.equal(handled.response.status, 404);
  assert.deepEqual(JSON.parse(handled.text), { handler: true });
});

test('App server props use rewritten params/query while handler NextRequest retains the original URL', async () => {
  const app = await get('/app-alias/book?from=visible&collision=visible');
  assert.equal(app.response.status, 200);
  assert.deepEqual(pre(app.text, 'app-server-data'), { params: { slug: 'book' }, query: { from: 'visible', collision: 'dest', injected: 'dest' } });
  const handler = JSON.parse((await get('/api-alias/book?from=visible')).text);
  assert.equal(handler.url, server.url + '/api-alias/book?from=visible');
  assert.equal(handler.pathname, '/api-alias/book');
  assert.deepEqual(handler.query, { from: 'visible' });
});

test('cached App aliases use the target cache for HTML and Flight without publishing visitor query data', async () => {
  const first = await get('/cached-alias/built?from=PRIVATE_VISITOR_QUERY');
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(first.text, /data-testid="cached-slug">built</);
  assert.equal(fixture.counts.get('app:built'), 1);
  const direct = await get('/cached/built');
  assert.equal(direct.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.equal(fixture.counts.get('app:built'), 1);
  const flight = await get('/cached-alias/built?from=SECOND_PRIVATE_QUERY', { headers: { RSC: '1' } });
  assert.equal(flight.response.status, 200);
  assert.match(flight.response.headers.get('content-type'), /^text\/x-component/);
  assert.equal(flight.response.headers.get('x-nextjs-cache'), 'HIT');
  const canonicalFlight = await get('/cached/built', { headers: { RSC: '1' } });
  assert.ok(!canonicalFlight.text.includes('PRIVATE_VISITOR_QUERY'));
  assert.ok(!canonicalFlight.text.includes('SECOND_PRIVATE_QUERY'));
});

test('Pages fallback aliases send a shell and data endpoints resolve the rewrite without persisting the visible query', async () => {
  const shell = await get('/fallback-alias/new?from=visible');
  assert.equal(shell.response.status, 200);
  assert.match(shell.text, /data-testid="fallback-loading"/);
  const data = await get(`/_prnext/data/${fixture.manifest.buildId}/fallback-alias/new.json?from=visible`);
  assert.equal(data.response.status, 200);
  const parsed = JSON.parse(data.text);
  assert.equal(parsed.pageProps.key, 'pages:new');
  assert.equal(fixture.counts.get('pages:new'), 1);
  const generated = await get('/fallback/new');
  assert.equal(generated.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.ok(!generated.text.includes('from=visible'));
});

test('rewritten Flight and Pages data metadata remains private and ignores canonical validators', async () => {
  const dataPrefix = `/_prnext/data/${fixture.manifest.buildId}`;
  for (const [canonicalPath, aliasPath, headers] of [
    ['/cached/built', '/private-cached', { RSC: '1' }],
    [`${dataPrefix}/fallback/private-built.json`, `${dataPrefix}/private-fallback.json`, {}],
  ]) {
    const canonical = await get(canonicalPath, { headers });
    assert.equal(canonical.response.status, 200);
    const etag = canonical.response.headers.get('etag');
    assert.ok(etag);
    assert.match(canonical.response.headers.get('cache-control'), /public/);
    for (const session of ['first-user', 'second-user']) {
      const alias = await get(aliasPath, { headers: { ...headers, cookie: `session=${session}`, 'if-none-match': etag, 'if-modified-since': 'Wed, 01 Jan 2100 00:00:00 GMT', range: 'bytes=0-3' } });
      assert.equal(alias.response.status, 200, 'per-request metadata must not reuse a canonical304 or partial response');
      assert.match(alias.response.headers.get('cache-control'), /private/);
      assert.match(alias.response.headers.get('cache-control'), /no-store/);
      for (const name of ['etag', 'last-modified', 'accept-ranges', 'content-range']) assert.equal(alias.response.headers.get(name), null, name);
      const metadata = JSON.parse(decodeURIComponent(alias.response.headers.get('x-prnext-rewrite')));
      assert.equal(new URL(metadata.url, server.url).searchParams.get('session'), session);
      assert.equal(alias.text, canonical.text, 'private metadata must not change the canonical cached body');
      assert.ok(!alias.text.includes(session));
    }
    const after = await get(canonicalPath, { headers });
    assert.equal(after.text, canonical.text);
    assert.equal(after.response.headers.get('etag'), etag);
    assert.match(after.response.headers.get('cache-control'), /public/);
  }
});

test('external rewrites preserve method, bytes, status, cookies and strip connection-specific headers', async () => {
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(server.url + '/proxy/echo?from=visible', { method: 'POST', headers: { 'content-type': 'application/octet-stream', connection: 'keep-alive, x-request-hop', 'x-request-hop': 'remove-me', 'x-forward-this': 'yes', 'x-forwarded-host': 'spoofed.example' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ response, text: Buffer.concat(chunks).toString() })); response.on('error', reject);
    });
    request.on('error', reject); request.end(Buffer.from('posted\0é🚀'));
  });
  assert.equal(result.response.statusCode, 201);
  assert.equal(result.response.headers['x-origin-hop'], undefined);
  assert.deepEqual(result.response.headers['set-cookie'], ['proxy=one; Path=/', 'proxy-two=two; HttpOnly; Path=/']);
  const echoed = JSON.parse(result.text);
  assert.equal(echoed.method, 'POST'); assert.equal(echoed.body, 'posted\0é🚀');
  assert.equal(echoed.url, '/echo?from=visible');
  assert.equal(echoed.headers['x-request-hop'], undefined);
  assert.equal(echoed.headers['x-forward-this'], 'yes');
  assert.equal(echoed.headers.host, new URL(fixture.originUrl).host);
  assert.equal(echoed.headers['x-forwarded-host'], new URL(server.url).host);
  const head = await get('/proxy/echo', { method: 'HEAD' });
  assert.equal(head.response.status, 201); assert.equal(head.text, '');
  const redirect = await get('/proxy/redirect', { redirect: 'manual' });
  assert.equal(redirect.response.status, 302);
  assert.equal(redirect.response.headers.get('location'), '/proxy/final');
  assert.equal(fixture.counts.get('/final'), undefined, 'the proxy does not follow origin redirects');
});

test('external rewrite streams the first bytes before the origin gate opens', async () => {
  const release = fixture.hold('progressive');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Proxy buffered the response')), 5000);
  try {
    const response = await fetch(server.url + '/proxy/stream?key=progressive', { signal: controller.signal, headers: { 'accept-encoding': 'identity' } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first-é\n');
    release(); clearTimeout(timer);
    let rest = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += Buffer.from(value).toString(); }
    assert.equal(rest, 'second-🚀\n');
  } finally { clearTimeout(timer); controller.abort(); release(); }
});

test('external rewrite concurrency remains bounded and a disconnected body releases its slot', async () => {
  const held = [];
  try {
    for (let index = 0; index < 16; index++) {
      const key = `overload-${index}`, release = fixture.hold(key), controller = new AbortController();
      const response = await fetch(server.url + '/proxy/blocked?key=' + key, { signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      assert.ok((await reader.read()).value.length);
      held.push({ release, controller, reader });
    }
    let settled=false;
    const queued = get('/proxy/echo?key=queued').then(result=>{settled=true;return result});
    await delay(60);
    assert.equal(settled,false,'The seventeenth request must wait without contacting the origin');
    assert.equal(fixture.counts.get('queued'), undefined);
    held[0].controller.abort(); await held[0].reader.cancel().catch(() => {}); held[0].release();
    assert.equal((await queued).response.status,201);
    await until(async () => {
      const result = await get('/proxy/echo?key=released');
      return result.response.status === 201;
    }, 'cancelled proxy body did not release capacity');
  } finally {
    for (const item of held) { item.controller.abort(); item.release(); await item.reader.cancel().catch(() => {}); }
  }
});

test('a repeated public build ID uses a new private cache namespace after rebuilding', async () => {
  const first = await get('/cached/runtime-version');
  assert.equal(first.response.status, 200);
  assert.equal(fixture.counts.get('app:runtime-version'), 1);
  const previousCacheId = fixture.manifest.cacheId;
  await server.close();
  fixture.manifest = await fixture.build();
  assert.equal(fixture.manifest.buildId, 'config-fixed-build');
  assert.notEqual(fixture.manifest.cacheId, previousCacheId);
  server = await start();
  const second = await get('/cached/runtime-version');
  assert.equal(second.response.status, 200);
  assert.equal(fixture.counts.get('app:runtime-version'), 2);
  assert.match(second.text, /data-testid="cached-count">2</);
});
