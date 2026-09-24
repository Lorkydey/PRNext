import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { NextRequest, NextURL } from '../compat/server.cjs';
import { addBasePath, removeBasePath, hasBasePath, assetBase } from '../compat/paths.cjs';
import { renderPageData, renderPage, prerenderRoute, runApi } from './render.mjs';
import { runMiddleware, drainMiddlewareWork } from './middleware.mjs';

const require = createRequire(import.meta.url);
const config = { basePath: '/docs', assetPrefix: 'https://cdn.example/assets', assetBase: 'https://cdn.example/assets/_rustyx/assets' };
async function fixture(t, code) {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-base-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'page.cjs');
  await writeFile(modulePath, code);
  return modulePath;
}
function htmlData(body) {
  const source = String(body).match(/<script>(window\.__RUSTYX_DATA__=[\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(context.window.__RUSTYX_DATA__));
}

test('base path helpers respect segment boundaries and prefix destinations as Next does', () => {
  assert.equal(addBasePath('/post?q=1#part', '/docs'), '/docs/post?q=1#part');
  assert.equal(addBasePath('/docs/post', '/docs'), '/docs/docs/post');
  assert.equal(addBasePath('https://external.test/post', '/docs'), 'https://external.test/post');
  assert.equal(removeBasePath('/docs?x=1', '/docs'), '/?x=1');
  assert.equal(removeBasePath('/docsmith/post', '/docs'), '/docsmith/post');
  assert.equal(hasBasePath('/docs/a', '/docs'), true);
  assert.equal(hasBasePath('/docsmith', '/docs'), false);
  assert.equal(assetBase('/docs', ''), '/docs/_rustyx/assets');
  assert.equal(assetBase('/docs', '/'), '/_rustyx/assets');
  assert.equal(assetBase('/docs', 'https://cdn.example/prefix'), 'https://cdn.example/prefix/_rustyx/assets');
});

test('NextURL separates public URL and internal pathname and preserves configuration on clones', () => {
  const url = new NextURL('https://app.test/docs/start?x=1', { nextConfig: config });
  assert.equal(url.href, 'https://app.test/docs/start?x=1');
  assert.equal(String(url), url.href);
  assert.equal(url.pathname, '/start');
  assert.equal(url.basePath, '/docs');
  const clone = url.clone();
  clone.pathname = '/destination';
  assert.equal(clone.href, 'https://app.test/docs/destination?x=1');
  assert.equal(url.pathname, '/start');
  clone.pathname = '/docs/explicit';
  assert.equal(clone.href, 'https://app.test/docs/docs/explicit?x=1');
  clone.href = 'https://app.test/outside';
  assert.equal(clone.basePath, '');
  assert.equal(clone.pathname, '/outside');
  const request = new NextRequest(url, { nextConfig: config });
  assert.equal(request.url, url.href);
  assert.equal(request.nextUrl.pathname, '/start');
  // Next 16.3.5 prepends '/' even to the empty setter value. Cloning analyzes
  // the public URL again against the original configured mount.
  const changed = url.clone();
  changed.basePath = '';
  assert.equal(changed.basePath, '/');
  assert.equal(changed.pathname, '/start');
  assert.equal(changed.href, 'https://app.test//start?x=1');
  changed.basePath = '/other';
  const detached = changed.clone();
  assert.equal(detached.basePath, '');
  assert.equal(detached.pathname, '/other/start');
  detached.pathname = '/next';
  assert.equal(detached.href, 'https://app.test/next?x=1');
});

test('Pages SSR and data requests remove the public mount exactly once from application URLs', async t => {
  const modulePath = await fixture(t, `
    const React=require(${JSON.stringify(require.resolve('react'))});
    exports.default=()=>React.createElement('p',null,'mounted');
    exports.getServerSideProps=({req,resolvedUrl,query})=>({props:{url:req.url,resolvedUrl,query}});
  `);
  const options = { modulePath, manifest: { config }, route: { pattern: '/target/[id]' }, params: { id: 'book' },
    url: 'https://app.test/target/book?from=visible&injected=yes', originalUrl: 'https://app.test/docs/alias/book?from=visible' };
  const html = await renderPage(options);
  await html.finalizeCache();
  const initial = htmlData(html.body);
  assert.equal(initial.props.url, '/alias/book?from=visible');
  assert.equal(initial.props.resolvedUrl, '/target/book?from=visible');
  assert.equal(initial.router.basePath, '/docs');
  assert.equal(initial.router.asPath, '/alias/book?from=visible');
  const data = await renderPageData({ ...options, originalUrl: 'https://app.test/docs/_rustyx/data/build/alias/book.json?from=visible' });
  await data.finalizeCache();
  const value = JSON.parse(data.body);
  assert.equal(value.pageProps.url, '/_rustyx/data/build/alias/book.json?from=visible');
  assert.deepEqual(value.__RUSTYX_ROUTER__, initial.router);
  const nested = await renderPageData({ ...options, url: 'https://app.test/docs/page', originalUrl: 'https://app.test/docs/docs/page' });
  await nested.finalizeCache();
  assert.equal(JSON.parse(nested.body).pageProps.url, '/docs/page');
  assert.equal(JSON.parse(nested.body).__RUSTYX_ROUTER__.asPath, '/docs/page');
});

test('Pages HTML redirects use the mount while JSON redirects retain logical destinations', async t => {
  const modulePath = await fixture(t, `exports.default=()=>null;exports.getServerSideProps=({query})=>({redirect:{destination:query.to||'/target',permanent:false,...(query.outside?{basePath:false}:{})}});`);
  for (const [query, location] of [['', '/docs/target'], ['?to=/docs/target', '/docs/docs/target'], ['?outside=1', '/target'], ['?to=//example.test/x', '/docs/example.test/x']]) {
    const options = { modulePath, url: 'https://app.test/redirect' + query, manifest: { config } };
    const html = await renderPage(options);
    await html.finalizeCache();
    assert.equal(html.headers.location, location);
    const data = await renderPageData(options);
    await data.finalizeCache();
    assert.equal(data.status, 200);
    assert.equal(data.headers.location, undefined);
    assert.equal(JSON.parse(data.body).pageProps.__N_REDIRECT, new URLSearchParams(query).get('to') || '/target');
  }
});

test('prerendered Pages retain basePath without contaminating canonical paths with it', async t => {
  const modulePath = await fixture(t, `const React=require(${JSON.stringify(require.resolve('react'))});exports.default=()=>React.createElement('p',null,'static');exports.getStaticProps=()=>({props:{}});`);
  const result = await prerenderRoute({ modulePath, path: '/static', pattern: '/static', basePath: '/docs', client: config.assetBase + '/page.js' });
  const data = htmlData(result.body);
  assert.equal(data.router.basePath, '/docs');
  assert.equal(data.router.asPath, '/static');
  assert.equal(JSON.parse(result.dataJSON).__RUSTYX_ROUTER__.basePath, '/docs');
  assert.ok(result.body.includes(config.assetBase + '/page.js'));
});

test('Route Handlers see internal URLs while middleware NextRequest sees the public mount', async t => {
  const modulePath = await fixture(t, `exports.GET=request=>Response.json({url:request.url,href:request.nextUrl.href,pathname:request.nextUrl.pathname,basePath:request.nextUrl.basePath,clone:request.nextUrl.clone().href});`);
  const response = await runApi({ modulePath, route: { router: 'app' }, manifest: { config },
    url: 'https://app.test/api/check?x=1', originalUrl: 'https://app.test/docs/api/check?x=1' });
  await response.finalizeCache();
  assert.deepEqual(JSON.parse(response.body), { url: 'https://app.test/api/check?x=1', href: 'https://app.test/api/check?x=1', pathname: '/api/check', basePath: '', clone: 'https://app.test/api/check?x=1' });
  const middlewarePath = await fixture(t, `const {getCachePaths}=require(${JSON.stringify(require.resolve('../compat/data-cache.cjs'))});exports.middleware=request=>{const clone=request.nextUrl.clone();clone.pathname='/target';return Response.json({url:request.url,pathname:request.nextUrl.pathname,basePath:request.nextUrl.basePath,clone:clone.href,cachePaths:getCachePaths()});};`);
  const middleware = await runMiddleware({ modulePath: middlewarePath, manifest: { config, middleware: { exportName: 'middleware' } }, url: 'https://app.test/docs/check?x=1' });
  const bytes = Buffer.isBuffer(middleware.body) ? middleware.body : Buffer.concat(await Array.fromAsync(middleware.body));
  await middleware.finalizeCache?.();
  await drainMiddlewareWork();
  assert.deepEqual(JSON.parse(bytes), { url: 'https://app.test/docs/check?x=1', pathname: '/check', basePath: '/docs', clone: 'https://app.test/docs/target?x=1', cachePaths: ['page:/check', 'layout:/', 'layout:/check'] });
});
