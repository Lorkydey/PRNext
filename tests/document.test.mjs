import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { documentFixture } from './document-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await documentFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });
const get = (pathname, options) => fetch(server.url + '/docs' + pathname, options);
const dataURL = pathname => '/_prnext/data/document-fixture' + pathname + '.json';
function context(html) {
  const encoded = html.match(/<pre id="document-context">(.*?)<\/pre>/s)[1];
  return JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
}
async function assets(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await assets(filename));
    else if (entry.name.endsWith('.js')) files.push(filename);
  }
  return files;
}

test('custom Document is prerendered and static responses need no Node worker', async t => {
  const staticServer = await startServer(fixture.root, ['--node', path.join(fixture.root, 'missing-node')]);
  t.after(staticServer.close);
  const get = pathname => fetch(staticServer.url + '/docs' + pathname);
  const beforeCount = fixture.counts.get('/document');
  for (const pathname of ['/', '/static/seed', '/_document']) {
    const response = await get(pathname);
    assert.equal(response.status, pathname === '/_document' ? 404 : 200);
    const html = await response.text();
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /<html[^>]*lang="fr"[^>]*data-document="class"/);
    assert.match(html, /<body[^>]*class="document-body"/);
    assert.match(html, /id="document-outside"/);
    assert.match(html, /id="document-footer"/);
    assert.equal((html.match(/id="__prnext"/g) || []).length, 1);
    assert.equal((html.match(/window\.__PRNEXT_DATA__=/g) || []).length, 1);
    assert.doesNotMatch(html, /PRIVATE_DOCUMENT_DEPENDENCY/);
  }
  assert.equal(fixture.counts.get('/document'), beforeCount);

});

test('Document collects rendered head and styles, enhances App and Page, and preserves prefixed assets', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /<title[^>]*>Document Home<\/title>/);
  assert.match(html, /name="document-fixed" content="preserved"/);
  assert.match(html, /id="document-collected" data-render-trace="app,page"/);
  assert.equal((html.match(/charset="utf-8"/gi) || []).length, 1);
  assert.equal((html.match(/name="viewport"/g) || []).length, 1);
  assert.match(html, /<script[^>]*nonce="doc-nonce"[^>]*>window\.__PRNEXT_DATA__/);
  assert.match(html, /<script[^>]*type="module"[^>]*src="\/resources\/_prnext\/assets\/[^" ]+"/);
  assert.match(html, /crossorigin="anonymous"/i);
  assert.match(html, /href="\/resources\/_prnext\/assets\/[^" ]+\.css"/);
});

