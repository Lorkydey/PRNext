import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentFixture } from './deployment-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await deploymentFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
const get = (pathname, options) => fetch(server.url + pathname, options);
const data = (pathname, namespace = '_prnext') => `/docs/${namespace}/data/deployment-fixture${pathname}.json`;
function pageData(html) { return JSON.parse(JSON.parse(html.match(/window\.__PRNEXT_DATA__=JSON\.parse\((.+?)\);<\/script>/s)[1])); }

test('basePath mounts pages, public files and assets at exact path boundaries', async () => {
  const response = await get('/docs/plain');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /href="\/docs"/);
  assert.match(html, /href="\/docs\/legacy\/one\?from=link"/);
  const asset = html.match(/src="(\/docs\/_prnext\/assets\/[^" ]+\.js)"/)[1];
  assert.equal((await get(asset)).status, 200);
  assert.equal(await (await get('/docs/public.txt')).text(), 'deployed public content');
  for (const outside of ['/plain', '/public.txt', '/docsmith/plain', asset.slice('/docs'.length), data('/plain').slice('/docs'.length)]) {
    assert.equal((await get(outside)).status, 404, outside);
  }
  assert.equal((await get('/docs')).status, 200);
  const trailing = await get('/docs/', { redirect: 'manual' });
  assert.equal(trailing.status, 308);
  assert.equal(trailing.headers.get('location'), '/docs');
});

test('SSR and Pages data expose logical router and request paths under basePath', async () => {
  const response = await get('/docs/legacy/http?from=http');
  assert.equal(response.headers.get('x-configured'), 'yes');
  const ssr = pageData(await response.text());
  assert.equal(ssr.props.url, '/legacy/http?from=http');
  assert.equal(ssr.props.resolvedUrl, '/legacy/http?from=http');
  assert.equal(ssr.router.basePath, '/docs');
  assert.equal(ssr.router.asPath, '/legacy/http?from=http');
  for (const namespace of ['_prnext', '_next']) {
    const response = await get(data('/legacy/http', namespace) + '?from=data');
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.pageProps.url, `/${namespace}/data/deployment-fixture/legacy/http.json?from=data`);
    assert.equal(value.pageProps.resolvedUrl, '/legacy/http?from=data');
    assert.deepEqual(value.__PRNEXT_ROUTER__.query, { from: 'data', slug: 'http' });
    assert.equal(value.__PRNEXT_ROUTER__.basePath, '/docs');
    assert.equal(value.__PRNEXT_ROUTER__.asPath, '/legacy/http?from=data');
  }
});

test('custom routes and middleware preserve visible paths and apply configured basePath rules', async () => {
  for (const [source, injected] of [['alias', 'rule'], ['via', 'middleware']]) {
    const response = await get(data(`/${source}/book`) + '?from=visible');
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.pageProps.url, `/_prnext/data/deployment-fixture/${source}/book.json?from=visible`);
    assert.equal(value.pageProps.resolvedUrl, '/legacy/book?from=visible');
    assert.equal(value.pageProps.query.injected, injected);
    assert.equal(value.__PRNEXT_ROUTER__.asPath, `/${source}/book?from=visible`);
  }
  const outside = await get('/outside-header');
  assert.equal(outside.status, 404);
  assert.equal(outside.headers.get('x-outside'), 'yes');
  const configured = await get('/docs/configured', { redirect: 'manual' });
  assert.equal(configured.headers.get('location'), '/docs/legacy/configured?from=config');
  assert.equal((await get('/configured')).status, 404);
  assert.equal((await get('/outside-redirect', { redirect: 'manual' })).headers.get('location'), 'https://example.test/landing');
});

test('middleware NextURL retains basePath while route handlers receive the routed URL', async () => {
  const value = await (await get('/docs/inspect?from=middleware')).json();
  assert.equal(value.pathname, '/inspect');
  assert.equal(value.basePath, '/docs');
  assert.equal(new URL(value.url).pathname, '/docs/inspect');
  assert.equal(new URL(value.href).pathname, '/docs/inspect');
  assert.equal(new URL(value.clone).pathname, '/docs/legacy/cloned');
  const route = await (await get('/docs/api/url?from=handler')).json();
  assert.equal(route.pathname, '/api/url');
  assert.equal(route.basePath, '');
  assert.equal(new URL(route.url).pathname, '/api/url');
  assert.equal(new URL(route.clone).pathname, '/app/other');
  const api = await (await get('/docs/api/echo?from=api')).json();
  assert.equal(api.url, '/api/echo?from=api');
});

test('GSSP and App redirects prefix internal destinations and respect basePath:false', async () => {
  for (const [source, location] of [['/go/plain', '/docs/plain'], ['/go/prefixed', '/docs/docs/plain'], ['/go/outside', '/outside'], ['/nav-go/plain', '/docs/app'], ['/nav-go/prefixed', '/docs/docs/app']]) {
    const response = await get('/docs' + source, { redirect: 'manual' });
    assert.equal(response.status, 307, source);
    assert.equal(response.headers.get('location'), location, source);
  }
  const result = await (await get(data('/go/plain'))).json();
  assert.equal(result.pageProps.__N_REDIRECT, '/plain');
});

test('SSG generation and cache hits retain basePath in navigation data', async () => {
  for (const pathname of ['/cached/seed', '/cached/generated']) {
    const first = await get(data(pathname));
    assert.equal(first.status, 200);
    const value = await first.json();
    assert.equal(value.__N_SSG, true);
    assert.equal(value.__PRNEXT_ROUTER__.basePath, '/docs');
    assert.equal(value.pageProps.slug, pathname.split('/').at(-1));
    const second = await get(data(pathname));
    assert.equal(second.headers.get('x-nextjs-cache'), 'HIT');
    const head = await get(data(pathname), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('assetPrefix creates an origin asset alias while data and public paths stay under basePath', async () => {
  const prefixed = await deploymentFixture({ assetPrefix: '/resources' });
  let native;
  try {
    native = await startServer(prefixed.root, ['--workers', '1']);
    const html = await (await fetch(native.url + '/docs/plain')).text();
    const source = html.match(/src="(\/resources\/_prnext\/assets\/[^" ]+\.js)"/)[1];
    assert.equal((await fetch(native.url + source)).status, 200);
    assert.equal((await fetch(native.url + source.replace('/resources/', '/docs/'))).status, 200);
    assert.equal((await fetch(native.url + source.replace('/resources/', '/'))).status, 404);
    assert.equal((await fetch(native.url + '/resources/public.txt')).status, 404);
    assert.equal((await fetch(native.url + '/resources/_prnext/data/deployment-fixture/plain.json')).status, 404);
    assert.ok(prefixed.manifest.routes.filter(route => route.client).every(route => route.client.startsWith('/resources/_prnext/assets/')));
  } finally { await native?.close(); await prefixed.remove(); }
});
