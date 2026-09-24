import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pagesNavigationFixture } from './pages-navigation-fixture.mjs';
import { startServer } from './support.mjs';
import { pageDataURL } from '../packages/rustyx/runtime/pages-client.mjs';

let fixture, server;
before(async () => { fixture = await pagesNavigationFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
const dataURL = path => pageDataURL(fixture.manifest.buildId, server.url + path);

test('Pages server data executes getServerSideProps per request and retains headers, cookies and query', async () => {
  const response = await fetch(dataURL('/server/http?tag=a&tag=b&cookie=1'), { headers: { cookie: 'person=Ada' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match(response.headers.get('cache-control'), /private/);
  assert.equal(response.headers.get('x-navigation-data'), 'present');
  assert.equal(response.headers.getSetCookie().length, 2);
  const value = await response.json();
  assert.equal(value.__N_SSP, true);
  assert.equal(value.pageProps.person, 'Ada');
  assert.deepEqual(value.pageProps.query, { tag: ['a', 'b'], cookie: '1', slug: 'http' });
  assert.equal(value.pageProps.url, '/_rustyx/data/pages-navigation-fixture/server/http.json?tag=a&tag=b&cookie=1');
  assert.equal(value.pageProps.resolvedUrl, '/server/http?tag=a&tag=b&cookie=1');
  assert.equal(value.__RUSTYX_ROUTER__.pathname, '/server/[slug]');
  assert.equal(value.__RUSTYX_ROUTER__.asPath, '/server/http?tag=a&tag=b&cookie=1');
  const second = await (await fetch(dataURL('/server/http'), { headers: { cookie: 'person=Grace' } })).json();
  assert.equal(second.pageProps.person, 'Grace');
  assert.equal(second.pageProps.count, value.pageProps.count + 1);
});

test('data requests for server and pure Pages do not render their React component', async () => {
  const only = await fetch(dataURL('/data-only'));
  assert.equal(only.status, 200);
  assert.deepEqual((await only.json()).pageProps, { dataOnly: true });
  assert.doesNotMatch(server.output(), /SSR_COMPONENT_SHOULD_NOT_RUN_FOR_DATA/);
  const pure = await (await fetch(dataURL('/other?from=data'))).json();
  assert.deepEqual(pure.pageProps, {});
  assert.equal(pure.__RUSTYX_ROUTER__.pathname, '/other');
  const catchAll = await (await fetch(dataURL('/catch/a/%C3%A9?tag=1&tag=2'))).json();
  assert.equal(catchAll.__RUSTYX_ROUTER__.pathname, '/catch/[[...parts]]');
  assert.deepEqual(catchAll.__RUSTYX_ROUTER__.query.parts, ['a', 'é']);
});

test('Pages data preserves SSG cache selection and blocking generation for fallback routes', async () => {
  for (const pathname of ['/isr/seed', '/isr/new-http']) {
    const first = await fetch(dataURL(pathname));
    assert.equal(first.status, 200);
    const data = await first.json();
    assert.equal(data.__N_SSG, true);
    assert.equal(data.__RUSTYX_ROUTER__.isFallback, false);
    assert.equal(data.pageProps.count, 1);
    const second = await fetch(dataURL(pathname));
    assert.equal(second.headers.get('x-nextjs-cache'), 'HIT');
    assert.equal((await second.json()).pageProps.count, 1);
    const head = await fetch(dataURL(pathname), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('server data redirects and missing pages use JSON while production errors conceal server details', async () => {
  const redirect = await fetch(dataURL('/outcome/redirect'), { redirect: 'manual' });
  assert.equal(redirect.status, 200);
  assert.equal(redirect.headers.get('location'), null);
  assert.equal((await redirect.json()).pageProps.__N_REDIRECT, '/server/redirected?from=data');
  const missing = await fetch(dataURL('/outcome/missing'));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).notFound, true);
  const failure = await fetch(dataURL('/outcome/failed'));
  assert.equal(failure.status, 500);
  assert.doesNotMatch(await failure.text(), /PRIVATE_DATA_FAILURE/);
});

test('data navigation traverses native rewrites and middleware with isolated visible and target URLs', async () => {
  const alias = await fetch(dataURL('/alias/http?collision=visible&tag=a&tag=b'));
  assert.equal(alias.status, 200);
  assert.match(alias.headers.get('cache-control'), /private/);
  const data = await alias.json();
  assert.equal(data.__RUSTYX_ROUTER__.pathname, '/server/[slug]');
  assert.equal(data.pageProps.query.collision, 'target');
  assert.equal(data.pageProps.query.injected, 'rewrite');
  assert.equal(data.pageProps.url, '/_rustyx/data/pages-navigation-fixture/alias/http.json?collision=visible&tag=a&tag=b');
  assert.equal(data.pageProps.resolvedUrl, '/server/http?collision=visible&tag=a&tag=b');
  const middleware = await fetch(dataURL('/via/http?from=middleware'), { headers: { cookie: 'person=Lin' } });
  assert.equal(middleware.status, 200);
  const mediated = await middleware.json();
  assert.equal(mediated.pageProps.person, 'Lin');
  assert.equal(mediated.pageProps.query.injected, 'middleware');
  assert.equal(mediated.pageProps.query.from, 'middleware');
});

test('data endpoints reject obsolete builds, API routes and App Router routes', async () => {
  for (const url of [pageDataURL('obsolete-build', server.url + '/server/http'), dataURL('/api/hello'), dataURL('/app-side')]) {
    const response = await fetch(url);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).notFound, true);
  }
});

test('browser navigation manifest is immutable and only contains public route metadata', async () => {
  const response = await fetch(server.url + '/_rustyx/assets/pages-manifest-' + fixture.manifest.cacheId + '.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /immutable/);
  const text = await response.text();
  assert.doesNotMatch(text, /PRIVATE_DATA_FAILURE|SSR_COMPONENT_SHOULD_NOT_RUN_FOR_DATA|modulePath|\.server\.|node_modules/);
  const manifest = JSON.parse(text);
  assert.equal(manifest.buildId, fixture.manifest.buildId);
  assert.equal(manifest.routes.find(route => route.pattern === '/server/[slug]').ssp, true);
  assert.equal(manifest.routes.find(route => route.pattern === '/isr/[slug]').ssg, true);
  assert.ok(manifest.routes.every(route => route.client.startsWith('/_rustyx/assets/')));
});
