import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import DefaultApp, { loadGetInitialProps } from '../compat/app.cjs';
import { renderPage, renderIsrPage } from './render.mjs';

const require = createRequire(import.meta.url);
const react = JSON.stringify(require.resolve('react'));
const app = JSON.stringify(require.resolve('../compat/app.cjs'));
async function fixture(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-initial-props-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'page.cjs');
  await writeFile(modulePath, `const React=require(${react});const DefaultApp=require(${app});${source}`);
  return { modulePath, url: 'http://localhost/page/one?visible=yes', params: { id: 'one' }, route: { pattern: '/page/[id]' }, production: true };
}
function payload(result) {
  const source = result.body.toString().match(/<script>(window\.__RUSTYX_DATA__=[\s\S]*?)<\/script>/)[1];
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.__RUSTYX_DATA__));
}

test('Default App delegates once, preserves hook ownership and accepts loose JSON values', async () => {
  let calls = 0;
  const Page = Object.assign(() => null, { getInitialProps(context) { calls++; return { missing: undefined, when: new Date(0), ctx: context.marker }; } });
  class Inherited extends DefaultApp {}
  assert.equal(Inherited.getInitialProps, Inherited.origGetInitialProps);
  const props = await loadGetInitialProps(Inherited, { Component: Page, ctx: { marker: 42 } });
  assert.equal(calls, 1);
  assert.equal(props.pageProps.when.toISOString(), '1970-01-01T00:00:00.000Z');
  const CustomApp = Object.assign(() => null, { getInitialProps() { return { pageProps: { custom: true } }; } });
  assert.deepEqual(await loadGetInitialProps(CustomApp, { Component: Page, ctx: {} }), { pageProps: { custom: true } });
  assert.equal(calls, 1);
  for (const value of [undefined, null, false, 0, '']) {
    await assert.rejects(loadGetInitialProps({ getInitialProps: () => value }, {}), /must return an object/);
  }
});

test('App and Page initial props share request context and top-level props reach HTML and data once', async t => {
  const options = await fixture(t, `let pageCalls=0;let appCalls=0;
    exports.default=props=>React.createElement('p',null,props.context.asPath);
    exports.default.getInitialProps=ctx=>({pageCalls:++pageCalls,missing:undefined,date:new Date(0),context:{pathname:ctx.pathname,asPath:ctx.asPath,query:ctx.query,url:ctx.req.url,appTree:typeof ctx.AppTree}});
    exports.App=({Component,pageProps,top})=>React.createElement('section',{'data-top':top},React.createElement(Component,pageProps));
    exports.App.getInitialProps=async input=>{input.ctx.res.setHeader('x-app','yes');return {...await DefaultApp.getInitialProps(input),top:'TOP_PUBLIC',appCalls:++appCalls}};`);
  const html = await renderPage(options);
  assert.equal(html.headers['x-app'], 'yes');
  assert.match(html.body.toString(), /data-top="TOP_PUBLIC"/);
  const initial = payload(html);
  assert.equal(initial.props.pageCalls, 1); assert.equal(initial.appProps.appCalls, 1);
  assert.equal(initial.props.date, '1970-01-01T00:00:00.000Z');
  assert.equal(Object.hasOwn(initial.props, 'missing'), false);
  assert.deepEqual(initial.props.context, { pathname: '/page/[id]', asPath: '/page/one?visible=yes', query: { visible: 'yes', id: 'one' }, url: '/page/one?visible=yes', appTree: 'function' });
  const directData = await renderPage({ ...options, renderMode: 'data' });
  assert.match(directData.headers['content-type'], /text\/html/);
  const data = payload(directData);
  assert.equal(data.appProps.top, 'TOP_PUBLIC'); assert.equal(data.appProps.appCalls, 2); assert.equal(data.props.pageCalls, 2);
  const routing = JSON.parse((await renderPage({ ...options, renderMode: 'data', headers: { 'x-rustyx-navigation': '1' } })).body);
  assert.deepEqual(routing.pageProps, {}); assert.equal(routing.__RUSTYX_ROUTER__.pathname, '/page/[id]');
  const next = payload(await renderPage({ ...options, renderMode: 'data' }));
  assert.equal(next.props.pageCalls, 3); assert.equal(next.appProps.appCalls, 3);
});

