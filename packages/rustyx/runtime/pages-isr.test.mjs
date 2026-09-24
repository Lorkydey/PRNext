import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { renderIsrPage, prerenderRoute, renderFallback, runApi, CapturedResponse } from './render.mjs';
import { createProtocolOutput, MAX_STREAM_CHUNK } from './transport.mjs';

const require = createRequire(import.meta.url);
const react = JSON.stringify(require.resolve('react'));
const compat = fileURLToPath(new URL('../compat/', import.meta.url));
async function fixture(t, code) {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-isr-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'page.cjs');
  await writeFile(modulePath, code);
  return modulePath;
}
function payload(html) {
  const script = html.match(/<script>(window\.__RUSTYX_DATA__=[\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const context = vm.createContext({ window: {} });
  vm.runInContext(script, context);
  return JSON.parse(JSON.stringify(context.window.__RUSTYX_DATA__));
}

test('ISR executes getStaticProps once and emits HTML plus data with a canonical public router snapshot', async t => {
  const modulePath = await fixture(t, `
    const React=require(${react});
    const {currentRequest}=require(${JSON.stringify(path.join(compat, 'headers.cjs'))});
    let calls=0;
    exports.getCalls=()=>calls;
    exports.getStaticProps=async({params,revalidateReason})=>{
      const context=currentRequest();
      return {props:{label:'é🚀',id:params.id,reason:revalidateReason,calls:++calls,url:context.url,cookie:context.headers.get('cookie'),method:context.method},revalidate:15};
    };
    exports.default=({label,id})=>React.createElement('p',null,label+':'+id);
  `);
  const response = await renderIsrPage({ modulePath, url: 'https://private.example/products/one?token=PRIVATE_QUERY', method: 'POST',
    headers: { cookie: 'session=PRIVATE_COOKIE' }, body: 'PRIVATE_BODY', params: { id: 'one' },
    route: { pattern: '/products/[id]', client: '/client.js' }, manifest: { buildId: 'build-one' }, revalidateReason: 'on-demand' });
  assert.equal(require(modulePath).getCalls(), 1);
  const [html, data] = response.body;
  assert.deepEqual(response.isr, { revalidate: 15, htmlLength: html.byteLength, dataLength: data.byteLength });
  const json = JSON.parse(data);
  assert.deepEqual(json.pageProps, { label: 'é🚀', id: 'one', reason: 'on-demand', calls: 1, url: 'http://rustyx.local/products/one', cookie: null, method: 'GET' });
  assert.equal(json.__N_SSG, true);
  assert.deepEqual(json.__RUSTYX_ROUTER__.query, { id: 'one' });
  assert.equal(json.__RUSTYX_ROUTER__.asPath, '/products/one');
  assert.equal(json.__RUSTYX_ROUTER__.pathname, '/products/[id]');
  const initial = payload(html.toString());
  assert.equal(initial.buildId, 'build-one');
  assert.deepEqual(initial.props, json.pageProps);
  assert.deepEqual(initial.router, json.__RUSTYX_ROUTER__);
  assert.doesNotMatch(html.toString(), /PRIVATE_|private\.example/);
  await response.finalizeCache();
});

test('build prerenders expose generation time, data and build reason, and accept zero or absent revalidation', async t => {
  for (const value of ['false', '0', '3', 'undefined']) {
    const modulePath = await fixture(t, `
      const React=require(${react});let calls=0;
      exports.getStaticProps=({revalidateReason})=>({props:{reason:revalidateReason,calls:++calls},revalidate:${value}});
      exports.default=({reason,calls})=>React.createElement('p',null,reason+':'+calls);
    `);
    const before = Date.now();
    const result = await prerenderRoute({ modulePath, path: '/built?private=query', buildId: 'build-id' });
    assert.match(result.body, /<p>build:1<\/p>/);
    assert.equal(result.revalidate, value === 'undefined' ? false : JSON.parse(value));
    assert.ok(result.generatedAt >= before && result.generatedAt <= Date.now());
    assert.deepEqual(JSON.parse(result.dataJSON).pageProps, { reason: 'build', calls: 1 });
    assert.equal(payload(result.body).router.asPath, '/built');
  }
});

test('ISR not-found and redirect results carry cache lifetime and Next-compatible data responses', async t => {
  const missing = await fixture(t, `exports.default=()=>null;exports.getStaticProps=()=>({notFound:true,revalidate:4});`);
  const notFound = await renderIsrPage({ modulePath: missing, url: 'http://host/missing' });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.isr.revalidate, 4);
  assert.deepEqual(JSON.parse(notFound.body[1]), { notFound: true });
  const redirected = await fixture(t, `exports.default=()=>null;exports.getStaticProps=()=>({redirect:{destination:'/destination?x=1',permanent:true,basePath:false},revalidate:9});`);
  const redirect = await renderIsrPage({ modulePath: redirected, url: 'http://host/redirect' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/destination?x=1');
  assert.equal(redirect.isr.revalidate, 9);
  assert.equal(redirect.isr.htmlLength, 0);
  const data = JSON.parse(redirect.body[1]);
  assert.equal(data.__N_SSG, true);
  assert.deepEqual(data.pageProps, { __N_REDIRECT: '/destination?x=1', __N_REDIRECT_STATUS: 308, __N_REDIRECT_BASE_PATH: false });
});

test('ISR rejects malformed results before they can become cached not-found or redirect responses', async t => {
  for (const result of [
    { props: {}, notFound: 'true' },
    { props: {}, notFound: true },
    { redirect: null },
    { redirect: { destination: '/', permanent: 'yes' } },
    { redirect: { destination: '/', permanent: true, statusCode: 301 } },
    { redirect: { destination: '/', permanent: false, basePath: true } },
    { redirect: { destination: '/', statusCode: 200 } },
  ]) {
    const modulePath = await fixture(t, `exports.default=()=>null;exports.getStaticProps=()=>(${JSON.stringify(result)});`);
    await assert.rejects(renderIsrPage({ modulePath, url: 'http://app/result' }), /notFound|exactly one|redirect/i);
  }
});

test('fallback shell skips getStaticProps and carries hydration metadata with an empty props object', async t => {
  const modulePath = await fixture(t, `
    const React=require(${react});
    const {useRouter}=require(${JSON.stringify(path.join(compat, 'router.cjs'))});
    exports.getStaticProps=()=>{throw new Error('Fallback must not run data loading');};
    exports.default=props=>React.createElement('p',null,useRouter().isFallback?'Loading '+Object.keys(props).length:'Ready');
  `);
  const shell = await renderFallback({ modulePath, pattern: '/products/[id]', client: '/client.js', buildId: 'fallback-build' });
  assert.match(shell.body, /<p>Loading 0<\/p>/);
  const data = payload(shell.body);
  assert.deepEqual(data.props, {});
  assert.equal(data.router.isFallback, true);
  assert.equal(data.router.pathname, '/products/[id]');
  assert.equal(data.router.asPath, '/products/[id]');
  assert.deepEqual(data.router.query, {});
  assert.equal(data.buildId, 'fallback-build');
  assert.deepEqual(data.route, { pattern: '/products/[id]' });
});

test('development reevaluates getStaticPaths every request and rejects current fallback-false misses before data loading', async t => {
  const modulePath = await fixture(t, `
    let paths=['/items/one'],pathCalls=0,dataCalls=0;
    exports.setPaths=value=>{paths=value;};
    exports.counts=()=>({pathCalls,dataCalls});
    exports.getStaticPaths=()=>{pathCalls++;return {paths,fallback:false};};
    exports.getStaticProps=({params})=>({props:{id:params.id,calls:++dataCalls},revalidate:10});
    exports.default=()=>null;
  `);
  const page = require(modulePath);
  const options = { modulePath, manifest: { dev: true }, route: { pattern: '/items/[id]' }, url: 'http://app/items/two', params: { id: 'two' } };
  const missing = await renderIsrPage(options);
  assert.equal(missing.status, 404);
  assert.equal(missing.isr.revalidate, 0);
  assert.deepEqual(JSON.parse(missing.body[1]), { notFound: true });
  assert.deepEqual(page.counts(), { pathCalls: 1, dataCalls: 0 });
  page.setPaths([{ params: { id: 'two' } }]);
  const present = await renderIsrPage(options);
  assert.equal(present.status, 200);
  assert.deepEqual(JSON.parse(present.body[1]).pageProps, { id: 'two', calls: 1 });
  page.setPaths([]);
  assert.equal((await renderIsrPage(options)).status, 404);
  assert.deepEqual(page.counts(), { pathCalls: 3, dataCalls: 1 });
});

test('development static path matching handles encoded catchalls, optional roots and current fallback settings', async t => {
  const modulePath = await fixture(t, `
    let listing={paths:[],fallback:false};
    exports.setListing=value=>{listing=value;};
    exports.getStaticPaths=()=>listing;
    exports.getStaticProps=({params})=>({props:{params}});
    exports.default=()=>null;
  `);
  const page = require(modulePath);
  const options = { modulePath, manifest: { dev: true }, route: { pattern: '/café/[[...slug]]' }, url: 'http://app/caf%C3%A9/a%20b/%E9%9B%AA', params: { slug: ['a b', '雪'] } };
  page.setListing({ paths: [{ params: { slug: ['a b', '雪'] } }], fallback: false });
  assert.equal((await renderIsrPage(options)).status, 200);
  page.setListing({ paths: ['/caf%C3%A9/a%20b/%e9%9b%aa'], fallback: false });
  assert.equal((await renderIsrPage(options)).status, 200);
  for (const slug of [[], null, false, undefined]) {
    page.setListing({ paths: [{ params: { slug } }], fallback: false });
    assert.equal((await renderIsrPage({ ...options, url: 'http://app/caf%C3%A9/', params: {} })).status, 200);
  }
  for (const fallback of [true, 'blocking']) {
    page.setListing({ paths: [], fallback });
    assert.equal((await renderIsrPage(options)).status, 200);
  }
  for (const listing of [{ paths: [], fallback: 'invalid' }, { fallback: false }, { paths: ['/other/path'], fallback: true }]) {
    page.setListing(listing);
    await assert.rejects(renderIsrPage(options), /getStaticPaths/);
  }
});

function decodeFrames(wire) {
  const frames = [];
  const chunks = [];
  let offset = 0;
  while (offset < wire.length) {
    const end = wire.indexOf(10, offset);
    assert.ok(end >= offset);
    const frame = JSON.parse(wire.subarray(offset, end));
    frames.push(frame);
    offset = end + 1;
    if (frame.type === 'chunk') {
      assert.ok(frame.length > 0 && frame.length <= MAX_STREAM_CHUNK);
      chunks.push(wire.subarray(offset, offset + frame.length));
      offset += frame.length;
    }
  }
  return { frames, body: Buffer.concat(chunks) };
}

test('ISR wire metadata delimits exact HTML and JSON bytes across binary chunks without base64 wrapping', async () => {
  const html = Buffer.from('<p>é🚀</p>'.repeat(10_000));
  const data = Buffer.from(JSON.stringify({ pageProps: { text: 'hello\nworld' }, __N_SSG: true }));
  const writes = [];
  const output = createProtocolOutput((value, callback) => { writes.push(Buffer.from(value)); callback(); });
  const isr = { revalidate: 2, htmlLength: html.length, dataLength: data.length };
  // Internal generation must remain complete even if a HEAD triggered it;
  // suppressing the public HEAD body is the native server's responsibility.
  await output(17, { status: 200, headers: { 'content-type': 'text/html' }, isr, body: [html, data] }, { stream: true, method: 'HEAD' });
  const decoded = decodeFrames(Buffer.concat(writes));
  assert.deepEqual(decoded.frames[0], { id: 17, type: 'head', status: 200, headers: { 'content-type': 'text/html' }, isr });
  assert.deepEqual(decoded.body.subarray(0, isr.htmlLength), html);
  assert.deepEqual(decoded.body.subarray(isr.htmlLength), data);
  assert.deepEqual(decoded.frames.at(-1), { id: 17, type: 'end' });
});

test('Pages API res.revalidate waits for the private operation and forwards onlyGenerated in buffered and streaming modes', async t => {
  const operations = [];
  let release;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/pages/revalidate');
    assert.equal(request.headers.authorization, 'Bearer private-token');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    operations.push(JSON.parse(Buffer.concat(chunks)));
    await new Promise(resolve => { release = resolve; });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ revalidated: true }));
  });
  const previous = { url: process.env.RUSTYX_CACHE_URL, token: process.env.RUSTYX_CACHE_TOKEN };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.RUSTYX_CACHE_URL = `http://127.0.0.1:${server.address().port}/cache`;
  process.env.RUSTYX_CACHE_TOKEN = 'private-token';
  try {
    const modulePath = await fixture(t, `exports.default=async(req,res)=>{const result=await res.revalidate((req.query.mounted?'/docs':'')+'/café?ignored=1',{unstable_onlyGenerated:true});res.json({done:result===undefined});};`);
    for (const [stream, mounted] of [[false, false], [true, false], [false, true], [true, true]]) {
      release = undefined;
      let completed = false;
      const pending = runApi({ modulePath, url: 'http://app.test/api/revalidate' + (mounted ? '?mounted=1' : ''), stream,
        manifest: { config: { basePath: mounted ? '/docs' : '' } } }).then(value => { completed = true; return value; });
      while (!release) await delay(1);
      assert.equal(completed, false);
      release();
      const response = await pending;
      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.concat(await Array.fromAsync(response.body));
      assert.deepEqual(JSON.parse(body), { done: true });
      await response.finalizeCache();
    }
    assert.deepEqual(operations, Array(4).fill({ path: '/caf%C3%A9', onlyGenerated: true }));
  } finally {
    release?.();
    if (previous.url === undefined) delete process.env.RUSTYX_CACHE_URL; else process.env.RUSTYX_CACHE_URL = previous.url;
    if (previous.token === undefined) delete process.env.RUSTYX_CACHE_TOKEN; else process.env.RUSTYX_CACHE_TOKEN = previous.token;
    await new Promise(resolve => server.close(resolve));
  }
});

