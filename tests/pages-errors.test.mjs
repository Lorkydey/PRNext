import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pagesErrorsFixture } from './pages-errors-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await pagesErrorsFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
const get = (pathname, options) => fetch(server.url + '/docs' + pathname, options);
const dataURL = pathname => '/_rustyx/data/pages-errors' + pathname + '.json';
function pageData(html) { return JSON.parse(JSON.parse(html.match(/window\.__RUSTYX_DATA__=JSON\.parse\((.+?)\);<\/script>/s)[1])); }
async function workerCount(native) {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=']);
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === native.child.pid).length;
}

test('unknown Pages paths serve the compiled 404 without a Node worker or per-request generation', async () => {
  assert.equal(await workerCount(server), 0);
  for (const pathname of ['/unknown?from=http', '/_error', '/static/absent', '/static/missing-seed', '/404']) {
    const response = await get(pathname);
    assert.equal(response.status, 404, pathname);
    const html = await response.text();
    assert.match(html, /Custom 404/);
    const value = pageData(html);
    assert.equal(value.props.label, 'static-404');
    assert.equal(value.props.count, 1);
    assert.equal(value.router.pathname, '/404');
    assert.match(html, /\/resources\/_rustyx\/assets\//);
  }
  assert.equal(fixture.counts.get('/error-404'), 1);
  assert.equal(await workerCount(server), 0);
  const head = await get('/unknown', { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(head.headers.get('x-error-routing'), 'configured');
  assert.equal(await head.text(), '');
});

test('notFound uses custom 404 HTML and keeps the JSON data protocol', async () => {
  for (const pathname of ['/outcome/missing?from=http', '/alias-missing?from=alias']) {
    const response = await get(pathname);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-data-function'), 'reached');
    const value = pageData(await response.text());
    assert.equal(value.props.label, 'static-404');
  }
  for (const pathname of ['/outcome/missing', '/static/missing-seed', '/static/absent', '/fallback/generated']) {
    const response = await get(dataURL(pathname));
    assert.equal(response.status, 404, pathname);
    assert.equal((await response.json()).notFound, true);
  }
  const directData = await get(dataURL('/404'));
  assert.equal(directData.status, 200);
  assert.equal((await directData.json()).pageProps.label, 'static-404');
});

test('server data and render exceptions use custom 500, retaining explicit application responses', async () => {
  for (const pathname of ['/outcome/data', '/outcome/render', '/regenerate/failed', '/500', dataURL('/outcome/data'), dataURL('/regenerate/failed-data'), dataURL('/500')]) {
    const response = await get(pathname);
    assert.equal(response.status, 500, pathname);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Custom 500/);
    assert.doesNotMatch(html, /PRIVATE_SERVER_DATA_ERROR|PRIVATE_RENDER_ERROR|PRIVATE_GSP_ERROR/);
    assert.equal(pageData(html).props.label, 'static-500');
  }
  assert.equal(fixture.counts.get('/error-500'), 1);
  assert.equal(fixture.counts.get('/generation-failed'), 1);
  assert.equal(fixture.counts.get('/generation-failed-data'), 1);
  const status = await get('/outcome/status');
  assert.equal(status.status, 418);
  assert.match(await status.text(), /Outcome/);
  const explicit = await get('/outcome/explicit');
  assert.equal(explicit.status, 404);
  assert.equal(await explicit.text(), 'EXPLICIT_APPLICATION_RESPONSE');
  const head = await get('/outcome/data', { method: 'HEAD' });
  assert.equal(head.status, 500);
  assert.equal(await head.text(), '');
});

test('error pages do not replace API responses or expose server exceptions', async () => {
  const missing = await get('/api/problem?missing=1');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { kind: 'api404' });
  const failure = await get('/api/problem');
  assert.equal(failure.status, 500);
  const body = await failure.text();
  assert.doesNotMatch(body, /Custom 500|PRIVATE_API_ERROR/);
});

test('404 data and HTML share regenerated static props after res.revalidate', async () => {
  const response = await get('/api/invalidate');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const html = await get('/unknown?after=invalidation');
  assert.equal(html.status, 404);
  assert.equal(pageData(await html.text()).props.count, 2);
  const data = await get(dataURL('/404'));
  assert.equal(data.status, 200);
  assert.equal((await data.json()).pageProps.count, 2);
});

test('next/error can be imported as a normal component with an explicit status and title', async () => {
  const response = await get('/builtin');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /403/);
  assert.match(html, /Application says no/);
});