test('middleware navigation performs server hooks and Document rendering before returning route metadata', async t => {
  const options = await fixture(t, `let calls=0;exports.default=()=>{calls++;return null};exports.default.getInitialProps=ctx=>{calls++;ctx.res.setHeader('x-hook',calls);return{}};
    exports.Document=class extends require(${JSON.stringify(require.resolve('../compat/document.cjs'))}){static async getInitialProps(ctx){const result=await super.getInitialProps(ctx);ctx.res.setHeader('x-document',++calls);return result}};`);
  const response = await renderPage({ ...options, renderMode: 'data', middlewareMatched: true, headers: { 'x-rustyx-navigation': '1' } });
  assert.equal(response.headers['x-hook'], '1'); assert.equal(response.headers['x-document'], '3');
  assert.equal(response.headers['x-rustyx-legacy-navigation'], '1');
  assert.deepEqual(JSON.parse(response.body).pageProps, {});
});

test('only matched legacy navigation marks explicit hook responses including arbitrary JSON and no-body statuses', async t => {
  for (const [status, text] of [[200, 'explicit text'], [200, '{"custom":true}'], [204, ''], [302, 'redirect body']]) {
    const options = await fixture(t, `exports.default=()=>{throw Error('must not render')};exports.default.getInitialProps=({res})=>{res.statusCode=${status};res.setHeader('set-cookie',['legacy=1']);${status === 302 ? "res.setHeader('location','/target');" : ''}res.end(${JSON.stringify(text)})};`);
    const result = await renderPage({ ...options, renderMode: 'data', middlewareMatched: true, headers: { 'x-rustyx-navigation': '1' } });
    assert.equal(result.status, status === 302 ? 200 : status);
    assert.equal(result.body.toString(), status === 302 ? '' : text);
    assert.equal(result.headers['x-rustyx-legacy-navigation'], '1');
    assert.deepEqual(result.headers['set-cookie'], ['legacy=1']);
    if (status === 302) {
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers['x-rustyx-legacy-location'], '/target');
    }
    const direct = await renderPage({ ...options, renderMode: 'data', middlewareMatched: true });
    assert.equal(direct.headers['x-rustyx-legacy-navigation'], undefined);
    assert.equal(direct.status, status); assert.equal(direct.body.toString(), text);
    if (status === 302) assert.equal(direct.headers.location, '/target');
    const unmatched = await renderPage({ ...options, renderMode: 'data', headers: { 'x-rustyx-navigation': '1' } });
    assert.equal(unmatched.headers['x-rustyx-legacy-navigation'], undefined);
    assert.deepEqual(JSON.parse(unmatched.body).pageProps, {});
  }
  const serverProps = await fixture(t, `exports.default=()=>null;exports.App=class extends DefaultApp{static getInitialProps({ctx}){ctx.res.end('SSP explicit');return{pageProps:{}}}};exports.getServerSideProps=()=>{throw Error('already ended')};`);
  const strict = await renderPage({ ...serverProps, renderMode: 'data', middlewareMatched: true, headers: { 'x-rustyx-navigation': '1' } });
  assert.equal(strict.body.toString(), 'SSP explicit');
  assert.equal(strict.headers['x-rustyx-legacy-navigation'], undefined);
});