test('res.revalidate rejects invalid paths, use after headers, and non-API responses before any network request', async () => {
  const response = new CapturedResponse(undefined, true);
  for (const value of ['relative', 'https://host/path', '//host/path', '/bad\\path', '/bad\npath', 1]) await assert.rejects(response.revalidate(value), /application path/);
  await assert.rejects(response.revalidate('/ok', { unstable_onlyGenerated: 'yes' }), /boolean/);
  await assert.rejects(new CapturedResponse().revalidate('/ok'), /only available in Pages API/);
  response.flushHeaders();
  await assert.rejects(response.revalidate('/ok'), /before sending response headers/);
});

test('res.revalidate propagates private errors without retrying and aborts with API cancellation or header timeout', async t => {
  const operations = [];
  let started, closed;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const operation = JSON.parse(Buffer.concat(chunks));
    operations.push(operation.path);
    if (operation.path === '/failed') { response.writeHead(500).end('failed'); return; }
    if (operation.path === '/malformed') { response.end('null'); return; }
    if (operation.path === '/skipped') { response.end('{"revalidated":false}'); return; }
    response.once('close', () => closed?.());
    started?.();
  });
  const previous = { url: process.env.RUSTYX_CACHE_URL, token: process.env.RUSTYX_CACHE_TOKEN };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.RUSTYX_CACHE_URL = `http://127.0.0.1:${server.address().port}/cache`;
  process.env.RUSTYX_CACHE_TOKEN = 'private-token';
  try {
    const response = new CapturedResponse(undefined, true);
    await assert.rejects(response.revalidate('/failed'), /Failed to revalidate.*500/);
    await assert.rejects(response.revalidate('/malformed'), /Invalid Rustyx page revalidation response/);
    assert.equal(await response.revalidate('/skipped', { unstable_onlyGenerated: true }), undefined);
    const modulePath = await fixture(t, `exports.default=async(_req,res)=>{await res.revalidate('/pending');res.end('done');};`);
    for (const mode of ['cancel', 'timeout']) {
      const controller = new AbortController();
      const began = new Promise(resolve => { started = resolve; });
      const disconnected = new Promise(resolve => { closed = resolve; });
      const pending = runApi({ modulePath, url: 'http://app/api/revalidate', stream: true, signal: controller.signal, timeoutMs: mode === 'timeout' ? 100 : 5000 });
      // Attach before triggering cancellation; neither branch may leave an
      // unhandled private fetch rejection after the outer API has completed.
      const rejected = assert.rejects(pending, mode === 'timeout' ? /timed out/ : /canceled by test/);
      await began;
      if (mode === 'cancel') controller.abort(new Error('canceled by test'));
      await rejected;
      await Promise.race([disconnected, delay(2000, undefined, { ref: false }).then(() => { throw new Error('Private revalidation outlived API cancellation'); })]);
    }
    assert.deepEqual(operations, ['/failed', '/malformed', '/skipped', '/pending', '/pending']);
  } finally {
    if (previous.url === undefined) delete process.env.RUSTYX_CACHE_URL; else process.env.RUSTYX_CACHE_URL = previous.url;
    if (previous.token === undefined) delete process.env.RUSTYX_CACHE_TOKEN; else process.env.RUSTYX_CACHE_TOKEN = previous.token;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
