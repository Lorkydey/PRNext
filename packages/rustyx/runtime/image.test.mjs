import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Image, { getImageProps } from '../compat/image.cjs';
import { validateImagesConfig } from '../build/images-config.mjs';

test('image builds real optimizer density and responsive candidates', () => {
  const { props } = getImageProps({ src: '/photo.jpg', width: 300, height: 200, alt: 'Photo' });
  assert.equal(props.src, '/_rustyx/image?url=%2Fphoto.jpg&w=640&q=75');
  assert.equal(props.srcSet, '/_rustyx/image?url=%2Fphoto.jpg&w=384&q=75 1x, /_rustyx/image?url=%2Fphoto.jpg&w=640&q=75 2x');
  assert.equal(props.loading, 'lazy');
  const fill = getImageProps({ src: '/photo.jpg', fill: true, alt: 'Photo', sizes: '(min-width: 800px) 50vw, 100vw' }).props;
  assert.match(fill.srcSet, /w=384&q=75 384w/);
  assert.equal(fill.style.position, 'absolute');
  assert.equal(fill.width, undefined);
  assert.equal(fill.sizes, '(min-width: 800px) 50vw, 100vw');
});
test('static imports preserve aspect ratio, blur and unoptimized overrides', () => {
  const src = { src: '/static.png', width: 800, height: 400, blurDataURL: 'data:image/webp;base64,test' };
  const props = getImageProps({ src, width: 200, alt: 'Static', placeholder: 'blur' }).props;
  assert.equal(props.height, 100);
  assert.match(props.style.backgroundImage, /data:image\/webp;base64,test/);
  const plain = getImageProps({ src: '/vector.svg', width: 80, height: 40, alt: 'SVG' }).props;
  assert.equal(plain.src, '/vector.svg');
  assert.equal(plain.srcSet, undefined);
  const override = getImageProps({ src: '/photo.jpg', overrideSrc: '/legacy.jpg', width: 100, height: 50, alt: 'Override' }).props;
  assert.equal(override.src, '/legacy.jpg');
  assert.match(override.srcSet, /photo\.jpg/);
});
test('custom image loaders get actual widths/quality and preload uses responsive attributes', () => {
  const calls = [];
  const html = renderToStaticMarkup(React.createElement(Image, { src: '/photo.jpg', width: 100, height: 50, alt: 'Photo', preload: true, quality: 60, loader: input => { calls.push(input); return `https://cdn.example/${input.width}?q=${input.quality}`; } }));
  assert.deepEqual([...new Set(calls.map(call => call.width))], [128, 256]);
  assert.ok(calls.every(call => call.quality === 60));
  assert.match(html, /rel="preload" as="image"/);
  assert.match(html, /imageSrcSet=/);
  assert.doesNotMatch(html, /loading="lazy"/);
  assert.doesNotMatch(html, /onLoadingComplete|quality=/);
});
test('invalid image dimensions and missing blur fail explicitly', () => {
  assert.throws(() => getImageProps({ src: '/photo.jpg', alt: 'Photo' }), /width and height/);
  assert.throws(() => getImageProps({ src: '/photo.jpg', width: 1, height: 1, alt: 'Photo', placeholder: 'blur' }), /blurDataURL/);
});
test('image config normalizes bounded options and exact URL query restrictions', () => {
  const config = validateImagesConfig({ deviceSizes: [800, 400, 400], qualities: [90, 50], remotePatterns: [new URL('https://images.example/photos/**?v=1')], localPatterns: [{ pathname: '/images/**', search: '' }], formats: ['image/avif', 'image/webp'] }, { basePath: '/docs' });
  assert.equal(config.path, '/docs/_rustyx/image');
  assert.deepEqual(config.deviceSizes, [400, 800]);
  assert.deepEqual(config.qualities, [50, 90]);
  assert.deepEqual(config.remotePatterns, [{ protocol: 'https', hostname: 'images.example', port: '', pathname: '/photos/**', search: '?v=1' }]);
  for (const input of [{ qualities: [101] }, { formats: ['image/png'] }, { maximumRedirects: 100 }, { path: '//evil.example/' }, { remotePatterns: [{ hostname: '*.example', pathname: 'relative' }] }, { contentSecurityPolicy: 'a\nb' }]) assert.throws(() => validateImagesConfig(input));
});

test('static assets and configured CDN remain allowed with restrictive image policies',()=>{
  const local=validateImagesConfig({localPatterns:[{pathname:'/uploads/**'}]},{basePath:'/docs'});
  assert.deepEqual(local.localPatterns.at(-1),{pathname:'/docs/_rustyx/assets/**',search:''});
  const cdn=validateImagesConfig({}, {basePath:'/docs',assetPrefix:'https://cdn.example.test/resources'});
  assert.deepEqual(cdn.remotePatterns.at(-1),{hostname:'cdn.example.test',protocol:'https',port:''});
  assert.deepEqual(cdn.localPatterns,[{pathname:'**',search:''}]);
});
