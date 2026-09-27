import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initialPropsFixture } from './initial-props-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await initialPropsFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
const get = (pathname, options) => fetch(server.url + '/docs' + pathname, options);
const dataURL = pathname => '/_prnext/data/initial-props' + pathname + '.json';
function props(html, id) {
  const encoded = html.match(new RegExp(`<pre data-testid="${id}">(.*?)<\\/pre>`, 's'))[1];
  return JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
}

test('custom App getInitialProps disables automatic static pages while explicit GSP stays compiled', () => {
  assert.ok(!fixture.manifest.prerendered.some(page => ['/', '/plain'].includes(page.path)));
  assert.ok(fixture.manifest.prerendered.some(page => page.path === '/static/seed'));
  assert.ok(!fixture.manifest.prerendered.some(page => page.path.startsWith('/legacy/')));
  assert.equal(fixture.counts.get('page:seed:server'), undefined);
});

test('Page and App initial props compose once per SSR request with isolated request context', async () => {
  const appBefore = fixture.counts.get('app:/legacy/[slug]:server') || 0;
  const response = await get('/legacy/http?from=first&tag=a&tag=b', { headers: { cookie: 'visitor=http' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-page-initial-props'), 'yes');
  const html = await response.text(), page = props(html, 'page-props'), app = props(html, 'app-props');
  assert.equal(page.label, 'Legacy http');
  assert.equal(page.pageSource, 'server');
  assert.equal(page.count, 1);
  assert.equal(Object.hasOwn(page, 'omitted'), false);
  assert.deepEqual(page.seen, { pathname: '/legacy/[slug]', query: { from: 'first', tag: ['a', 'b'], slug: 'http' }, asPath: '/legacy/http?from=first&tag=a&tag=b', server: true, url: '/legacy/http?from=first&tag=a&tag=b', status: 200, visitor: 'visitor=http', hadError: false, AppTree: 'function' });
  assert.equal(app.appSource, 'server');
  assert.equal(app.appCount, appBefore + 1);
  assert.equal(app.appContext.pathname, page.seen.pathname);
  assert.equal(app.appContext.routerPath, '/legacy/[slug]');
  assert.equal(app.appContext.AppTree, 'function');
  const another = props(await (await get('/legacy/http?from=second', { headers: { cookie: 'visitor=second' } })).text(), 'page-props');
  assert.equal(another.count, 2);
  assert.equal(another.seen.visitor, 'visitor=second');
  assert.equal(fixture.counts.get('page:http:server'), 2);
});

test('custom App controls Page hook delegation and receives props even for plain pages', async () => {
  const before = fixture.counts.get('page:skipped:server');
  const html = await (await get('/legacy/skipped?skipPage=1')).text();
  assert.equal(props(html, 'page-props').label, 'App selected');
  assert.equal(props(html, 'app-props').appSource, 'server');
  assert.equal(fixture.counts.get('page:skipped:server'), before);
  const plain = await (await get('/plain?from=plain')).text();
  assert.equal(props(plain, 'app-props').appContext.pathname, '/plain');
  assert.match(plain, /Plain/);
});

test('direct data URLs for legacy hooks render HTML with the original data request context', async () => {
  const pathname = dataURL('/legacy/direct-data') + '?from=data';
  const response = await get(pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  const page = props(html, 'page-props');
  assert.equal(page.label, 'Legacy direct-data');
  assert.equal(page.seen.url, pathname);
  assert.equal(page.seen.asPath, '/legacy/direct-data?from=data');
  assert.match(html, /data-document-context=/);
  assert.equal(fixture.counts.get('page:direct-data:server'), 1);
});

test('App initial props accompany GSSP data without rendering Document or the page', async () => {
  const before = fixture.counts.get('app:/server/[slug]:server') || 0;
  const response = await get(dataURL('/server/json') + '?from=data', { headers: { cookie: 'visitor=json' } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pageProps.label, 'Server json');
  assert.equal(data.pageProps.dataSource, 'gssp');
  assert.equal(data.pageProps.fromApp, 'app-marker');
  assert.equal(data.pageProps.shared, 'gssp');
  assert.equal(Object.hasOwn(data.pageProps, 'appOptional'), false);
  assert.equal(data.pageProps.visitor, 'visitor=json');
  assert.equal(data.appSource, 'server');
  assert.equal(data.appCount, before + 1);
  assert.equal(data.appContext.server, true);
  assert.equal(fixture.counts.get('gssp:json'), 1);
  assert.doesNotMatch(JSON.stringify(data), /data-document-context|__prnext/);
});

test('App initial props are generated with static data and refreshed together by ISR', async () => {
  const before = fixture.counts.get('app:/static/[slug]:server');
  const seedResponse = await get(dataURL('/static/seed'));
  assert.equal(seedResponse.status, 200);
  const seed = await seedResponse.json();
  assert.equal(seed.pageProps.count, 1);
  assert.equal(seed.pageProps.fromApp, 'app-marker');
  assert.equal(seed.pageProps.shared, 'gsp');
  assert.equal(seed.appSource, 'server');
  assert.equal(seed.appContext.query.slug, 'seed');
  await get('/static/seed?ignored=yes');
  assert.equal(fixture.counts.get('app:/static/[slug]:server'), before);
  const coldPath = dataURL('/static/cold') + '?from=first';
  const cold = await (await get(coldPath, { headers: { cookie: 'visitor=cold' } })).json();
  assert.equal(cold.pageProps.label, 'Static cold');
  assert.equal(cold.appSource, 'server');
  assert.equal(cold.appContext.visitor, 'visitor=cold');
  assert.equal(cold.appContext.url, coldPath);
  assert.equal(cold.appContext.asPath, '/static/cold');
  assert.deepEqual(cold.appContext.query, { slug: 'cold' });
  assert.equal(fixture.counts.get('gsp:cold'), 1);
  assert.equal((await get('/api/invalidate')).status, 200);
  const refreshed = await (await get(dataURL('/static/seed'))).json();
  assert.equal(refreshed.pageProps.count, 2);
  assert.ok(refreshed.appCount > seed.appCount);
  assert.equal(refreshed.appContext.visitor, null);
});

test('an explicit initial-props response and hook exceptions follow the Pages response contract', async () => {
  const ended = await get('/legacy/ended');
  assert.equal(ended.status, 202);
  assert.equal(await ended.text(), 'Legacy explicit response');
  const redirected = await get('/legacy/redirected', { redirect: 'manual' });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), '/docs/legacy/redirect-target?from=hook');
  assert.equal(redirected.headers.get('x-prnext-legacy-navigation'), null);
  assert.equal(redirected.headers.get('x-prnext-legacy-location'), null);
  assert.match(redirected.headers.get('set-cookie'), /legacy=redirected/);
  const failed = await get('/legacy/failure');
  assert.equal(failed.status, 500);
  const html = await failed.text();
  assert.match(html, /Custom 500/);
  assert.doesNotMatch(html, /LEGACY_HOOK_ERROR/);
});

for (const customApp of [false, 'inherited']) test(`Page hooks work with ${customApp === false ? 'an App without a hook' : 'the inherited default App hook'} while plain pages remain static`, async () => {
  const alternate = await initialPropsFixture({ customApp }); let native;
  try {
    assert.ok(alternate.manifest.prerendered.some(page => page.path === '/'));
    assert.ok(alternate.manifest.prerendered.some(page => page.path === '/plain'));
    native = await startServer(alternate.root);
    const response = await fetch(native.url + '/docs/legacy/independent');
    assert.equal(response.status, 200);
    assert.equal(props(await response.text(), 'page-props').pageSource, 'server');
    assert.equal(alternate.counts.get('page:independent:server'), 1);
  } finally { await native?.close(); await alternate.remove(); }
});
