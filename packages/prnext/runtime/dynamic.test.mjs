import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderPage } from './render.mjs';
import { renderHtml, closeAppRuntime } from './app-render.mjs';
import { renderProgressiveAppHtml } from './app-stream-html.mjs';
import { prerenderAppRoute } from './app-static.mjs';
import appDynamic from '../compat/app-dynamic.cjs';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const reactPath = JSON.stringify(require.resolve('react'));
const dynamicPath = JSON.stringify(require.resolve('../compat/dynamic.cjs'));
const moduleUrl = file => JSON.stringify(new URL(file, import.meta.url).href);
after(() => closeAppRuntime());

async function fixture(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-dynamic-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'page.cjs');
  await writeFile(modulePath, `const React=require(${reactPath});const dynamic=require(${dynamicPath});\n${source}`);
  return modulePath;
}
function payload(html) {
  const context = vm.createContext({ window: {} });
  vm.runInContext(html.match(/<script>(window\.__PRNEXT_DATA__=[\s\S]*?)<\/script>/)[1], context);
  return JSON.parse(JSON.stringify(context.window.__PRNEXT_DATA__));
}

test('Pages preloads SSR declarations and nested imports while serializing only rendered dynamic IDs', async t => {
  const modulePath = await fixture(t, `
    const calls=exports.calls=[];
    const Child=dynamic(()=>{calls.push('child');return Promise.resolve({Named:({name})=>React.createElement('strong',null,name)})
      .then(module=>module.Named)}, {loadableGenerated:{modules:['child']}});
    const Unused=dynamic(async()=>{calls.push('unused');return ()=>React.createElement('i',null,'unused')}, {loadableGenerated:{modules:['unused']}});
    const Outer=dynamic(async()=>{calls.push('outer');
      const Inner=dynamic(async()=>{calls.push('inner');return ()=>React.createElement('small',null,'nested')}, {loadableGenerated:{modules:['inner']}});
      return ()=>React.createElement(Inner);
    }, {loadableGenerated:{modules:['outer']}});
    exports.default=()=>React.createElement(React.Fragment,null,React.createElement(Child,{name:'named child'}),React.createElement(Outer));
  `);
  const page = require(modulePath);
  assert.deepEqual(page.calls, []);
  const response = await renderPage({ modulePath });
  assert.match(response.body.toString(), /<strong>named child<\/strong>/);
  assert.match(response.body.toString(), /<small>nested<\/small>/);
  assert.deepEqual(new Set(page.calls), new Set(['child', 'unused', 'outer', 'inner']));
  assert.deepEqual(payload(response.body.toString()).dynamicIds, ['child', 'outer', 'inner']);
});

test('Pages accepts Promise and options loaders and renders ssr:false fallback without loading or recording it', async t => {
  const modulePath = await fixture(t, `
    const Promised=dynamic(Promise.resolve({default:()=>React.createElement('b',null,'promise')}), {loadableGenerated:{modules:['promise']}});
    const Options=dynamic({loader:async()=>({default:()=>React.createElement('i',null,'options')}),loadableGenerated:{modules:['options']}});
    const Browser=dynamic(()=>{throw new Error('server must not load this')}, {ssr:false,loadableGenerated:{modules:['browser']},
      loading:props=>React.createElement('span',null,JSON.stringify(props))});
    exports.default=()=>React.createElement(React.Fragment,null,React.createElement(Promised),React.createElement(Options),React.createElement(Browser));
  `);
  const response = await renderPage({ modulePath });
  const html = response.body.toString();
  assert.match(html, /<b>promise<\/b><i>options<\/i>/);
  assert.match(html, /&quot;isLoading&quot;:true/);
  assert.match(html, /&quot;pastDelay&quot;:false/);
  assert.match(html, /&quot;timedOut&quot;:false/);
  assert.deepEqual(payload(html).dynamicIds, ['promise', 'options']);
});

test('Pages dynamic ID collection stays isolated between simultaneous renders', async t => {
  const modulePath = await fixture(t, `
    const One=dynamic(async()=>()=>React.createElement('p',null,'one'), {loadableGenerated:{modules:['one']}});
    const Two=dynamic(async()=>()=>React.createElement('p',null,'two'), {loadableGenerated:{modules:['two']}});
    exports.getServerSideProps=({query})=>({props:{two:query.two==='true'}});
    exports.default=({two})=>React.createElement(two?Two:One);
  `);
  const [one, two] = await Promise.all([renderPage({ modulePath }), renderPage({ modulePath, url: 'http://app.test/?two=true' })]);
  assert.deepEqual(payload(one.body.toString()).dynamicIds, ['one']);
  assert.deepEqual(payload(two.body.toString()).dynamicIds, ['two']);
});

