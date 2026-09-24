import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { renderPage, renderPageData, prerenderRoute, renderIsrPage } from './render.mjs';
const require = createRequire(import.meta.url);
const react = JSON.stringify(require.resolve('react'));
const doc = JSON.stringify(require.resolve('../compat/document.cjs'));
const head = JSON.stringify(require.resolve('../compat/head.cjs'));
const script = JSON.stringify(require.resolve('../compat/script.cjs'));
async function fixture(t, code) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rustyx-document-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modulePath = path.join(dir, 'page.cjs');
  await writeFile(modulePath, `const React=require(${react});const Document=require(${doc});const{Html,Head,Main,NextScript}=Document;${code}`);
  return { modulePath, route: { pattern: '/page/[id]', client: '/resources/page.js', css: ['/resources/page.css'] }, params: { id: 'one' }, url: 'http://app/page/one?from=visible', production: true };
}
function payload(html) {
  const window = {};
  vm.runInNewContext(html.match(/window\.__RUSTYX_DATA__=JSON\.parse\(.+?\);(?=<\/script>)/s)[0], { window });
  return JSON.parse(JSON.stringify(window.__RUSTYX_DATA__));
}
const body = `React.createElement(Html,{lang:'fr'},React.createElement(Head,{nonce:'head-nonce'}),React.createElement('body',null,React.createElement(Main),React.createElement(NextScript,{nonce:'script-nonce'})))`;

test('Document enhancers render cached data props, return server-only properties and collect styles', async t => {
  const options = await fixture(t, `let dataCalls=0;exports.getServerSideProps=()=>({props:{count:++dataCalls}});exports.default=({count})=>React.createElement('p',null,count);let trace=[];
  exports.Document=class extends Document{static async getInitialProps(ctx){const render=ctx.renderPage;ctx.renderPage=()=>render({enhanceApp:App=>props=>{trace.push('app');return React.createElement(App,props)},enhanceComponent:Page=>props=>{trace.push('page');return React.createElement(Page,props)}});const first=await Document.getInitialProps(ctx);await ctx.renderPage();ctx.res.setHeader('x-render-trace',trace.join(','));return {...first,secret:'PRIVATE_DOCUMENT',fn:()=>42,styles:React.createElement('style',{id:'collected'},'p{color:red}')};}render(){return ${body}}};`);
  const result = await renderPage(options), html = result.body.toString();
  assert.equal(result.headers['x-render-trace'], 'app,page,app,page');
  assert.equal(payload(html).props.count, 1);
  assert.doesNotMatch(html, /PRIVATE_DOCUMENT|secret|"fn"/);
  assert.match(html, /<style id="collected">p\{color:red\}<\/style>/);
  assert.equal((html.match(/id="__rustyx"/g) || []).length, 1);
  assert.match(html, /<script type="module" src="\/resources\/page.js" nonce="head-nonce"/);
  assert.match(html, /<script nonce="script-nonce">window\.__RUSTYX_DATA__/);
});

