import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { renderPageRequest, prerenderRoute, renderIsrPage } from './render.mjs';
import { renderPageError, summarizePageFailure, restorePageFailure } from './pages-errors.mjs';
import { createProtocolOutput } from './transport.mjs';
const require = createRequire(import.meta.url);
const react = JSON.stringify(require.resolve('react'));
const dom = JSON.stringify(require.resolve('react-dom/server'));
function payload(result) {
  const window = {};
  vm.runInNewContext(result.body.toString().match(/<script>(window\.__PRNEXT_DATA__=[\s\S]*?)<\/script>/)[1], { window });
  return JSON.parse(JSON.stringify(window.__PRNEXT_DATA__));
}
async function fixture(t, errorCode, pageCode = 'exports.getServerSideProps=()=>{throw Error("PRIVATE_ORIGIN_ERROR")};exports.default=()=>null;') {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-error-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'error.cjs'), errorCode);
  await writeFile(path.join(root, 'page.cjs'), pageCode);
  return { distDir: root, modulePath: path.join(root, 'page.cjs'), route: { id: 'page', pattern: '/outcome/[mode]' },
    url: 'http://localhost/outcome/data?injected=destination', params: { mode: 'data' },
    originalUrl: 'http://localhost/docs/_prnext/data/build/alias.json?visible=yes', renderMode: 'data',
    manifest: { config: { basePath: '/docs' }, pagesErrors: { error: 'error' }, routes: [
      { id: 'error', pattern: '/_error', module: 'error.cjs', internal: true, client: '/error.js' } ] } };
}
const normalError = `const React=require(${react});exports.default=props=>React.createElement('p',null,props.statusCode);
exports.App=({Component,pageProps})=>React.createElement('main',null,React.createElement(Component,pageProps));
exports.default.getInitialProps=ctx=>{ctx.res.setHeader('set-cookie',['error=1','second=2']); return {statusCode:ctx.res.statusCode,
  seen:{pathname:ctx.pathname,asPath:ctx.asPath,query:ctx.query,url:ctx.req.url,realError:ctx.err?.message==='PRIVATE_ORIGIN_ERROR',absent:undefined},
  appTree:require(${dom}).renderToStaticMarkup(React.createElement(ctx.AppTree,{pageProps:{statusCode:499}}))};};`;

test('_error GIP receives original data URL, visible query, real error and usable AppTree', async t => {
  const options = await fixture(t, normalError);
  const result = await renderPageRequest(options);
  assert.equal(result.status, 500);
  assert.match(result.headers['cache-control'], /private.*no-store/);
  assert.deepEqual(result.headers['set-cookie'], ['error=1', 'second=2']);
  const value = payload(result);
  assert.equal(value.router.pathname, '/_error');
  assert.equal(value.router.asPath, '/alias?visible=yes');
  assert.deepEqual(value.props.seen, { pathname: '/_error', asPath: '/alias?visible=yes', query: { visible: 'yes' }, url: '/_prnext/data/build/alias.json?visible=yes', realError: true });
  assert.equal(value.props.appTree, '<main><p>499</p></main>');
  assert.doesNotMatch(result.body.toString(), /PRIVATE_ORIGIN_ERROR/);
});

test('notFound selects error HTML with data-function headers but data requests stay JSON', async t => {
  const options = await fixture(t, normalError, `exports.default=()=>null;exports.getServerSideProps=({res})=>{res.setHeader('x-origin','yes');return {notFound:true}}`);
  const html = await renderPageRequest({ ...options, renderMode: undefined });
  assert.equal(html.status, 404);
  assert.equal(html.headers['x-origin'], 'yes');
  assert.equal(payload(html).props.statusCode, 404);
  const data = await renderPageRequest(options);
  assert.equal(data.status, 404);
  assert.deepEqual(JSON.parse(data.body), { notFound: true });
});

test('explicit response endings retain their body and status instead of invoking error pages', async t => {
  const options = await fixture(t, normalError, `exports.default=()=>null;exports.getServerSideProps=({res})=>res.status(404).end('application response')`);
  const result = await renderPageRequest(options);
  assert.equal(result.status, 404);
  assert.equal(result.body.toString(), 'application response');
});

test('a broken error page falls back once without leaking either original or fallback exception', async t => {
  const options = await fixture(t, `exports.default=()=>{throw Error('PRIVATE_FALLBACK_ERROR')}`);
  const result = await renderPageRequest(options);
  assert.equal(result.status, 500);
  assert.match(result.body.toString(), /Internal Server Error/);
  assert.doesNotMatch(result.body.toString(), /PRIVATE_/);
});