test('legacy middleware navigation also marks a custom Document explicit response', async t => {
  const options = await fixture(t, `exports.default=()=>{throw Error('Document ends first')};exports.default.getInitialProps=()=>({});exports.Document=class extends require(${JSON.stringify(require.resolve('../compat/document.cjs'))}){static getInitialProps(ctx){ctx.res.statusCode=202;ctx.res.end('Document explicit')}};`);
  const response = await renderPage({ ...options, renderMode: 'data', middlewareMatched: true, headers: { 'x-rustyx-navigation': '1' } });
  assert.equal(response.status, 202); assert.equal(response.body.toString(), 'Document explicit');
  assert.equal(response.headers['x-rustyx-legacy-navigation'], '1');
});

test('App hooks precede data functions, whose props win without discarding App props or loose values', async t => {
  for (const name of ['getStaticProps', 'getServerSideProps']) {
    const options = await fixture(t, `const trace=[];exports.default=()=>null;
      exports.App=DefaultApp;class CustomApp extends DefaultApp{static getInitialProps(){trace.push('app');return{pageProps:{shared:'app',onlyApp:true,loose:undefined},extra:'top'}}};exports.App=CustomApp;
      exports.${name}=()=>{trace.push('data');return{props:{shared:'data',trace:[...trace]}}};`);
    const data = JSON.parse((await renderPage({ ...options, renderMode: 'data', headers: { 'x-rustyx-navigation': '1' } })).body);
    assert.deepEqual(data.pageProps, { shared: 'data', onlyApp: true, trace: ['app', 'data'] });
    assert.equal(data.extra, 'top');
    assert.equal(data[name === 'getStaticProps' ? '__N_SSG' : '__N_SSP'], true);
  }
});

test('AppTree is renderable from hooks and response ending prevents both page and Document rendering', async t => {
  const options = await fixture(t, `exports.default=({message})=>React.createElement('p',null,message);
    exports.default.getInitialProps=ctx=>{const {renderToStaticMarkup}=require(${JSON.stringify(require.resolve('react-dom/server'))});return{message:renderToStaticMarkup(React.createElement(ctx.AppTree,{pageProps:{message:'tree'},top:'context'}))}};
    exports.App=({Component,pageProps,top})=>React.createElement('main',{'data-top':top},React.createElement(Component,pageProps));`);
  assert.match(payload(await renderPage(options)).props.message, /<main data-top="context"><p>tree<\/p><\/main>/);
  const ended = await fixture(t, `exports.default=()=>{throw Error('must not render')};exports.default.getInitialProps=({res})=>{res.statusCode=202;res.end('ended')};exports.Document=()=>{throw Error('must not render Document')};`);
  const response = await renderPage(ended);
  assert.equal(response.status, 202); assert.equal(response.body.toString(), 'ended');
});

test('ISR App request uses first visitor context while router and GSP stay canonical', async t => {
  const options = await fixture(t, `exports.default=()=>null;exports.App=class extends DefaultApp{static getInitialProps({ctx}){return{pageProps:{},seen:{url:ctx.req.url,cookie:ctx.req.cookies.visitor,asPath:ctx.asPath,query:ctx.query}}}};
    exports.getStaticProps=ctx=>({props:{params:ctx.params,hasRequest:'req' in ctx}});`);
  const rendered = await renderIsrPage({ ...options, documentRequest: { url: '/page/one?visible=private', method: 'GET', headers: { cookie: 'visitor=first' } } });
  const data = JSON.parse(rendered.body[1]);
  assert.deepEqual(data.seen, { url: '/page/one?visible=private', cookie: 'first', asPath: '/page/one', query: { id: 'one' } });
  assert.deepEqual(data.pageProps, { params: { id: 'one' }, hasRequest: false });
});

test('Page initial props cannot be combined with GSP or GSSP', async t => {
  for (const name of ['getStaticProps', 'getServerSideProps']) {
    const options = await fixture(t, `exports.default=()=>null;exports.default.getInitialProps=()=>({});exports.${name}=()=>({props:{}})`);
    await assert.rejects(renderPage(options), /cannot be combined/);
  }
});
