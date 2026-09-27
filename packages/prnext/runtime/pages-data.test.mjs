import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderPageData } from './render.mjs';

const dynamicPath = fileURLToPath(new URL('../compat/dynamic.cjs', import.meta.url));
const require = createRequire(import.meta.url);
async function fixture(t, code) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-pages-data-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'page.cjs');
  await writeFile(modulePath, code);
  return modulePath;
}

test('Pages JSON executes GSSP each time without rendering React, App or dynamic loaders', async t => {
  const modulePath = await fixture(t, `
    const dynamic = require(${JSON.stringify(dynamicPath)});
    dynamic(() => { throw new Error('DYNAMIC_PRELOAD_MUST_NOT_RUN'); });
    exports.default = () => { throw new Error('PAGE_RENDER_MUST_NOT_RUN'); };
    exports.App = () => { throw new Error('APP_RENDER_MUST_NOT_RUN'); };
    let count = 0;
    exports.getServerSideProps = ({ req, res, query, resolvedUrl }) => {
      res.statusCode = 201;
      res.setHeader('set-cookie', ['one=1; HttpOnly', 'two=2']);
      res.setHeader('x-data-test', 'present');
      return { props: { count: ++count, query, url: req.url, resolvedUrl, cookie: req.cookies.session } };
    };
  `);
  const options = { modulePath, route: { pattern: '/person/[id]' }, params: { id: '42' },
    url: 'http://localhost/person/42?tag=a&tag=b', originalUrl: 'http://localhost/_prnext/data/build/person/42.json?tag=a&tag=b',
    headers: { cookie: 'session=Ada' } };
  for (let count = 1; count <= 2; count++) {
    const response = await renderPageData(options);
    await response.finalizeCache();
    assert.equal(response.status, 201);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.match(response.headers['cache-control'], /private.*no-store/);
    assert.equal(response.headers['x-data-test'], 'present');
    assert.deepEqual(response.headers['set-cookie'], ['one=1; HttpOnly', 'two=2']);
    const data = JSON.parse(response.body);
    assert.equal(data.__N_SSP, true);
    assert.equal(data.__N_SSG, undefined);
    assert.deepEqual(data.pageProps, { count, query: { tag: ['a', 'b'], id: '42' },
      url: '/_prnext/data/build/person/42.json?tag=a&tag=b', resolvedUrl: '/person/42?tag=a&tag=b', cookie: 'Ada' });
    assert.equal(data.__PRNEXT_ROUTER__.pathname, '/person/[id]');
    assert.equal(data.__PRNEXT_ROUTER__.asPath, '/person/42?tag=a&tag=b');
    assert.equal(data.__PRNEXT_ROUTER__.rewrite, undefined);
  }
});

test('pure Pages JSON returns empty props and resolved parameters without calling the component', async t => {
  const modulePath = await fixture(t, `exports.default = () => { throw new Error('NO_SERVER_RENDER'); };`);
  for (const [url, originalUrl, asPath] of [
    ['http://localhost/?tag=x', 'http://localhost/_prnext/data/build/index.json?tag=x', '/?tag=x'],
    ['http://localhost/index', 'http://localhost/_prnext/data/build/index/index.json', '/index'],
    ['http://localhost/index/child', 'http://localhost/_next/data/build/index/index/child.json', '/index/child'],
  ]) {
    const response = await renderPageData({ modulePath, url, originalUrl, route: { pattern: '/[[...parts]]' } });
    await response.finalizeCache();
    const data = JSON.parse(response.body);
    assert.deepEqual(data.pageProps, {});
    assert.equal(data.__N_SSP, undefined);
    assert.equal(data.__N_SSG, undefined);
    assert.equal(data.__PRNEXT_ROUTER__.asPath, asPath);
  }
});

test('Pages JSON redirects and notFound preserve data function cookies without issuing an HTTP redirect', async t => {
  const modulePath = await fixture(t, `
    exports.default=()=>{throw new Error('NO_RENDER')};
    exports.getServerSideProps=({query,res})=>{
      res.setHeader('set-cookie',['saved=1','second=2']);
      return query.missing ? {notFound:true} : {redirect:{destination:'/next?from=data',permanent:true,basePath:false}};
    };
  `);
  const redirect = await renderPageData({ modulePath });
  await redirect.finalizeCache();
  assert.equal(redirect.status, 200);
  assert.equal(redirect.headers.location, undefined);
  assert.deepEqual(redirect.headers['set-cookie'], ['saved=1', 'second=2']);
  assert.deepEqual(JSON.parse(redirect.body).pageProps, { __N_REDIRECT: '/next?from=data', __N_REDIRECT_STATUS: 308, __N_REDIRECT_BASE_PATH: false });
  const missing = await renderPageData({ modulePath, url: 'http://localhost/?missing=1' });
  await missing.finalizeCache();
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { notFound: true });
  assert.deepEqual(missing.headers['set-cookie'], ['saved=1', 'second=2']);
});

