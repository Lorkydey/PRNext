import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dynamicFixture } from './dynamic-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await dynamicFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
after(async () => { await server?.close(); await fixture?.remove(); });

function pageData(html) {
  const match = /window\.__PRNEXT_DATA__=JSON\.parse\((.*?)\);<\/script>/s.exec(html);
  assert.ok(match, 'Pages HTML contains bootstrap data');
  return JSON.parse(JSON.parse(match[1]));
}

test('Pages dynamic components render with props and selective hydration metadata', async () => {
  const response = await fetch(server.url + '/dynamic-pages?name=SSR');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-testid="pages-initial-count">PAGES_DYNAMIC_INITIAL <!-- -->SSR<!-- --> <!-- -->0<\/button>/);
  assert.match(html, /data-testid="pages-browser-loading"/);
  assert.doesNotMatch(html, /PAGES_DYNAMIC_CONDITIONAL|BROWSER_DYNAMIC_ONLY/);
  const data = pageData(html);
  assert.equal(data.props.name, 'SSR');
  assert.equal(data.dynamicIds.length, 1, 'only the rendered SSR component is selected for hydration');
  assert.equal(new Set(data.dynamicIds).size, data.dynamicIds.length);
  assert.ok(data.dynamicIds.every(id => typeof id === 'string'));
});

test('object loaders, nested dynamic modules and static generation include complete HTML', async () => {
  for (const [pathname, name, count] of [['/dynamic-static', 'static', 1], ['/dynamic-nested', 'nested', 2]]) {
    const response = await fetch(server.url + pathname);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp('PAGES_DYNAMIC_INITIAL <!-- -->' + name));
    assert.equal(pageData(html).dynamicIds.length, count);
    if (pathname === '/dynamic-static') assert.equal(response.headers.get('x-nextjs-cache'), 'HIT');
  }
});

test('App Client Components render dynamic SSR content and a client-only fallback without importing window modules', async () => {
  const response = await fetch(server.url + '/app-dynamic');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /APP_DYNAMIC_INITIAL/);
  assert.match(html, /data-testid="app-browser-loading"/);
  assert.doesNotMatch(html, /BROWSER_DYNAMIC_ONLY|APP_DYNAMIC_CONDITIONAL/);
  assert.doesNotMatch(server.output(), /window is not defined/);
  const client = await fetch(server.url + '/server-client-dynamic');
  assert.equal(client.status, 200);
  assert.match(await client.text(), /APP_DYNAMIC_INITIAL/);
});

test('a dynamic Server Component streams its fallback before the import finishes and keeps its request context', { timeout: 15_000 }, async () => {
  assert.equal(fixture.counts.get('server-module') || 0, 0, 'the build did not execute this dynamic server import');
  const release = fixture.hold('server-module');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('dynamic stream probe timed out')), 10_000);
  let reader;
  try {
    const response = await fetch(server.url + '/server-dynamic', { headers: { 'x-dynamic': 'first-request' }, signal: controller.signal });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (!html.includes('data-testid="server-dynamic-loading"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'the server sent its loading UI before completing the stream');
      html += decoder.decode(chunk.value, { stream: true });
    }
    assert.doesNotMatch(html, /data-testid="server-dynamic-result"/);
    assert.match(html, /Server dynamic shell/);
    release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += decoder.decode(chunk.value, { stream: true });
    }
    html += decoder.decode();
    assert.match(html, /data-testid="dynamic-header">first-request/);
    assert.match(html, /server child/);
  } finally { release(); clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const response = await fetch(server.url + '/server-dynamic', { headers: { 'x-dynamic': 'request-' + index } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp('data-testid="dynamic-header">request-' + index));
  }));
  assert.equal(fixture.counts.get('server-module'), 1, 'the worker retains its successfully imported module');
});

test('Flight preserves dynamically imported client references without leaking server source', async () => {
  const response = await fetch(server.url + '/server-client-dynamic', { headers: { RSC: '1' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/x-component/);
  assert.match(await response.text(), /:I\[/);
  assert.deepEqual(await fixture.chunks('APP_DYNAMIC_SERVER_SECRET'), []);
  for (const marker of ['PAGES_DYNAMIC_CONDITIONAL', 'APP_DYNAMIC_CONDITIONAL', 'BROWSER_DYNAMIC_ONLY']) {
    const chunks = await fixture.chunks(marker);
    assert.ok(chunks.length > 0, 'a browser chunk contains ' + marker);
    for (const chunk of chunks) {
      const asset = await fetch(server.url + chunk);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('cache-control'), /immutable/);
    }
  }
  const route = fixture.manifest.routes.find(route => route.pattern === '/dynamic-pages');
  const entry = await readFile(path.join(fixture.root, '.prnext/assets', path.basename(route.client)), 'utf8');
  assert.doesNotMatch(entry, /PAGES_DYNAMIC_CONDITIONAL|BROWSER_DYNAMIC_ONLY/);
});

test('failed App dynamic SSR loaders preserve Suspense fallbacks and fail without a boundary', async () => {
  for (const [mode, fallback] of [['loading', 'dynamic-ssr-loading'], ['suspense', 'dynamic-ssr-outer-loading']]) {
    const response = await fetch(server.url + '/dynamic-ssr-error/' + mode);
    assert.equal(response.status, 200, mode);
    const html = await response.text();
    assert.match(html, /Recoverable dynamic shell/);
    assert.match(html, /Dynamic page tail/);
    assert.ok(html.includes('data-testid="' + fallback + '"'));
    assert.match(html, /data-dgst=|\$RX\("B:\d+","[a-f\d]+"\)/, 'React marks the failed boundary for browser recovery');
    assert.doesNotMatch(html, /DYNAMIC_SSR_LOAD_FAILURE/, 'production HTML does not expose the server error message');
  }
  const response = await fetch(server.url + '/dynamic-ssr-error/unbounded');
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /Unbounded dynamic shell/);
});