test('Main inserts user-supplied html literally, including string replacement metacharacters', async t => {
  const literal = '<div id="__rustyx">$& $$ $` $\'</div>';
  const options = await fixture(t, `exports.default=()=>null;exports.Document=class extends Document{static getInitialProps(){return{html:${JSON.stringify(literal)},head:[]}}render(){return ${body}}};`);
  const result = await renderPage(options), html = result.body.toString();
  assert.match(html, /<div id="__rustyx">\$& \$\$ \$` \$'<\/div>/);
  assert.doesNotMatch(html, /rustyx-document-body-target/);
});

test('page head overrides default viewport and charset while Document head preserves its own children', async t => {
  const options = await fixture(t, `const PageHead=require(${head});exports.default=()=>React.createElement(PageHead,null,React.createElement('meta',{name:'viewport',content:'custom viewport'}),React.createElement('meta',{charSet:'iso-8859-1'}),React.createElement('meta',{name:'description',content:'page'}));exports.Document=()=>React.createElement(Html,null,React.createElement(Head,null,React.createElement('meta',{name:'description',content:'document'})),React.createElement('body',null,React.createElement(Main),React.createElement(NextScript)));`);
  const html = (await renderPage(options)).body.toString();
  assert.equal((html.match(/name="viewport"/g) || []).length, 1);
  assert.match(html, /content="custom viewport"/);
  assert.equal((html.match(/charSet=/gi) || []).length, 1);
  assert.match(html, /iso-8859-1/);
  assert.equal((html.match(/name="description"/g) || []).length, 2);
});

test('Document has no request for automatic static pages, but GSP and SSR have request contexts', async t => {
  const code = `exports.default=()=>React.createElement('p',null,'page');exports.Document=class extends Document{static async getInitialProps(ctx){return{...await super.getInitialProps(ctx),seen:JSON.stringify({req:!!ctx.req,res:!!ctx.res,query:ctx.query,path:ctx.pathname})}}render(){return React.createElement(Html,null,React.createElement(Head),React.createElement('body',{'data-seen':this.props.seen},React.createElement(Main),React.createElement(NextScript)))}};`;
  const auto = await fixture(t, code);
  assert.match((await prerenderRoute(auto)).body, /&quot;req&quot;:false,&quot;res&quot;:false/);
  for (const method of ['getStaticProps', 'getServerSideProps']) {
    const options = await fixture(t, `${code}exports.${method}=()=>({props:{}});`);
    assert.match((await renderPage(options)).body.toString(), /&quot;req&quot;:true,&quot;res&quot;:true/);
  }
});

test('concurrent documents isolate async request state and JSON requests never execute Document', async t => {
  const options = await fixture(t, `exports.default=()=>React.createElement('p',null,'page');exports.getServerSideProps=()=>({props:{}});exports.Document=class extends Document{static async getInitialProps(ctx){if(ctx.query.json)throw Error('Document must not run');const visitor=ctx.req.headers.cookie;await new Promise(resolve=>setTimeout(resolve,5));ctx.res.setHeader('x-visitor',visitor);return{...await super.getInitialProps(ctx),visitor}}render(){return React.createElement(Html,null,React.createElement(Head),React.createElement('body',{'data-visitor':this.props.visitor},React.createElement(Main),React.createElement(NextScript)))}};`);
  const [a,b] = await Promise.all(['a','b'].map(visitor => renderPage({ ...options, headers: { cookie: visitor } })));
  assert.equal(a.headers['x-visitor'], 'a'); assert.equal(b.headers['x-visitor'], 'b');
  assert.match(a.body.toString(), /data-visitor="a"/); assert.match(b.body.toString(), /data-visitor="b"/);
  const data = await renderPageData({ ...options, url: 'http://app/page/one?json=yes' });
  assert.equal(data.status, 200); assert.deepEqual(JSON.parse(data.body).pageProps, {});
});

test('Document validates its html contract and honors an explicitly ended response', async t => {
  const invalid = await fixture(t, `exports.default=()=>null;exports.Document=class extends Document{static getInitialProps(){return{html:42}}};`);
  await assert.rejects(renderPage(invalid), /Document.getInitialProps.*html string/);
  const ended = await fixture(t, `exports.default=()=>{throw Error('page render should not run')};exports.getServerSideProps=()=>({props:{}});exports.Document=class extends Document{static getInitialProps(ctx){ctx.res.statusCode=418;ctx.res.end('document response');return {}}};`);
  const result = await renderPage(ended);
  assert.equal(result.status, 418); assert.equal(result.body.toString(), 'document response');
});

test('Document sees first-caller ISR request while GSP, router and data stay canonical', async t => {
  const options = await fixture(t, `exports.getStaticProps=({params,...context})=>({props:{id:params.id,contextKeys:Object.keys(context)}});exports.default=({id})=>React.createElement('p',null,id);exports.Document=class extends Document{static async getInitialProps(ctx){ctx.res.setHeader('x-document-url',ctx.req.url);ctx.res.setHeader('x-document-cookie',ctx.req.cookies.visitor);ctx.res.setHeader('x-document-query',JSON.stringify(ctx.query));ctx.res.setHeader('x-document-aspath',ctx.asPath);return super.getInitialProps(ctx)}render(){return ${body}}};`);
  const result = await renderIsrPage({ ...options, manifest: { config: { basePath: '/docs' } },
    documentRequest: { url: '/page/one?injected=rule', originalUrl: 'http://app/docs/_rustyx/data/build/alias.json?visible=secret', method: 'HEAD', headers: { cookie: 'visitor=PRIVATE_COOKIE' } } });
  assert.equal(result.headers['x-document-url'], '/_rustyx/data/build/alias.json?visible=secret');
  assert.equal(result.headers['x-document-cookie'], 'PRIVATE_COOKIE');
  assert.equal(result.headers['x-document-query'], '{"id":"one"}');
  assert.equal(result.headers['x-document-aspath'], '/page/one');
  const data = JSON.parse(result.body[1]);
  assert.equal(data.__RUSTYX_ROUTER__.asPath, '/page/one');
  assert.deepEqual(data.__RUSTYX_ROUTER__.query, { id: 'one' });
  assert.deepEqual(data.pageProps.contextKeys, ['preview', 'previewData', 'draftMode', 'revalidateReason']);
  assert.doesNotMatch(Buffer.concat(result.body).toString(), /PRIVATE_COOKIE|visible=secret|injected=rule/);
  const repeatedSlash = await renderIsrPage({ ...options, documentRequest: { url: '//page/one?visible=secret', method: 'GET', headers: { cookie: 'visitor=test' } } });
  assert.equal(repeatedSlash.headers['x-document-url'], '//page/one?visible=secret');
});

test('legacy renderPage enhancer works and automatic document context is normalized in development', async t => {
  const options = await fixture(t, `exports.default=()=>React.createElement('p',null,'original');exports.Document=class extends Document{static async getInitialProps(ctx){const result=await ctx.renderPage(Page=>props=>React.createElement('section',null,React.createElement(Page,props)));return{...result,seen:JSON.stringify({query:ctx.query,asPath:ctx.asPath,req:!!ctx.req})}}render(){return React.createElement(Html,null,React.createElement(Head),React.createElement('body',{'data-seen':this.props.seen},React.createElement(Main),React.createElement(NextScript)))}};`);
  const result = await renderPage({ ...options, production: false });
  assert.match(result.body.toString(), /<div id="__rustyx"><section><p>original<\/p><\/section><\/div>/);
  assert.match(result.body.toString(), /&quot;query&quot;:\{\},&quot;asPath&quot;:&quot;\/page\/\[id\]&quot;,&quot;req&quot;:false/);
});

test('built-in error documents receive public error paths and a request despite synthetic route storage', async t => {
  const options = await fixture(t, `exports.default=()=>null;exports.Document=class extends Document{static async getInitialProps(ctx){return{...await super.getInitialProps(ctx),seen:JSON.stringify({pathname:ctx.pathname,asPath:ctx.asPath,url:ctx.req?.url,status:ctx.res?.statusCode})}}render(){return React.createElement(Html,null,React.createElement(Head),React.createElement('body',{'data-seen':this.props.seen,'data-aspath':this.props.dangerousAsPath},React.createElement(Main),React.createElement(NextScript)))}};`);
  for (const errorStatus of [404, 500]) {
    const pattern = `/_rustyx/errors/${errorStatus}`;
    const result = await prerenderRoute({ ...options, path: pattern, route: { ...options.route, pattern, internal: true, errorStatus } });
    assert.match(result.body, new RegExp('&quot;pathname&quot;:&quot;/_error&quot;,&quot;asPath&quot;:&quot;/' + errorStatus + '&quot;,&quot;url&quot;:&quot;/' + errorStatus + '&quot;,&quot;status&quot;:' + errorStatus));
    assert.match(result.body, new RegExp('data-aspath="/' + errorStatus + '"'));
  }
});

test('Document assetPrefix falls back to basePath while an explicit root prefix stays root', async t => {
  const options = await fixture(t, `exports.default=()=>null;exports.Document=props=>React.createElement(Html,null,React.createElement(Head),React.createElement('body',{'data-prefix':props.assetPrefix,'data-data-prefix':props.__NEXT_DATA__.assetPrefix},React.createElement(Main),React.createElement(NextScript)));`);
  for (const assetPrefix of ['', '/']) {
    const result = await renderPage({ ...options, manifest: { config: { basePath: '/docs', assetPrefix } } });
    assert.match(result.body.toString(), new RegExp('data-prefix="' + (assetPrefix || '/docs') + '" data-data-prefix="' + (assetPrefix || '/docs') + '"'));
  }
});

test('Page and late Document scripts are collected in one render, with Pages ordering and escaped loader data', async t => {
  const options = await fixture(t, `const Script=require(${script});let pages=0,documents=0;
    exports.default=()=>{pages++;return React.createElement(React.Fragment,null,
      React.createElement('p',{'data-page-renders':pages},'page'),
      React.createElement(Script,{id:'page-external',src:'/first.js',strategy:'beforeInteractive',nonce:'explicit',integrity:'sha256-test'}),
      React.createElement(Script,{id:'page-inline',strategy:'beforeInteractive'},'window.first=true;'))};
    exports.Document=class extends Document{static async getInitialProps(ctx){return{...await super.getInitialProps(ctx),nonce:'document-nonce'}}
      render(){documents++;return React.createElement(Html,null,React.createElement(Head,{nonce:'head-nonce',crossOrigin:'anonymous'}),
        React.createElement('body',{'data-document-renders':documents},React.createElement(Main),React.createElement(NextScript,{nonce:this.props.nonce}),
          React.createElement(Script,{id:'doc-before',strategy:'beforeInteractive'},'window.last=true;'),
          React.createElement(Script,{id:'late-document',src:'/late.js',onLoad:()=>{throw Error('server callback')} }),
          React.createElement(Script,{id:'safe-json',strategy:'lazyOnload'},'window.text="</script><div>text</div>";')))}};`);
  const html = (await renderPage(options)).body.toString();
  assert.match(html, /data-page-renders="1"/); assert.match(html, /data-document-renders="1"/);
  const documentHead = html.match(/<head[^>]*>([\s\S]*?)<\/head>/)[1];
  const ids = [...documentHead.matchAll(/<script[^>]*id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['page-inline', 'doc-before', 'page-external']);
  assert.ok(documentHead.indexOf('id="page-external"') < documentHead.indexOf('type="module"'));
  assert.match(documentHead, /src="\/first.js"[^>]*nonce="explicit"[^>]*integrity="sha256-test"[^>]*defer=""/);
  assert.match(documentHead, /<script[^>]*id="doc-before"[^>]*nonce="head-nonce"[^>]*crossorigin="anonymous"/);
  assert.match(documentHead, /<link[^>]*href="\/first.js"[^>]*crossorigin="anonymous"/);
  const serialized = html.match(/<script[^>]*id="__RUSTYX_SCRIPT_LOADER__"[^>]*>([\s\S]*?)<\/script>/)[1];
  const descriptors = JSON.parse(serialized);
  assert.deepEqual(descriptors.map(item => item.id), ['late-document', 'safe-json']);
  assert.equal(descriptors[0].onLoad, undefined);
  assert.equal(descriptors[1].children, 'window.text="</script><div>text</div>";');
  assert.doesNotMatch(serialized, /<script|<div>/);
});

test('Document base URLs and custom Partytown configuration precede script initialization', async t => {
  const options = await fixture(t, `const Script=require(${script});exports.default=()=>React.createElement(Script,{src:'relative.js',strategy:'beforeInteractive'});
    exports.Document=()=>React.createElement(Html,null,React.createElement(Head,null,React.createElement('base',{href:'/relative-base/'}),
      React.createElement('script',{'data-partytown-config':'',dangerouslySetInnerHTML:{__html:"partytown={lib:'/custom/'};"}})),
      React.createElement('body',null,React.createElement(Main),React.createElement(NextScript)));`);
  options.manifest = { scriptWorkers: { lib: '/default/', snippet: 'window.observedPartytown=partytown.lib;' } };
  const html = (await renderPage(options)).body.toString();
  assert.ok(html.indexOf('<base') < html.indexOf('href="relative.js"'));
  assert.ok(html.indexOf('data-partytown-config') < html.indexOf('data-partytown=""'));
  assert.doesNotMatch(html, /rustyx-document-script-target|\/default\//);
  const context = { window: {} };
  for (const [, attrs, content] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/data-partytown(?:-config)?=/.test(attrs)) vm.runInNewContext(content, context);
  }
  assert.equal(context.window.observedPartytown, '/custom/');
});