test('native error selection uses a zero-body marker and static error pages reject notFound', async t => {
  const options = await fixture(t, normalError);
  const route = { id: 'not-found', pattern: '/404', module: 'page.cjs', errorStatus: 404 };
  const manifest = { ...options.manifest, pagesErrors: { notFound: route.id }, routes: [route], prerendered: [{ path: '/404', file: '404.html' }] };
  const result = await renderPageError({ ...options, manifest, nativeErrors: true }, { statusCode: 404 });
  assert.equal(result.pageError, 404);
  assert.equal(result.body.length, 0);
  assert.match(result.headers['cache-control'], /private/);
  await writeFile(path.join(options.distDir, 'bad404.cjs'), 'exports.default=()=>null;exports.getStaticProps=()=>({notFound:true});');
  await assert.rejects(prerenderRoute({ modulePath: path.join(options.distDir, 'bad404.cjs'), route }), /404 page cannot return notFound/);
});

test('private ISR failure metadata reconstructs the original error for _error without replaying GSP', async t => {
  const options = await fixture(t, `const React=require(${react});exports.default=()=>React.createElement('p',null,'generic error');
    exports.default.getInitialProps=({err,asPath,req,query})=>({statusCode:500,original:err instanceof Error && err.name==='RangeError' && err.message==='PRIVATE_GSP_FAILURE' && err.code==='E_GSP' && err.statusCode===503,asPath,url:req.url,query});`,
    `exports.default=()=>null;let calls=0;exports.getStaticProps=()=>{if(++calls!==1)throw Error('REPLAYED');const error=new RangeError('PRIVATE_GSP_FAILURE');error.code='E_GSP';error.statusCode=503;throw error};`);
  const result = await renderIsrPage({ ...options, originalUrl: undefined, capturePageFailure: true });
  const chunks = [];
  await createProtocolOutput((chunk, callback) => { chunks.push(Buffer.from(chunk)); callback(); })(1, result, { stream: true });
  const frame = JSON.parse(Buffer.concat(chunks).toString().split('\n')[0]);
  assert.equal(frame.pageFailure.message, 'PRIVATE_GSP_FAILURE');
  assert.equal(frame.status, 500);
  assert.deepEqual(result.body, Buffer.alloc(0));
  assert.equal(result.isr, undefined);
  const rendered = await renderPageRequest({ ...options, renderMode: 'error500', pageFailure: frame.pageFailure });
  assert.equal(rendered.status, 500);
  const value = payload(rendered);
  assert.equal(value.props.original, true);
  assert.equal(value.props.asPath, '/alias?visible=yes');
  assert.equal(value.props.url, '/_prnext/data/build/alias.json?visible=yes');
  assert.deepEqual(value.props.query, { visible: 'yes' });
  assert.doesNotMatch(rendered.body.toString(), /PRIVATE_GSP_FAILURE|RangeError|E_GSP/);
});

test('private error summaries bound UTF-8 fields and discard arbitrary object graphs', () => {
  const summary = summarizePageFailure({ message: '\0'.repeat(100_000), name: 'é'.repeat(1000), stack: '🙂'.repeat(10_000), code: { cycle: null }, statusCode: 999, extra: 'not copied' });
  assert.ok(Buffer.byteLength(summary.message) <= 2048);
  assert.ok(Buffer.byteLength(summary.name) <= 128);
  assert.ok(Buffer.byteLength(summary.stack) <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 64 * 1024);
  assert.equal(summary.code, undefined);
  assert.equal(summary.statusCode, undefined);
  assert.equal(summary.extra, undefined);
  const restored = restorePageFailure({ name: '\ud800', message: 'message' });
  assert.ok(restored instanceof Error);
  assert.equal(restored.name, '\ufffd');
  const getter = { get message() { throw Error('getter'); } };
  assert.equal(summarizePageFailure(getter).message, 'Page generation failed');
});

test('ISR logging cannot replace a thrown error whose stack getter also throws', async t => {
  const options = await fixture(t, normalError, `exports.default=()=>null;exports.getStaticProps=()=>{throw {message:'original failure',get stack(){throw Error('getter failure')}}};`);
  const result = await renderIsrPage({ ...options, capturePageFailure: true });
  assert.equal(result.status, 500);
  assert.equal(result.pageFailure.message, 'original failure');
  assert.equal(result.pageFailure.stack, undefined);
});
