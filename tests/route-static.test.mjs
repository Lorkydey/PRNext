import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { routeStaticFixture } from './route-static-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await routeStaticFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
async function get(url, options = {}) {
  const response = await fetch(server.url + url, { redirect: 'manual', signal: AbortSignal.timeout(8000), ...options });
  return { response, text: await response.text() };
}
const json = async (url, options) => { const result = await get(url, options); return { ...result, data: JSON.parse(result.text) }; };
async function until(check, message = 'handler cache did not reach its expected state') {
  for (let index = 0; index < 300; index++) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
async function invalidate(body) {
  const result = await get('/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(result.response.status, 200, result.text);
}
async function raw(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(server.url + url, { method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(8000, () => request.destroy(new Error('raw handler request timed out')));
    request.on('error', reject); request.end();
  });
}

test('static handlers publish one response body and preserve explicit static opt-in', async () => {
  const seed = fixture.manifest.prerendered.find(page => page.path === '/static/json');
  assert.ok(seed.file.endsWith('.body'));
  assert.equal(seed.dataFile, undefined);
  for (const name of ['/dynamic/default', '/dynamic/request', '/dynamic/late', '/dynamic/caught', '/dynamic/mixed', '/dynamic/status']) {
    assert.ok(!fixture.manifest.prerendered.some(page => page.path === name), name);
  }
  for (const headers of [{}, { RSC: '1' }]) {
    const result = await json('/static/json?private=visitor', { headers });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('x-nextjs-cache'), 'HIT');
    assert.equal(result.response.headers.get('x-handler'), 'static-json');
    assert.match(result.response.headers.get('content-type'), /^application\/json/);
    assert.doesNotMatch(result.text, /visitor|__PRNEXT|Flight/);
  }
  assert.equal(fixture.counts.get('json'), 1);
  assert.deepEqual((await json('/static/path?ignored=true')).data, { pathname: '/static/path', method: 'GET' });
  assert.equal((await get(`/_next/data/${fixture.manifest.buildId}/static/json.json`)).response.status, 404);
});

test('binary handler bodies retain exact bytes, MIME absence and precompressed HEAD metadata', async () => {
  const expected = Buffer.from(Array.from({ length: 16384 }, (_, index) => index % 256));
  const identity = await raw('/static/binary', { headers: { 'accept-encoding': 'identity' } });
  assert.equal(identity.status, 201);
  assert.deepEqual(identity.body, expected);
  const compressed = await raw('/static/binary', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(compressed.body), expected);
  assert.equal(+compressed.headers['content-length'], compressed.body.length);
  const head = await raw('/static/binary', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(head.status, 201);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'gzip');
  assert.equal(head.headers['content-length'], compressed.headers['content-length']);
  const untyped = await raw('/static/no-type');
  assert.deepEqual(untyped.body, Buffer.from([0, 255, 42]));
  assert.equal(untyped.headers['content-type'], undefined);
});

test('already encoded handlers are served without adding another compression layer', async () => {
  const seed = fixture.manifest.prerendered.find(page => page.path === '/static/encoded');
  await assert.rejects(stat(path.join(fixture.root, '.prnext', seed.file + '.gz')), { code: 'ENOENT' });
  const result = await raw('/static/encoded', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(result.body).toString(), 'already encoded handler body '.repeat(512));
});

test('static responses preserve repeated cookies, application cache headers, redirects and bodyless status', async () => {
  const result = await get('/static/cookies', { headers: { 'accept-encoding': 'identity' } });
  assert.equal(result.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.deepEqual(result.response.headers.getSetCookie(), ['first=one; Path=/', 'second=two; HttpOnly; Path=/']);
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  // Native compression uses a weak validator across the available encodings.
  assert.equal(result.response.headers.get('etag'), 'W/"handler-owned"');
  const empty = await raw('/static/empty');
  assert.equal(empty.status, 204); assert.equal(empty.body.length, 0); assert.equal(empty.headers['x-empty'], 'yes');
  const missing = await get('/static/missing');
  assert.equal(missing.response.status, 404); assert.equal(missing.text, 'cached missing');
  assert.equal(missing.response.headers.get('x-nextjs-cache'), 'HIT');
  const redirect = await get('/static/redirect');
  assert.equal(redirect.response.status, 307); assert.equal(redirect.response.headers.get('location'), '/static/json');
});

test('handler rewrites never inject UI hydration metadata or treat RSC as a different representation', async () => {
  const original = await raw('/static/html', { headers: { 'accept-encoding': 'identity' } });
  const alias = await raw('/handler-html?from=private', { headers: { RSC: '1', 'accept-encoding': 'identity' } });
  assert.deepEqual(alias.body, original.body);
  assert.equal(alias.headers['x-prnext-rewrite'], undefined);
  assert.equal(alias.headers['content-type'], 'text/html');
  const result = await json('/handler-alias?from=visible', { headers: { RSC: '1' } });
  assert.equal(result.response.headers.get('x-prnext-rewrite'), null);
  assert.equal(result.data.key, 'json');
});

test('HEAD uses the existing pathname cache and cold HEAD chooses the generated handler response', async () => {
  const built = await raw('/static/head', { method: 'HEAD' });
  assert.equal(built.status, 201); assert.equal(built.headers['x-handler'], 'GET'); assert.equal(built.body.length, 0);
  const cold = await raw('/cold/head-first', { method: 'HEAD' });
  assert.equal(cold.status, 202); assert.equal(cold.headers['x-handler'], 'HEAD'); assert.equal(cold.body.length, 0);
  const subsequent = await get('/cold/head-first');
  assert.equal(subsequent.response.status, 202); assert.equal(subsequent.text, '');
  assert.equal(subsequent.response.headers.get('x-nextjs-cache'), 'HIT');
  const implicit = await raw('/implicit/head-first', { method: 'HEAD' });
  assert.equal(implicit.status, 200); assert.equal(implicit.body.length, 0);
  const preserved = await json('/implicit/head-first');
  assert.equal(preserved.data.method, 'HEAD');
  assert.equal(preserved.data.key, 'implicit/head-first');
  assert.equal(fixture.counts.get('implicit/head-first'), 1);
});

test('closed handler parameters reject missing paths and non-GET methods cannot contaminate the GET cache', async () => {
  assert.deepEqual((await json('/closed/built')).data, { id: 'built' });
  for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) assert.equal((await get('/closed/missing', { method })).response.status, 404);
  assert.equal((await get('/cold/post-first', { method: 'POST' })).response.status, 405);
  const getAfterPost = await json('/cold/post-first');
  assert.equal(getAfterPost.response.status, 201); assert.equal(getAfterPost.data.method, 'GET');
  assert.equal((await get('/static/json', { method: 'POST' })).response.status, 405);
});

test('private Request properties, caught errors and delayed response reads remain dynamic', async () => {
  for (const value of ['first', 'second']) {
    const options = { headers: { 'x-private': value, cookie: 'secret=' + value } };
    const request = await json('/dynamic/request?from=' + value, options);
    assert.equal(request.response.headers.get('x-nextjs-cache'), null);
    assert.deepEqual(request.data, { url: server.url + '/dynamic/request?from=' + value, query: { from: value }, header: value, cookie: value });
    for (const endpoint of ['/dynamic/late', '/dynamic/caught']) {
      const result = await get(endpoint, options);
      assert.equal(result.text, value); assert.equal(result.response.headers.get('x-nextjs-cache'), null);
    }
  }
});

test('force-static sanitizes request data while preserving the canonical pathname', async () => {
  const result = await json('/static/forced?from=secret', { headers: { 'x-private': 'secret', cookie: 'secret=value' } });
  assert.equal(result.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.deepEqual(result.data, { url: 'http://localhost:3000/static/forced', href: 'http://localhost:3000/static/forced', query: [], requestHeader: null, requestCookie: null, header: null, cookie: null });
});

test('default handlers, mixed methods and uncacheable build statuses do not enter the route cache', async () => {
  for (const endpoint of ['/dynamic/default', '/dynamic/mixed', '/dynamic/status']) {
    const first = await json(endpoint), second = await json(endpoint);
    assert.equal(first.response.headers.get('x-nextjs-cache'), null);
    assert.equal(second.data.count, first.data.count + 1);
    if (endpoint.endsWith('/status')) assert.equal(first.response.status, 401);
  }
  const post = await get('/dynamic/mixed', { method: 'POST', body: 'request body é🚀' });
  assert.equal(post.response.status, 201); assert.equal(post.text, 'request body é🚀');
});

test('concurrent cold GET and HEAD requests share one handler generation', async () => {
  const release = fixture.hold('cold/concurrent');
  const first = json('/cold/concurrent?private=first');
  let others;
  try {
    await until(() => fixture.counts.get('cold/concurrent') === 1);
    others = Promise.all([json('/cold/concurrent?private=other'), raw('/cold/concurrent', { method: 'HEAD' }), json('/cold/concurrent')]);
    await delay(30); assert.equal(fixture.counts.get('cold/concurrent'), 1);
  } finally { release(); }
  const [initial, results] = await Promise.all([first, others]);
  assert.equal(initial.response.status, 201);
  assert.ok(results.every(result => (result.response?.status ?? result.status) === 201));
  assert.doesNotMatch(initial.text, /private|first/);
});

test('a build status bailout preserves successful seeds and makes other handler parameters dynamic', async () => {
  const route = fixture.manifest.routes.find(route => route.pattern === '/mixed-status/[id]');
  assert.equal(route.fallback, 'dynamic');
  const built = await json('/mixed-status/ok'), again = await json('/mixed-status/ok');
  assert.equal(built.response.headers.get('x-nextjs-cache'), 'HIT');
  assert.deepEqual(again.data, built.data);
  for (const id of ['bad', 'new']) {
    const first = await json('/mixed-status/' + id), second = await json('/mixed-status/' + id);
    assert.equal(first.response.status, id === 'bad' ? 401 : 200);
    assert.equal(first.response.headers.get('x-nextjs-cache'), null);
    assert.equal(second.data.count, first.data.count + 1);
  }
});

test('dynamic error mode permits cold generation while revalidate alone does not opt dynamic paths in', async () => {
  const first = await json('/error-mode/new'), second = await json('/error-mode/new');
  assert.deepEqual(first.data, { id: 'new' });
  assert.equal(second.response.headers.get('x-nextjs-cache'), 'HIT');
  const dynamic = await json('/revalidate-only/new'), next = await json('/revalidate-only/new');
  assert.equal(dynamic.response.headers.get('x-nextjs-cache'), null);
  assert.equal(next.data.count, dynamic.data.count + 1);
});

test('tag and path invalidation replace build seeds and generated handler bodies', async () => {
  fixture.values.set('json', { value: 25 }); await invalidate({ tag: 'handler:json' });
  assert.equal((await json('/static/json')).data.value, 25);
  fixture.values.set('cold/concurrent', { value: 26 }); await invalidate({ path: '/cold/concurrent' });
  assert.equal((await json('/cold/concurrent')).data.value, 26);
  assert.equal((await get('/cold/concurrent')).response.headers.get('x-nextjs-cache'), 'HIT');
});

test('short fetch lifetimes regenerate stale responses and exceptions retain the last published body', async () => {
  const first = await json('/ttl/check');
  fixture.values.set('ttl/check', { value: 31 });
  await delay(1100);
  const stale = await json('/ttl/check');
  assert.equal(stale.response.headers.get('x-nextjs-cache'), 'STALE');
  assert.deepEqual(stale.data, first.data);
  await until(async () => (await json('/ttl/check')).data.value === 31);
  fixture.values.set('ttl/check', { mode: 'error' }); await delay(1100);
  const good = await json('/ttl/check'); assert.equal(good.data.value, 31);
  await until(() => fixture.counts.get('ttl/check') >= 3);
  assert.equal((await json('/ttl/check')).data.value, 31);
});

test('runtime handler status responses can be cached while thrown failures remain errors', async () => {
  fixture.values.set('status/runtime-error', { status: 500 });
  const first = await json('/status/runtime-error'), next = await json('/status/runtime-error');
  assert.equal(first.response.status, 500); assert.equal(next.response.status, 500);
  assert.equal(next.response.headers.get('x-nextjs-cache'), 'HIT'); assert.deepEqual(next.data, first.data);
});

test('single-body generations and invalidated build seeds survive a native server restart', async () => {
  const first = await json('/cold/concurrent');
  const count = fixture.counts.get('cold/concurrent');
  await server.close(); server = await startServer(fixture.root, ['--workers', '1']);
  const next = await json('/cold/concurrent');
  assert.equal(next.response.headers.get('x-nextjs-cache'), 'HIT'); assert.deepEqual(next.data, first.data);
  assert.equal(fixture.counts.get('cold/concurrent'), count);
  assert.equal((await json('/static/json')).data.value, 25);
  const files = await readdir(path.join(fixture.root, '.prnext-cache/pages/files'));
  assert.ok(files.some(file => file.endsWith('.body')));
  assert.ok(!files.some(file => /\.(?:html|json|txt)$/.test(file)), 'handler-only cache must not create empty companion files');
});
