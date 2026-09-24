import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderAppPage, renderFlight, decodeFlight, renderHtml, closeAppRuntime } from './app-render.mjs';
import { errorResponse } from './render.mjs';

const fixtures = [];
after(async () => {
  await closeAppRuntime();
  await Promise.all(fixtures.map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(pageSource, clientModules = {}) {
  const root = await mkdtemp(fileURLToPath(new URL('./.app-test-', import.meta.url)));
  fixtures.push(root);
  const modulePath = path.join(root, 'page.mjs');
  await writeFile(modulePath, pageSource);
  return { modulePath, distDir: root, manifest: { app: { clientModules } }, url: 'http://localhost/article/hello?tag=a&tag=b', params: { slug: 'hello' } };
}

test('SSR manifest reuse follows changed module paths and build directories', async () => {
  const source = `import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    const Client=registerClientReference(()=>{},'client','default');
    export const page={default:()=>React.createElement(Client)};
    export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('body',null,children))}}];`;
  const modules={client:{ssrModule:'first.mjs'}};
  const first=await fixture(source,modules), second=await fixture(source,modules);
  for(const [options,file,label] of [[first,'first.mjs','first'],[first,'second.mjs','second'],[second,'second.mjs','other build']]) {
    await writeFile(path.join(options.distDir,file),`import React from 'react';export default ()=>React.createElement('p',null,${JSON.stringify(label)});`);
  }
  for(let i=0;i<2;i++)assert.match((await renderAppPage(first)).body.toString(),/<p>first<\/p>/);
  modules.client.ssrModule='second.mjs';
  assert.match((await renderAppPage(first)).body.toString(),/<p>second<\/p>/);
  assert.match((await renderAppPage(second)).body.toString(),/<p>other build<\/p>/);
  assert.match((await renderAppPage(first)).body.toString(),/<p>second<\/p>/);
});

test('async Server Components run with the react-server condition and compose nested layouts', async () => {
  const options = await fixture(`
    import React from 'react';
    export const page={default:async function Page({params,searchParams}) {
      if (React.useState !== undefined) throw new Error('Incorrect React environment');
      const {slug}=await params;
      const {tag}=await searchParams;
      return React.createElement('h1',null,slug+':'+tag.join(','));
    }};
    export const segments=[
      {layout:{default:async function Layout({children}){await Promise.resolve();return React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children));}}},
      {layout:{default:function Nested({children}){return React.createElement('section',{'data-layout':'nested'},children);}}}
    ];
  `);
  const result = await renderAppPage({ ...options, route: { client: '/_rustyx/app.js', css: ['/_rustyx/app.css'] } });
  assert.equal(result.status, 200);
  const html = result.body.toString();
  assert.match(html, /<section data-layout="nested"><h1>hello:a,b<\/h1><\/section>/);
  assert.match(html, /<link rel="stylesheet" href="\/_rustyx\/app.css">/);
  assert.match(html, /id="__RUSTYX_FLIGHT__"/);
  assert.match(html, /<script type="module" src="\/_rustyx\/app.js"><\/script>/);
  assert.equal(html.match(/<!DOCTYPE html>/g).length, 1);
});

test('layouts and their metadata/viewport receive only ancestor params while pages retain every param', async () => {
  const options = await fixture(`
    import React from 'react';
    async function check(params,expected){
      if(typeof params?.then!=='function')throw new Error('Params must be a Promise');
      const value=await params;
      if(JSON.stringify(value)!==JSON.stringify(expected))throw new Error('Incorrect scoped params: '+JSON.stringify(value));
      return Object.keys(value).join(',');
    }
    function layout(name,expected,root=false){return {
      default:async({params,children})=>{
        const keys=await check(params,expected);
        return root?React.createElement('html',null,React.createElement('head'),React.createElement('body',{'data-root-keys':keys},children)):
          React.createElement('section',{['data-'+name+'-keys']:keys},children);
      },
      generateMetadata:async({params})=>{await check(params,expected);return {description:name}},
      generateViewport:async({params})=>{await check(params,expected);return {initialScale:1}},
    }}
    const full={team:'red',item:'book'};
    export const page={
      default:async({params})=>React.createElement('p',{'data-page-keys':await check(params,full)},'Scoped page'),
      generateMetadata:async({params})=>{await check(params,full);return {title:'Scoped metadata'}},
      generateViewport:async({params})=>{await check(params,full);return {maximumScale:2}},
    };
    export const segments=[
      {path:'',segment:'',layout:layout('root',{},true)},
      {path:'[team]',segment:'[team]',layout:layout('team',{team:'red'}),template:{default:props=>{
        if(Object.keys(props).some(name=>name!=='children'))throw new Error('Template must receive only children');
        return React.createElement('div',{'data-template':'team'},props.children);
      }}},
      {path:'[team]/items',segment:'items'},
      {path:'[team]/items/[item]',segment:'[item]',layout:layout('item',full)},
    ];
  `);
  const result = await renderAppPage({ ...options, url: 'http://localhost/red/items/book', params: { team: 'red', item: 'book' } });
  const html = result.body.toString();
  assert.equal(result.status, 200);
  assert.match(html, /data-root-keys=""/);
  assert.match(html, /data-team-keys="team"/);
  assert.match(html, /data-item-keys="team,item"/);
  assert.match(html, /data-page-keys="team,item"/);
  assert.match(html, /<title>Scoped metadata<\/title>/);
  assert.match(html, /maximum-scale=2/);
});

test('real Flight preserves client references, rich values and server-rendered children', async () => {
  const options = await fixture(`
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    const Counter=registerClientReference(()=>{throw new Error('Client invoked in RSC')},'counter','Counter');
    export const page={default:async function Page(){
      return React.createElement(Counter,{date:new Date('2026-01-02T00:00:00Z'),values:new Map([['count',7]]),future:Promise.resolve('resolved')},React.createElement('strong',null,'Server child'));
    }};
    export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `, {
    counter: { ssrModule: 'counter.mjs', browserModule: '/_rustyx/counter.js' },
    unused: { ssrModule: 'unused.mjs', browserModule: '/_rustyx/unused.js' },
  });
  await writeFile(path.join(options.distDir, 'counter.mjs'), `
    import React from 'react';
    export function Counter({date,values,future,children}){
      const [count]=React.useState(values.get('count'));
      return React.createElement('div',{'data-date':date.toISOString()},React.createElement('button',null,count+':'+React.use(future)),children);
    }
  `);
  // Unused modules should never be imported by SSR. The whole app manifest can
  // contain client modules from unrelated routes and costly npm dependencies.
  await writeFile(path.join(options.distDir, 'unused.mjs'), `throw new Error('Unused client module was imported');`);
  const result = await renderAppPage(options);
  assert.match(result.body.toString(), /data-date="2026-01-02T00:00:00.000Z"/);
  assert.match(result.body.toString(), /<button>7:resolved<\/button><strong>Server child<\/strong>/);
  const flight = await renderAppPage({ ...options, headers: { RSC: '1' } });
  assert.equal(flight.headers['content-type'], 'text/x-component; charset=utf-8');
  assert.match(flight.body.toString(), /:I\["counter",\["counter",[^\n]+\],"Counter"\]/);
  assert.match(flight.body.toString(), /\/_rustyx\/counter.js/);
  assert.ok(!flight.body.toString().includes('<!DOCTYPE html>'));
});

test('a Client Component page receives serializable params and repeated searchParams', async () => {
  const options = await fixture(`
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    export const page={default:registerClientReference(()=>{},'client-page','default')};
    export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `, { 'client-page': { ssrModule: 'client-page.mjs', browserModule: '/client-page.js' } });
  await writeFile(path.join(options.distDir, 'client-page.mjs'), `
    import React from 'react';
    export default function Page({params,searchParams}){
      const values=React.use(searchParams);
      return React.createElement('p',null,React.use(params).slug+':'+values.tag.join(',')+':'+(Object.getPrototypeOf(values)===Object.prototype));
    }
  `);
  const response = await renderAppPage({ ...options, production: true, url: 'http://localhost/article/hello?tag=a&tag=b&__proto__=safe' });
  assert.equal(response.status, 200);
  assert.match(response.body.toString(), /<p>hello:a,b:true<\/p>/);
});

test('Server Component errors return a recovery document without killing the isolated runtime', async () => {
  const broken = await fixture(`export const page={default:async()=>{throw new Error('specific failure')}};`);
  const failed = await renderAppPage(broken);
  assert.equal(failed.status, 500);
  assert.match(failed.body.toString(), /<html id="__rustyx_error__">/);
  const healthy = await fixture(`
    import React from 'react';
    export const page={default:()=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,'recovered'))};
  `);
  assert.match((await renderAppPage(healthy)).body.toString(), /recovered/);
});

test('error recovery reuses the original Flight metadata without repeating its generator or layout', async () => {
  for (const stream of [false, true]) {
    const options = await fixture(`
      import React from 'react';
      import {appendFileSync} from 'node:fs';
      const count=name=>appendFileSync(new URL('./calls',import.meta.url),name+'\\n');
      export const page={default:()=>{count('page');throw new Error('PRIVATE_RECOVERY_FAILURE')}};
      export const segments=[{layout:{
        generateMetadata:async()=>{count('metadata');await Promise.resolve();return {title:'Original metadata'}},
        default:({children})=>{count('layout');return React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))},
      }}];
    `);
    const response = await renderAppPage({ ...options, stream, production: true });
    let html = '';
    if (stream) { for await (const chunk of response.body) html += chunk; }
    else html = response.body.toString();
    assert.equal(response.status, 500);
    assert.match(html, /<html id="__rustyx_error__">/);
    assert.match(html, /<title>Original metadata<\/title>/);
    assert.doesNotMatch(html, /PRIVATE_RECOVERY_FAILURE/);
    assert.deepEqual((await readFile(path.join(options.distDir, 'calls'), 'utf8')).trim().split('\n').sort(), ['layout', 'metadata', 'page']);
  }
});

test('invalid root layouts fail with an actionable error', async () => {
  const options = await fixture(`import React from 'react';export const page={default:()=>React.createElement('main',null,'no root')};`);
  await assert.rejects(renderAppPage(options), /root layout must render <html> and <body>/);
});

test('CSP nonces reach App Script queues and every executable HTML bootstrap including recovery streams', async () => {
  const options = await fixture(`
    import React from 'react';import{registerClientReference}from'react-server-dom-webpack/server.node';
    const Script=registerClientReference(()=>{},'script','default');
    export const page={default:async({searchParams})=>{
      if((await searchParams).fail)throw Error('PRIVATE_SCRIPT_FAILURE');
      return React.createElement(Script,{id:'before',strategy:'beforeInteractive',src:'/before.js'});
    }};
    export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `);
  options.manifest.app.clientModules.script = { ssrModule: path.relative(options.distDir, fileURLToPath(new URL('../compat/script.cjs', import.meta.url))), browserModule: '/script.js' };
  for (const stream of [false, true]) for (const fail of [false, true]) {
    const result = await renderAppPage({ ...options, stream, production: true, route: { client: '/client.js' },
      url: `http://localhost/?${fail ? 'fail=1' : ''}`, headers: { 'content-security-policy': "script-src 'nonce-test-nonce' 'strict-dynamic'" } });
    let html = '';
    if (stream) { for await (const chunk of result.body) html += chunk; }
    else html = result.body.toString();
    assert.equal(result.status, fail ? 500 : 200);
    const executable = [...html.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]).filter(attrs => !attrs.includes('application/octet-stream'));
    assert.ok(executable.length > 0);
    for (const attrs of executable) assert.match(attrs, /nonce="test-nonce"/);
    if (!fail) {
      assert.match(html, /__RUSTYX_SCRIPTS__/);
      assert.match(html, /<link[^>]*rel="preload"[^>]*href="\/before.js"[^>]*nonce="test-nonce"/);
    }
  }
});

test('production Flight excludes development component source and debug stacks', async () => {
  const options = await fixture(`
    import React from 'react';
    export const page={default:async function PRIVATE_SERVER_IMPLEMENTATION(){return React.createElement('html',null,React.createElement('head'),React.createElement('body',null,'safe public output'));}};
  `);
  const result = await renderAppPage({ ...options, production: true, headers: { rsc: '1' } });
  assert.match(result.body.toString(), /safe public output/);
  assert.ok(!result.body.toString().includes('PRIVATE_SERVER_IMPLEMENTATION'));
  assert.ok(!result.body.toString().includes('file:///'));
});

test('transferred Flight buffers retain exact bytes for small and multi-chunk responses', async () => {
  const options = await fixture(`
    import React from 'react';
    export const page={default:async({searchParams})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,React.createElement('p',null,'é🚀'.repeat(Number((await searchParams).size)))))};
  `);
  const retained = [];
  for (const size of [1, 20_000]) {
    const result = await renderFlight({ ...options, production: true, url: 'http://localhost/?size=' + size });
    assert.equal(result.body.byteOffset, 0);
    assert.equal(result.body.buffer.byteLength, result.body.byteLength);
    if (size === 1) assert.ok(result.body.byteLength < 4096, 'small Flight response must avoid the Node buffer pool');
    else assert.ok(result.body.byteLength > 100_000, 'large response must cross the Flight chunk boundary');
    retained.push({ bytes: result.body, snapshot: Buffer.from(result.body) });
    const model = await decodeFlight(result.body, {}, options.distDir);
    const html = await renderHtml(model.tree, model.router);
    assert.ok(html.includes('<p>' + 'é🚀'.repeat(size) + '</p>'));
  }
  // A later worker allocation and render must not mutate or detach buffers the
  // parent still owns after the transfer and React's decoder have consumed them.
  for (const { bytes, snapshot } of retained) assert.deepEqual(bytes, snapshot);
});

test('request headers and cookies stay isolated between concurrent RSC renders', async () => {
  const options = await fixture(`
    import React from 'react';
    import {headers,cookies} from '../../compat/headers.cjs';
    export const page={default:async function Page(){
      await new Promise(resolve=>setTimeout(resolve,5));
      return React.createElement('html',null,React.createElement('head'),React.createElement('body',null,(await headers()).get('x-test')+':'+(await cookies()).get('session').value));
    }};
  `);
  const [one, two] = await Promise.all([
    renderAppPage({ ...options, headers: { 'x-test': 'first', cookie: 'session=one' } }),
    renderAppPage({ ...options, headers: { 'x-test': 'second', cookie: 'session=two' } }),
  ]);
  assert.match(one.body.toString(), />first:one</);
  assert.match(two.body.toString(), />second:two</);
});

test('redirect signals return HTTP redirects and notFound renders its nearest segment boundary', async () => {
  const redirect = await fixture(`
    import {redirect} from '../../compat/navigation.cjs';
    export const page={default:async()=>redirect('/destination?value=a;b')};
  `);
  const redirected = await renderAppPage(redirect);
  assert.equal(redirected.status, 307);
  assert.equal(redirected.headers.location, '/destination?value=a;b');
  const missing = await fixture(`
    import React from 'react';
    import {notFound} from '../../compat/navigation.cjs';
    export const page={default:async()=>notFound()};
    export const segments=[
      {layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))},notFound:{default:()=>React.createElement('h1',null,'root missing')}},
      {layout:{default:({children})=>React.createElement('main',null,children)},notFound:{default:()=>React.createElement('h1',null,'nested missing')}}
    ];
  `);
  const html = await renderAppPage(missing);
  assert.equal(html.status, 404);
  assert.match(html.body.toString(), /<main><h1>nested missing<\/h1><\/main>/);
  assert.match(html.body.toString(), /name="robots" content="noindex"/);
  assert.ok(!html.body.toString().includes('root missing'));
  const flight = await renderAppPage({ ...missing, headers: { rsc: '1' } });
  assert.equal(flight.status, 404);
  assert.equal(flight.headers['content-type'], 'text/x-component; charset=utf-8');
});

test('async metadata travels through Flight and React hoists it into the document head', async () => {
  const options = await fixture(`
    import React from 'react';
    export const page={
      generateMetadata:async({params},parent)=>({title:(await params).slug,description:(await parent).description+' child'}),
      default:()=>React.createElement('main',null,'Content')
    };
    export const segments=[
      {path:'',layout:{metadata:{title:{default:'Site',template:'%s | Site'},description:'Root'},default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}},
      {path:'article/[slug]',segment:'[slug]'}
    ];
  `);
  const result = await renderAppPage(options);
  const head = result.body.toString().match(/<head>(.*?)<\/head>/s)?.[1];
  assert.match(head, /<title>hello \| Site<\/title>/);
  assert.match(head, /name="description" content="Root child"/);
  assert.match(head, /charSet="utf-8"/);
  assert.match(head, /name="viewport" content="width=device-width, initial-scale=1"/);
  const flight = await renderAppPage({ ...options, headers: { rsc: '1' }, production: true });
  assert.match(flight.body.toString(), /hello \| Site/);
});

test('server failures preserve sanitized Flight for client error boundaries in an empty 500 document', async () => {
  const options = await fixture(`
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    export const ErrorBoundary=registerClientReference(()=>{},'boundary','default');
    const ErrorUI=registerClientReference(()=>{},'error-ui','default');
    export const page={default:async()=>{throw new Error('PRIVATE_DATABASE_PASSWORD failure')}};
    export const segments=[
      {path:'',layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}},
      {path:'article',error:{default:ErrorUI}}
    ];
  `, {
    boundary: { ssrModule: '../../compat/app-error-boundary.cjs', browserModule: '/boundary.js' },
    'error-ui': { ssrModule: 'error-ui.mjs', browserModule: '/error-ui.js' },
  });
  await writeFile(path.join(options.distDir, 'error-ui.mjs'), `
    import React from 'react';
    export default function ErrorUI({error,reset}){
      if (!(error instanceof Error)) throw new Error('Error UI requires an Error object');
      return React.createElement('div',{'data-error-digest':error.digest},React.createElement('h1',null,error.message),React.createElement('button',{onClick:reset},'Retry'));
    }
  `);
  const html = await renderAppPage({ ...options, production: true });
  assert.equal(html.status, 500);
  assert.match(html.body.toString(), /<html id="__rustyx_error__">/);
  assert.doesNotMatch(html.body.toString(), /<h1|data-error-digest=/);
  assert.ok(!html.body.toString().includes('PRIVATE_DATABASE_PASSWORD'));
  const flight = await renderAppPage({ ...options, production: true, headers: { rsc: '1' } });
  assert.equal(flight.status, 500);
  assert.equal(flight.headers['content-type'], 'text/x-component; charset=utf-8');
  assert.match(flight.body.toString(), /:E\{"digest":"[a-f0-9]{16}"/);
  assert.ok(!flight.body.toString().includes('PRIVATE_DATABASE_PASSWORD'));
});

test('SSR Client Component failures retain their original Flight in a recovery document', async () => {
  const options = await fixture(`
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    export const ErrorBoundary=registerClientReference(()=>{},'boundary','default');
    const ErrorUI=registerClientReference(()=>{},'error-ui','default');
    const BrokenClient=registerClientReference(()=>{},'broken','default');
    export const page={default:()=>React.createElement(BrokenClient)};
    export const segments=[{path:'',error:{default:ErrorUI},layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `, {
    boundary: { ssrModule: '../../compat/app-error-boundary.cjs', browserModule: '/boundary.js' },
    'error-ui': { ssrModule: 'error-ui.mjs', browserModule: '/error-ui.js' },
    broken: { ssrModule: 'broken.mjs', browserModule: '/broken.js' },
  });
  await writeFile(path.join(options.distDir, 'error-ui.mjs'), `import React from 'react';export default ({error})=>React.createElement('p',null,error.message);`);
  await writeFile(path.join(options.distDir, 'broken.mjs'), `export default function Broken(){throw new Error('SSR client failure')}`);
  const html = await renderAppPage(options);
  assert.equal(html.status, 500);
  assert.match(html.body.toString(), /<html id="__rustyx_error__">/);
  assert.doesNotMatch(html.body.toString(), /<p>SSR client failure/);
});

test('RSC timeouts bypass error boundaries and preserve HTTP 504 across the thread transport', async () => {
  const options = await fixture(`
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    export const ErrorBoundary=registerClientReference(()=>{},'boundary','default');
    const ErrorUI=registerClientReference(()=>{},'error-ui','default');
    export const page={default:async()=>{await new Promise(()=>{})}};
    export const segments=[{path:'',error:{default:ErrorUI},layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `);
  let timeout;
  await assert.rejects(renderFlight({ ...options, clientModules: {
    boundary: { browserModule: '/boundary.js' }, 'error-ui': { browserModule: '/error-ui.js' },
  } }, { softTimeoutMs: 20, hardTimeoutMs: 2000 }), error => {
    timeout = error;
    return error.statusCode === 504 && /RSC render timed out/.test(error.message);
  });
  const response = errorResponse(timeout, true);
  assert.equal(response.status, 504);
  assert.equal(response.body.toString(), 'Gateway Timeout');
});

test('HTML rendering aborts unresolved client suspense with HTTP 504', async () => {
  const pending = new Promise(() => {});
  function Waiting() { return React.use(pending); }
  const tree = React.createElement('html', null, React.createElement('head'), React.createElement('body', null,
    React.createElement(React.Suspense, { fallback: 'Waiting' }, React.createElement(Waiting))));
  await assert.rejects(renderHtml(tree, { pathname: '/', search: '', params: {} }, { timeoutMs: 20 }), error =>
    error.statusCode === 504 && /HTML render timed out/.test(error.message));
});

test('a blocked RSC thread reaches its hard 504 deadline and is replaced for the next request', async () => {
  const options = await fixture(`
    import {writeFileSync} from 'node:fs';
    export const page={default:function Blocking(){writeFileSync(new URL('./started',import.meta.url),'started');for(;;){}}};
  `);
  await assert.rejects(renderFlight(options, { softTimeoutMs: 50, hardTimeoutMs: 1000 }), error =>
    error.statusCode === 504 && /RSC worker timed out/.test(error.message));
  assert.equal(await readFile(path.join(options.distDir, 'started'), 'utf8'), 'started');
  const healthy = await fixture(`import React from 'react';export const page={default:()=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,'worker restarted'))};`);
  assert.match((await renderAppPage(healthy)).body.toString(), /worker restarted/);
});


test('disconnecting from blocked RSC code keeps its recovery deadline armed', async () => {
  const blocked = await fixture(`import {writeFileSync} from 'node:fs';export const page={default:()=>{writeFileSync(new URL('./started',import.meta.url),'yes');for(;;){}}};`);
  const abort = new AbortController();
  const rendering = renderFlight(blocked, { signal: abort.signal, softTimeoutMs: 100, hardTimeoutMs: 1000 });
  const rejected = assert.rejects(rendering, /test disconnect/);
  for (let i = 0; ; i++) {
    try { await readFile(path.join(blocked.distDir, 'started')); break; }
    catch { assert.ok(i < 200, 'blocking render started'); await new Promise(r => setTimeout(r, 5)); }
  }
  abort.abort(new Error('test disconnect'));
  await rejected;
  await new Promise(r => setTimeout(r, 1100));
  const healthy = await fixture(`import React from 'react';export const page={default:()=>React.createElement('p',null,'recovered after cancel')};`);
  const flight = await renderFlight(healthy, { hardTimeoutMs: 1500 });
  assert.match(flight.body.toString(), /recovered after cancel/);
});