test('revalidate:0 computes a custom 404 exactly once for each request', async () => {
  const uncached = await pagesErrorsFixture({ revalidate: 0 }); let native;
  try {
    native = await startServer(uncached.root, ['--workers', '1']);
    const initial = uncached.counts.get('/error-404');
    for (const [index, pathname] of ['/404', '/404', '/unknown', '/outcome/missing'].entries()) {
      const response = await fetch(native.url + '/docs' + pathname);
      assert.equal(response.status, 404);
      const expected = initial + index + 1;
      assert.equal(pageData(await response.text()).props.count, expected);
      assert.equal(uncached.counts.get('/error-404'), expected);
    }
  } finally { await native?.close(); await uncached.remove(); }
});

test('custom _error gets the visible request context per request without leaking framework error details', async () => {
  const custom = await pagesErrorsFixture({ staticErrors: false }); let native;
  try {
    native = await startServer(custom.root, ['--workers', '1']);
    for (const [pathname, statusCode, hadError, errorKind] of [['/unknown?from=one', 404, false], ['/outcome/missing?from=two', 404, false], ['/outcome/data?from=three', 500, true, 'data'], ['/outcome/render?from=four', 500, true, 'render'], ['/regenerate/failed-custom?from=five', 500, true, 'generation']]) {
      const response = await fetch(native.url + '/docs' + pathname, { headers: { cookie: 'visitor=' + statusCode } });
      assert.equal(response.status, statusCode);
      assert.match(response.headers.get('cache-control'), /private|no-store/);
      const html = await response.text(), initial = pageData(html);
      assert.equal(initial.router.pathname, '/_error');
      assert.equal(initial.router.asPath, pathname);
      assert.equal(initial.props.statusCode, statusCode);
      assert.equal(initial.props.seen.pathname, '/_error');
      assert.equal(initial.props.seen.asPath, pathname);
      assert.equal(initial.props.seen.url, pathname);
      assert.equal(initial.props.seen.res, statusCode);
      assert.equal(initial.props.seen.hadError, hadError);
      assert.equal(initial.props.seen.errorKind, errorKind);
      assert.equal(initial.props.seen.server, true);
      assert.equal(initial.props.seen.visitor, 'visitor=' + statusCode);
      assert.equal(initial.props.seen.query.mode, undefined);
      assert.doesNotMatch(html, /PRIVATE_SERVER_DATA_ERROR|PRIVATE_RENDER_ERROR|PRIVATE_GSP_ERROR/);
    }
    assert.equal(custom.counts.get('/generation-failed-custom'), 1);
    const [first, second] = await Promise.all(['Ada', 'Grace'].map(visitor => fetch(native.url + '/docs/unknown', { headers: { cookie: 'visitor=' + visitor } }).then(response => response.text()).then(pageData)));
    assert.equal(first.props.seen.visitor, 'visitor=Ada');
    assert.equal(second.props.seen.visitor, 'visitor=Grace');
  } finally { await native?.close(); await custom.remove(); }
});

test('a broken custom _error is bounded and falls back to a generic 500', async () => {
  const broken = await pagesErrorsFixture({ staticErrors: false, brokenError: true }); let native;
  try {
    native = await startServer(broken.root, ['--workers', '1']);
    const response = await fetch(native.url + '/docs/outcome/data');
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /PRIVATE_SERVER_DATA_ERROR|PRIVATE_BROKEN_ERROR_PAGE/);
    assert.equal((await fetch(native.url + '/docs')).status, 200);
  } finally { await native?.close(); await broken.remove(); }
});

test('App root not-found has priority over Pages 404 while Pages server errors retain Pages 500', async () => {
  const mixed = await pagesErrorsFixture({ mixed: true }); let native;
  try {
    native = await startServer(mixed.root, ['--workers', '1']);
    for (const pathname of ['/unknown', '/outcome/missing', '/static/missing-seed', '/static/absent', '/404', '/application-missing']) {
      const response = await fetch(native.url + '/docs' + pathname);
      assert.equal(response.status, 404, pathname);
      assert.match(await response.text(), /App global missing/);
    }
    const error = await fetch(native.url + '/docs/outcome/data');
    assert.equal(error.status, 500);
    assert.match(await error.text(), /Custom 500/);
  } finally { await native?.close(); await mixed.remove(); }
});

test('built-in error pages are static when custom files are absent', async () => {
  const builtin = await pagesErrorsFixture({ staticErrors: false, customError: false }); let native;
  try {
    native = await startServer(builtin.root, ['--workers', '1']);
    const response = await fetch(native.url + '/docs/unknown');
    assert.equal(response.status, 404);
    assert.match(await response.text(), /404/);
    assert.equal(await workerCount(native), 0);
    const failed = await fetch(native.url + '/docs/outcome/data');
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /PRIVATE_SERVER_DATA_ERROR/);
  } finally { await native?.close(); await builtin.remove(); }
});
