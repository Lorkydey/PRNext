import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMetadata } from './app-metadata.mjs';

const props = () => ({ params: Promise.resolve({ slug: 'article' }), searchParams: Promise.resolve({}) });

test('component-only layouts preserve title inheritance, viewport and not-found metadata', async () => {
  const entry = {
    segments: [
      { path: '/', layout: { metadata: { title: { default: 'Site', template: '%s | Site' } }, viewport: { themeColor: 'black' } } },
      { path: '/nested', layout: { default() {} } },
      { path: '/nested/[slug]', segment: '[slug]', layout: { default() {} } },
    ],
    page: { metadata: { title: 'Article' } },
  };
  const result = await resolveMetadata(entry, props());
  assert.equal(result.title, 'Article | Site');
  assert.deepEqual(result.viewport, { width: 'device-width', initialScale: 1, themeColor: 'black' });
  const missing = await resolveMetadata(entry, props(), 1);
  assert.equal(missing.title, 'Site');
  assert.deepEqual(missing.robots, { basic: 'noindex' });
});

test('file-based metadata survives component-only modules and parallel metadata items', async () => {
  const files = [{ path: '/[slug]', pattern: '/[slug]/icon.png', kind: 'icon', info: { type: 'image/png', width: 32, height: 32 } }];
  const entry = { segments: [{ path: '/[slug]', segment: '[slug]', layout: { default() {} } }], page: { default() {} }, metadataFiles: files };
  assert.deepEqual((await resolveMetadata(entry, props())).icons.icon, [{ url: '/article/icon.png', type: 'image/png', sizes: '32x32' }]);
  const parallel = { ...entry, metadataItems: [
    { module: { default() {} }, params: props().params },
    { module: {}, filePath: '/[slug]', params: props().params },
  ] };
  assert.deepEqual((await resolveMetadata(parallel, props())).icons.icon, [{ url: '/article/icon.png', type: 'image/png', sizes: '32x32' }]);
});

test('export changes and generators remain request-specific without a cached empty result', async () => {
  const page = { metadata: undefined };
  const entry = { segments: [{ layout: { default() {} } }], page };
  assert.equal((await resolveMetadata(entry, props())).title, null);
  page.metadata = { title: 'Changed' };
  assert.equal((await resolveMetadata(entry, props())).title, 'Changed');
  delete page.metadata;
  let serial = 0;
  page.generateMetadata = () => ({ title: `Request ${++serial}` });
  assert.equal((await resolveMetadata(entry, props())).title, 'Request 1');
  assert.equal((await resolveMetadata(entry, props())).title, 'Request 2');
  const inherited = Object.create({ viewport: { initialScale: 2 } });
  assert.equal((await resolveMetadata({ page: inherited }, props())).viewport.initialScale, 2);
  assert.equal((await resolveMetadata({ page: 'no exports', segments: [{ layout: true }] }, props())).title, null);
});

test('empty metadata still resolves parameter failures', async () => {
  const failure = new Error('parameter validation failed');
  await assert.rejects(resolveMetadata({ page: {}, segments: [{ layout: {} }] }, {
    params: Promise.reject(failure), searchParams: Promise.resolve({}),
  }), error => error === failure);
});
