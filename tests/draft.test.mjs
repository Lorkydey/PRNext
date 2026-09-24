import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { draftFixture } from './draft-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server, manifest;
before(async () => { fixture = await draftFixture(); manifest = await fixture.build(); server = await startServer(fixture.root); });
after(async () => { await server?.close(); await fixture?.remove(); });
const read = (route, cookie, options = {}) => fetch(server.url + '/docs' + route, { ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers } });
const token = response => response.headers.getSetCookie().find(value => value.startsWith('__prerender_bypass=')).split(';')[0];

for (const [route, label] of [['/content', 'App'], ['/page', 'Pages']]) test(`${label} previews bypass both route and data caches without publishing private content`, async () => {
  const regular = await read(route), normal = await regular.text();
  assert.equal(regular.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(normal, new RegExp(`${label} draft:<!-- -->false`));
  const initialCalls = fixture.calls;
  const invalid = await read(route, '__prerender_bypass=forged');
  assert.equal(await invalid.text(), normal); assert.equal(fixture.calls, initialCalls);
  const enabled = await read('/toggle');
  assert.equal(enabled.status, 200); assert.deepEqual(await enabled.json(), { enabled: true });
  assert.match(enabled.headers.get('cache-control'), /private.*no-store/);
  assert.match(enabled.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=None/);
  const cookie = token(enabled);
  for (let index = 1; index <= 2; index++) {
    const preview = await read(route, cookie);
    assert.equal(preview.status, 200); assert.match(preview.headers.get('cache-control'), /private.*no-store/);
    assert.equal(preview.headers.get('x-nextjs-cache'), null);
    assert.match(await preview.text(), new RegExp(`${label} draft:<!-- -->true`));
    assert.equal(fixture.calls, initialCalls + index);
  }
  assert.equal(await (await read(route)).text(), normal);
  assert.equal(fixture.calls, initialCalls + 2);
  const disabled = await read('/toggle?enable=0', cookie);
  assert.deepEqual(await disabled.json(), { enabled: false });
  assert.match(disabled.headers.getSetCookie()[0], /Expires=Thu, 01 Jan 1970/);
});
test('Pages API cookies activate previews for data JSON and App Flight; HEAD stays bodyless', async () => {
  const enable = await read('/api/toggle');
  const cookie = token(enable);
  const json = await read('/_next/data/draft-tests/page.json', cookie);
  const value = await json.json();
  assert.equal(value.pageProps.draft, true);
  assert.equal(value.__RUSTYX_ROUTER__.isPreview, true);
  assert.match(json.headers.get('cache-control'), /private.*no-store/);
  const flight = await read('/content', cookie, { headers: { RSC: '1' } });
  assert.match(flight.headers.get('content-type'), /text\/x-component/);
  assert.match(await flight.text(), /true/);
  const head = await read('/content', cookie, { method: 'HEAD' });
  assert.equal(await head.text(), ''); assert.match(head.headers.get('cache-control'), /no-store/);
  const cleared = await read('/api/clear', cookie);
  assert.match(cleared.headers.getSetCookie()[0], /Expires=Thu, 01 Jan 1970/);
});
test('draft cookie bypasses static Route Handlers and cannot be obtained from the public manifest', async () => {
  const normal = await read('/cached');
  assert.equal(normal.headers.get('x-nextjs-cache'), 'HIT'); assert.deepEqual(await normal.json(), { enabled: false });
  const cookie = token(await read('/toggle'));
  const draft = await read('/cached', cookie);
  assert.deepEqual(await draft.json(), { enabled: true }); assert.match(draft.headers.get('cache-control'), /private.*no-store/);
  const publicManifest = await readFile(path.join(fixture.root, '.rustyx/assets', `pages-manifest-${manifest.cacheId}.json`), 'utf8');
  assert.equal(publicManifest.includes(manifest.previewModeId), false);
});
test('connection prevents prerendering and executes the page for each request', async () => {
  assert.equal(manifest.routes.find(route => route.pattern === '/request').ssg, undefined);
  const first = await read('/request');
  assert.equal(first.headers.get('x-nextjs-cache'), null);
  assert.match(await first.text(), /Request:<!-- -->1/);
  assert.match(await (await read('/request')).text(), /Request:<!-- -->2/);
});
test('legacy Preview Mode encrypts payloads and exposes them to Pages APIs and getStaticProps', async () => {
  const normal = await (await read('/preview')).text(); assert.match(normal, /published/);
  const enabled = await read('/api/preview?enable=1');
  assert.equal(enabled.status, 200);
  const lines = enabled.headers.getSetCookie(); assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.includes('Path=/docs')));
  assert.ok(!lines.join('').includes('private preview'));
  const cookie = lines.map(line => line.split(';')[0]).join('; ');
  const api = await read('/api/preview', cookie);
  assert.deepEqual(await api.json(), {preview:true,data:{title:'private preview'}});
  const preview = await read('/preview', cookie);
  assert.match(preview.headers.get('cache-control'), /private.*no-store/);
  assert.match(await preview.text(), /private preview/);
  const data = await (await read('/_next/data/draft-tests/preview.json', cookie)).json();
  assert.deepEqual(data.pageProps, {preview:true,title:'private preview'});
  assert.equal(await (await read('/preview')).text(), normal);
  const forged = await read('/api/preview', cookie.replace('__next_preview_data=', '__next_preview_data=x'));
  assert.deepEqual(await forged.json(), {preview:false,data:false});
});
test('rebuilding invalidates old draft sessions even with the same public buildId', async () => {
  const cookie = token(await read('/toggle'));
  const previous = manifest.previewModeId;
  await server.close();
  manifest = await fixture.build();
  assert.notEqual(manifest.previewModeId, previous);
  server = await startServer(fixture.root);
  const stale = await read('/content', cookie);
  assert.equal(stale.headers.get('x-nextjs-cache'), 'HIT');
  assert.match(await stale.text(), /App draft:<!-- -->false/);
});