test('Pages SSR loader rejection fails preloading before rendering a loading component', async t => {
  const modulePath = await fixture(t, `
    const Broken=dynamic(async()=>{throw new Error('dynamic SSR import failed')},{loading:()=>React.createElement('p',null,'loading')});
    exports.default=()=>React.createElement(Broken);
  `);
  await assert.rejects(renderPage({ modulePath }), /dynamic SSR import failed/);
});

test('Pages browser readiness loads only rendered IDs, including nested registrations', async () => {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import React from 'react';
    import {renderToString} from 'react-dom/server';
    globalThis.window={};
    const {default:dynamic,preloadReady}=await import(${moduleUrl('../compat/dynamic.cjs')});
    const calls=[];
    const Outer=dynamic(async()=>{calls.push('outer');
      const Inner=dynamic(async()=>{calls.push('inner');return ()=>React.createElement('p',null,'ready')},{loadableGenerated:{modules:['inner']}});
      return ()=>React.createElement(Inner);
    },{loadableGenerated:{modules:['outer']}});
    dynamic(async()=>{calls.push('unused');return ()=>null},{loadableGenerated:{modules:['unused']}});
    dynamic(async()=>{calls.push('noSSR');return ()=>null},{ssr:false,loadableGenerated:{modules:['noSSR']}});
    assert.deepEqual(calls,[]);
    await preloadReady(['outer','inner','noSSR']);
    assert.deepEqual(calls,['outer','inner']);
    assert.equal(renderToString(React.createElement(Outer)),'<p>ready</p>');
    console.log('selective preload passed');
  `]);
  assert.match(stdout, /selective preload passed/);
});

test('Pages loading delay, timeout and retry expose state without canceling imports', async () => {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    import React from 'react';
    import {renderToString} from 'react-dom/server';
    globalThis.window={};
    const {default:dynamic}=await import(${moduleUrl('../compat/dynamic.cjs')});
    mock.timers.enable({apis:['setTimeout']});
    let resolve, reject, current, attempts=0;
    const Component=dynamic(()=>{attempts++;return new Promise((done,failed)=>{resolve=done;reject=failed})},
      {delay:80,timeout:30,loading:props=>{current=props;return React.createElement('p',null,'loading')}});
    const render=()=>renderToString(React.createElement(Component));
    render(); await Promise.resolve();
    assert.equal(current.pastDelay,false); assert.equal(current.timedOut,false);
    mock.timers.tick(30); render();
    assert.equal(current.pastDelay,false); assert.equal(current.timedOut,true); assert.equal(current.isLoading,true);
    mock.timers.tick(50); render(); assert.equal(current.pastDelay,true);
    reject(new Error('first import failed')); await new Promise(setImmediate); render();
    assert.equal(current.error.message,'first import failed'); assert.equal(current.isLoading,false);
    const retry=current.retry(); await Promise.resolve();
    assert.equal(attempts,2);
    resolve({default:()=>React.createElement('b',null,'recovered')}); await retry;
    assert.equal(render(),'<b>recovered</b>');
    mock.timers.reset(); console.log('loading state passed');
  `]);
  assert.match(stdout, /loading state passed/);
});

const document = component => React.createElement('html', null, React.createElement('head'), React.createElement('body', null, component));

test('App lazily renders named exports and supplies Suspense loading props', async () => {
  let calls = 0;
  let loading;
  // Named exports are selected by the loader's promise, as with import().then().
  const Named = appDynamic(() => Promise.resolve({ Named: ({ value }) => React.createElement('p', null, value) }).then(module => { calls++; return module.Named; }),
    { loading: props => { loading = props; return React.createElement('span', null, 'loading'); } });
  assert.equal(calls, 0);
  const html = await renderHtml(document(React.createElement(Named, { value: 'named App component' })), {});
  assert.match(html, /named App component/);
  assert.equal(calls, 1);
  assert.deepEqual(loading, { isLoading: true, pastDelay: true, error: null });
  const ignored = appDynamic({ loader: () => { throw new Error('App options first argument is ignored'); } });
  assert.match(await renderHtml(document(React.createElement(ignored)), {}), /<body><\/body>/);
});

test('App ssr:false emits a recoverable client boundary without calling its loader in buffered or progressive HTML', async () => {
  let calls = 0;
  const Component = appDynamic(() => { calls++; throw new Error('browser-only module'); },
    { ssr: false, loading: () => React.createElement('p', null, 'client loading') });
  const tree = document(React.createElement(Component));
  const html = await renderHtml(tree, {});
  assert.match(html, /client loading/);
  assert.match(html, /BAILOUT_TO_CLIENT_SIDE_RENDERING/);
  const response = await renderProgressiveAppHtml({
    result: { status: 200, body: new ReadableStream({ start(controller) { controller.close(); } }) },
    request: { production: true }, route: {}, responseHeaders: {},
    async decodeFlight(body) { await new Response(body).arrayBuffer(); return { tree, router: {} }; },
  });
  let progressive = '';
  for await (const chunk of response.body) progressive += chunk;
  assert.match(progressive, /client loading/);
  assert.match(progressive, /BAILOUT_TO_CLIENT_SIDE_RENDERING/);
  assert.equal(calls, 0);
});

