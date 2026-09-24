import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMetadata, metadataElements } from './app-metadata.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const props = { params: Promise.resolve({ slug: 'hello' }), searchParams: Promise.resolve({ term: 'rust' }) };

test('metadata resolves async parent inheritance and shallow field replacement', async () => {
  const result = await resolveMetadata({
    segments: [
      { layout: { metadata: { title: { default: 'Site', template: '%s | Site' }, description: 'Inherited', openGraph: { description: 'Old OG description', title: 'Old' } } } },
      {},
    ],
    page: { generateMetadata: async ({ params, searchParams }, parent) => ({
      title: `${(await params).slug}:${(await searchParams).term}`,
      openGraph: { title: (await parent).title.absolute },
    }) },
  }, props);
  assert.equal(result.title, 'hello:rust | Site');
  assert.equal(result.description, 'Inherited');
  assert.equal(result.openGraph.title.absolute, 'Site');
  assert.equal(result.openGraph.description, 'Inherited');
  assert.equal(result.openGraph.url, null);
});

test('title templates exclude their own segment and absolute titles bypass ancestors', async () => {
  const root = { layout: { metadata: { title: { default: 'Site', template: '%s | Site' } } } };
  assert.equal((await resolveMetadata({ segments: [root], page: { metadata: { title: 'Home' } } }, props)).title, 'Home');
  assert.equal((await resolveMetadata({ segments: [root, {}], page: { metadata: { title: { absolute: 'Exact' } } } }, props)).title, 'Exact');
  assert.equal((await resolveMetadata({ segments: [root, {}], page: {} }, props)).title, 'Site');
});

test('metadata and viewport exports reject contradictory static and dynamic definitions', async () => {
  await assert.rejects(resolveMetadata({ page: { metadata: {}, generateMetadata() {} } }, props), /both metadata and generateMetadata/);
  await assert.rejects(resolveMetadata({ page: { viewport: {}, generateViewport() {} } }, props), /both viewport and generateViewport/);
});

test('metadata elements escape content, set viewport and generate robots and social images', async () => {
  const resolved = await resolveMetadata({ segments: [{}], page: {
    metadata: {
      title: '<script>private()</script>',
      metadataBase: new URL('https://example.com/'),
      description: 'A "quoted" description',
      robots: { index: false, follow: true, googleBot: { 'max-image-preview': 'large' } },
      openGraph: { images: [{ url: '/cover.png', width: 800, alt: 'Cover' }] },
      alternates: { canonical: '/article' },
      icons: '/favicon.ico',
    },
    generateViewport: async () => ({ themeColor: [{ color: 'black', media: '(prefers-color-scheme: dark)' }], maximumScale: 3 }),
  } }, props);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...metadataElements(resolved)));
  assert.match(html, /<meta charSet="utf-8"\/>/);
  assert.match(html, /width=device-width, initial-scale=1, maximum-scale=3/);
  assert.match(html, /<title>&lt;script&gt;private\(\)&lt;\/script&gt;<\/title>/);
  assert.match(html, /name="robots" content="noindex, follow"/);
  assert.match(html, /name="googlebot" content="max-image-preview:large"/);
  assert.match(html, /property="og:image" content="https:\/\/example.com\/cover.png"/);
  assert.match(html, /rel="canonical" href="https:\/\/example.com\/article"/);
});