test('Document receives isolated SSR request context and may set response headers', async () => {
  const beforeData = fixture.counts.get('/data-first') || 0;
  const response = await get('/server/first?from=http', { headers: { cookie: 'visitor=first', 'x-document-test': 'first' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-document-hook'), 'first');
  const html = await response.text();
  assert.deepEqual(context(html), { pathname: '/server/[slug]', query: { from: 'http', slug: 'first' }, asPath: '/server/first?from=http', url: '/server/first?from=http', visitor: 'visitor=first', status: 200, hadError: false });
  assert.equal(fixture.counts.get('/data-first'), beforeData + 1);
  const responses = await Promise.all(['alice', 'bob'].map(visitor => get('/server/' + visitor, { headers: { cookie: 'visitor=' + visitor } }).then(response => response.text())));
  for (const [index, visitor] of ['alice', 'bob'].entries()) {
    assert.equal(context(responses[index]).visitor, 'visitor=' + visitor);
    assert.equal(context(responses[index]).query.slug, visitor);
    assert.doesNotMatch(responses[index], new RegExp('visitor=' + (visitor === 'alice' ? 'bob' : 'alice')));
  }
  const rewritten = context(await (await get('/alias/rewritten?from=original')).text());
  assert.deepEqual(rewritten, { pathname: '/server/[slug]', query: { from: 'original', injected: 'rule', slug: 'rewritten' }, asPath: '/alias/rewritten?from=original', url: '/alias/rewritten?from=original', visitor: null, status: 200, hadError: false });
});

test('JSON data requests bypass Document while retaining one data-function call', async () => {
  const beforeCount = fixture.counts.get('/document');
  const response = await get(dataURL('/server/json') + '?from=data', { headers: { 'x-document-test': 'must-not-run' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('x-document-hook'), null);
  const value = await response.json();
  assert.equal(value.pageProps.label, 'Server json');
  assert.equal(fixture.counts.get('/data-json'), 1);
  assert.equal(fixture.counts.get('/document'), beforeCount);
  assert.doesNotMatch(JSON.stringify(value), /documentCount|privateToken|PRIVATE_DOCUMENT_DEPENDENCY/);
});

test('cold ISR and on-demand regeneration render Document with the new page once', async () => {
  const beforeCount = fixture.counts.get('/document');
  const response = await get('/static/cold?from=trigger', { headers: { cookie: 'visitor=cold' } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Static cold/);
  assert.equal(context(html).query.slug, 'cold');
  assert.equal(context(html).asPath, '/static/cold');
  assert.equal(context(html).url, '/static/cold?from=trigger');
  assert.equal(context(html).visitor, 'visitor=cold');
  assert.equal(fixture.counts.get('/static-cold'), 1);
  assert.equal(fixture.counts.get('/document'), beforeCount + 1);
  assert.equal((await get('/api/invalidate', { headers: { cookie: 'visitor=must-not-forward' } })).status, 200);
  const regenerated = await (await get('/static/seed')).text();
  assert.match(regenerated, /data-testid="data-count">2<\/p>/);
  assert.equal(context(regenerated).url, '/static/seed');
  assert.equal(context(regenerated).visitor, null);
  assert.equal(fixture.counts.get('/static-seed'), 2);
  assert.equal(fixture.counts.get('/document'), beforeCount + 2);
});

test('rewritten and JSON-triggered cold generation preserve only the Document request context', async () => {
  const beforeCount = fixture.counts.get('/document');
  const rewritten = context(await (await get('/static-alias/rewritten-cold?from=alias', { headers: { cookie: 'visitor=alias' } })).text());
  assert.deepEqual(rewritten, { pathname: '/static/[slug]', query: { slug: 'rewritten-cold' }, asPath: '/static/rewritten-cold', url: '/static-alias/rewritten-cold?from=alias', visitor: 'visitor=alias', status: 200, hadError: false });
  const dataPath = dataURL('/static/json-cold') + '?from=json';
  const response = await get(dataPath, { headers: { cookie: 'visitor=json' } });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.pageProps.label, 'Static json-cold');
  assert.doesNotMatch(JSON.stringify(json), /visitor=json|documentCount|privateToken/);
  const cached = context(await (await get('/static/json-cold?from=later')).text());
  assert.equal(cached.url, dataPath);
  assert.equal(cached.visitor, 'visitor=json');
  assert.equal(cached.asPath, '/static/json-cold');
  assert.equal(fixture.counts.get('/document'), beforeCount + 2);
  assert.equal(fixture.counts.get('/static-json-cold'), 1);
});

test('coalesced cold visitors share one generation and one Document context', async () => {
  const beforeCount = fixture.counts.get('/document');
  const html = await Promise.all(['left', 'right'].map(visitor => get('/static/coalesced?from=' + visitor, { headers: { cookie: 'visitor=' + visitor } }).then(response => response.text())));
  const first = context(html[0]);
  assert.deepEqual(context(html[1]), first);
  assert.ok(['visitor=left', 'visitor=right'].includes(first.visitor));
  assert.equal(first.url, '/static/coalesced?from=' + first.visitor.split('=')[1]);
  assert.equal(fixture.counts.get('/static-coalesced'), 1);
  assert.equal(fixture.counts.get('/document'), beforeCount + 1);
});

test('custom Document wraps error pages and a failed document hook falls back without leaking the exception', async () => {
  for (const [pathname, status, label] of [['/unknown', 404, 'Custom 404'], ['/server/error', 500, 'Custom 500'], ['/server/broken?documentCrash=1', 500, 'Custom 500']]) {
    const response = await get(pathname);
    assert.equal(response.status, status);
    const html = await response.text();
    assert.match(html, new RegExp(label));
    assert.match(html, /id="document-footer"/);
    assert.doesNotMatch(html, /PRIVATE_DOCUMENT_HOOK_ERROR|PRIVATE_DOCUMENT_PAGE_ERROR/);
  }
});

test('custom Document and its Node imports stay out of all client JavaScript', async () => {
  for (const filename of await assets(path.join(fixture.root, '.prnext/assets'))) {
    assert.doesNotMatch(await readFile(filename, 'utf8'), /PRIVATE_DOCUMENT_DEPENDENCY|PRIVATE_DOCUMENT_HOOK_ERROR|document-collected|node:fs/);
  }
});

test('a functional Document works and leaves App Router root layouts independent', async () => {
  const alternate = await documentFixture({ variant: 'function', mixed: true }); let native;
  try {
    native = await startServer(alternate.root);
    const page = await (await fetch(native.url + '/docs/')).text();
    assert.match(page, /data-document="function"/);
    assert.match(page, /id="document-footer"/);
    const app = await (await fetch(native.url + '/docs/application')).text();
    assert.match(app, /data-app-layout="yes"/);
    assert.doesNotMatch(app, /data-document=|document-footer|document-fixed/);
  } finally { await native?.close(); await alternate.remove(); }
});