test('rewritten Pages JSON separates raw request, visible browser path and destination query', async t => {
  const modulePath = await fixture(t, `
    exports.default=()=>null;
    exports.getServerSideProps=({req,resolvedUrl,query})=>({props:{url:req.url,resolvedUrl,query}});
  `);
  const response = await renderPageData({ modulePath, route: { pattern: '/target/[slug]' }, params: { slug: 'book' },
    originalUrl: 'http://localhost/_prnext/data/build/alias/book.json?collision=visible&from=browser',
    url: 'http://localhost/target/book?collision=destination&from=browser&injected=yes' });
  await response.finalizeCache();
  const data = JSON.parse(response.body);
  assert.equal(data.pageProps.url, '/_prnext/data/build/alias/book.json?collision=visible&from=browser');
  assert.equal(data.pageProps.resolvedUrl, '/target/book?collision=visible&from=browser');
  assert.equal(data.__PRNEXT_ROUTER__.asPath, '/alias/book?collision=visible&from=browser');
  assert.equal(data.__PRNEXT_ROUTER__.pathname, '/target/[slug]');
  assert.deepEqual(data.__PRNEXT_ROUTER__.query, { collision: 'destination', from: 'browser', injected: 'yes', slug: 'book' });
  assert.deepEqual(data.__PRNEXT_ROUTER__.rewrite, { url: '/target/book?collision=destination&from=browser&injected=yes', params: { slug: 'book' } });
});

test('Pages JSON keeps props serialization validation and explicit data-function completion', async t => {
  const invalid = await fixture(t, 'exports.default=()=>null; exports.getServerSideProps=()=>({props:{date:new Date()}});');
  await assert.rejects(renderPageData({ modulePath: invalid }), /plain JSON/);
  const ended = await fixture(t, "exports.default=()=>{throw new Error('NO_RENDER')}; exports.getServerSideProps=({res})=>{res.statusCode=202;res.setHeader('x-completed','yes');res.end('handled');};");
  const response = await renderPageData({ modulePath: ended });
  await response.finalizeCache();
  assert.equal(response.status, 202);
  assert.equal(response.headers['x-completed'], 'yes');
  assert.equal(response.body.toString(), 'handled');
});

test('Pages JSON preserves explicit GSSP statuses and headers, including responses without a body', async t => {
  const modulePath = await fixture(t, `
    exports.default=()=>null;
    exports.getServerSideProps=({query,res})=>{
      res.statusCode = Number(query.status || 201);
      res.setHeader('content-type','application/vnd.example+json');
      res.setHeader('location','/created-resource');
      res.setHeader('cache-control','private, max-age=60');
      return query.redirect ? {redirect:{destination:'/destination',permanent:false}} : {props:{created:true}};
    };
  `);
  const response = await renderPageData({ modulePath });
  await response.finalizeCache();
  assert.equal(response.status, 201);
  assert.equal(response.headers['content-type'], 'application/vnd.example+json');
  assert.equal(response.headers.location, '/created-resource');
  assert.equal(response.headers['cache-control'], 'private, max-age=60');
  assert.deepEqual(JSON.parse(response.body).pageProps, { created: true });
  const redirect = await renderPageData({ modulePath, url: 'http://localhost/?redirect=1&status=202' });
  await redirect.finalizeCache();
  assert.equal(redirect.status, 202);
  assert.equal(redirect.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(redirect.headers.location, '/created-resource');
  assert.equal(JSON.parse(redirect.body).pageProps.__N_REDIRECT_STATUS, 307);
  for (const status of [204, 205, 304]) {
    const empty = await renderPageData({ modulePath, url: `http://localhost/?status=${status}` });
    await empty.finalizeCache();
    assert.equal(empty.status, status);
    assert.equal(empty.body.length, 0);
  }
});

test('a fresh data worker loads no React DOM server renderer until its first HTML render', async t => {
  const modulePath = await fixture(t, `
    const React = require(${JSON.stringify(require.resolve('react'))});
    exports.default = ({ value }) => React.createElement('p', null, value);
    exports.getServerSideProps = () => ({ props: { value: 'server renderer on demand' } });
  `);
  const source = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { renderPageData, renderPage } from ${JSON.stringify(new URL('./render.mjs', import.meta.url).href)};
    const require = createRequire(import.meta.url);
    const loaded = () => Object.keys(require.cache).some(file => file.includes('/react-dom/') && file.includes('server'));
    assert.equal(loaded(), false);
    const options = { modulePath: ${JSON.stringify(modulePath)} };
    const data = await renderPageData(options);
    await data.finalizeCache();
    assert.equal(JSON.parse(data.body).pageProps.value, 'server renderer on demand');
    assert.equal(loaded(), false);
    const html = await renderPage(options);
    await html.finalizeCache();
    assert.ok(html.body.toString().includes('<p>server renderer on demand</p>'));
    assert.equal(loaded(), true);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, NODE_ENV: 'production' }, timeout: 10_000,
  });
});