test('App SSR keeps Suspense fallbacks for rejected imports and ordinary client render errors', async () => {
  const previous = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (const variant of ['loading', 'outer', 'ordinary']) {
      const failure = new Error(`SSR ${variant} failure`);
      const fallback = React.createElement('p', null, `${variant} fallback`);
      const Component = variant === 'ordinary' ? () => { throw failure; }
        : appDynamic(() => Promise.reject(failure), variant === 'loading' ? { loading: () => fallback } : undefined);
      const child = variant === 'loading' ? React.createElement(Component)
        : React.createElement(React.Suspense, { fallback }, React.createElement(Component));
      const tree = document(React.createElement(React.Fragment, null, child, React.createElement('p', null, 'tail')));
      const html = await renderHtml(tree, {});
      assert.match(html, new RegExp(`${variant} fallback`));
      assert.match(html, /<p>tail<\/p>/);
      assert.match(html, /(?:data-dgst="|\$RX\("[^"]+",")[a-f0-9]{16}"/);
      const response = await renderProgressiveAppHtml({
        result: { status: 200, body: new ReadableStream({ start(controller) { controller.close(); } }) },
        request: { production: true }, route: {}, responseHeaders: {},
        async decodeFlight(body) { await new Response(body).arrayBuffer(); return { tree, router: {} }; },
      });
      assert.equal(response.status, 200);
      let progressive = '';
      for await (const chunk of response.body) progressive += chunk;
      assert.match(progressive, new RegExp(`${variant} fallback`));
      assert.match(progressive, /<p>tail<\/p>/);
      await assert.rejects(renderHtml(tree, {}, { staticGeneration: true }), error => error === failure);
    }
    assert.equal(logs.length, 6);
  } finally { console.error = previous; }
});

test('App SSR rejects an import failure without a Suspense boundary and preserves navigation signals', async () => {
  const previous = console.error;
  console.error = () => {};
  try {
    const failure = new Error('unhandled dynamic import failure');
    const Bare = appDynamic(() => Promise.reject(failure));
    await assert.rejects(renderHtml(document(React.createElement(Bare)), {}), error => error === failure);
    for (const digest of ['NEXT_REDIRECT;replace;/target;307;', 'NEXT_HTTP_ERROR_FALLBACK;404']) {
      const control = Object.assign(new Error('navigation'), { digest });
      const Component = () => { throw control; };
      const tree = document(React.createElement(React.Suspense, { fallback: 'fallback' }, React.createElement(Component)));
      await assert.rejects(renderHtml(tree, {}), error => error === control);
    }
  } finally { console.error = previous; }
});

test('static App generation rejects recoverable HTML import failures instead of caching the fallback', async t => {
  const root = await mkdtemp(path.join(fileURLToPath(new URL('.', import.meta.url)), '.dynamic-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'entry.mjs');
  await writeFile(modulePath, `
    import React from 'react';
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    const Client=registerClientReference(()=>{},'dynamic-static-client','default');
    export const page={default:()=>React.createElement(Client)};
    export const segments=[{path:'',layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];
  `);
  await writeFile(path.join(root, 'client.mjs'), `
    import React from 'react';
    import dynamic from ${moduleUrl('../compat/app-dynamic.cjs')};
    const Broken=dynamic(()=>Promise.reject(new Error('static dynamic import failed')),{loading:()=>React.createElement('p',null,'do not cache this fallback')});
    export default ()=>React.createElement(Broken);
  `);
  await assert.rejects(prerenderAppRoute({ modulePath, distDir: root, route: { pattern: '/' }, manifest: {
    app: { clientModules: { 'dynamic-static-client': { ssrModule: 'client.mjs', browserModule: '/client.js' } } },
  } }), /static dynamic import failed/);
});

test('App dynamic works with react-server conditions and rejects ssr:false there', async () => {
  const { stdout } = await run(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import React from 'react';
    import {renderToReadableStream} from 'react-server-dom-webpack/server.node';
    import dynamic from ${moduleUrl('../compat/app-dynamic.cjs')};
    let calls=0;
    const Component=dynamic(async()=>{calls++;return {default:()=>React.createElement('p',null,'server lazy')}});
    assert.equal(calls,0);
    const stream=renderToReadableStream(React.createElement(Component),{});
    const text=await new Response(stream).text();
    assert.match(text,/server lazy/); assert.equal(calls,1);
    assert.throws(()=>dynamic(()=>{throw new Error('must not load')},{ssr:false}),/Server Components/);
    console.log('react-server dynamic passed');
  `]);
  assert.match(stdout, /react-server dynamic passed/);
});
