import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAppStatic, prerenderAppRoute, renderAppIsrPage } from './app-static.mjs';
import { closeAppRuntime, decodeFlight, renderHtml, renderAppPage } from './app-render.mjs';

const fixtures = [];
after(async () => { await closeAppRuntime(); await Promise.all(fixtures.map(root => rm(root, { recursive: true, force: true }))); });
const headersModule = JSON.stringify(new URL('../compat/headers.cjs', import.meta.url).href);
const cacheModule = JSON.stringify(new URL('../compat/cache.cjs', import.meta.url).href);
const layout = `{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}`;
async function fixture(source, cacheConfig = {}) {
  const root = await mkdtemp(fileURLToPath(new URL('./.app-static-', import.meta.url)));
  fixtures.push(root);
  const modulePath = path.join(root, 'page.mjs');
  await writeFile(modulePath, `import React from 'react';\n${source}`);
  return { modulePath, distDir: root, route: { pattern: '/static', cacheConfig }, manifest: { app: { clientModules: {} } }, path: '/static' };
}

test('static App HTML and Flight share one server render and canonical request context', async () => {
  const options = await fixture(`
    import {currentRequest} from ${headersModule};let calls=0;
    export const page={default:()=>{const request=currentRequest();return React.createElement('h1',null,++calls+':'+request.url)}};
    export const segments=[{layout:${layout}}];
  `, { revalidate: 15 });
  options.route.css = ['/resources/_rustyx/static.css'];
  const result = await prerenderAppRoute({ ...options, path: '/static?private=secret', headers: { cookie: 'secret' } });
  assert.equal(result.dynamic, undefined);
  assert.match(result.body, /<h1>1:http:\/\/rustyx.local\/static<\/h1>/);
  assert.doesNotMatch(result.body, /private=secret/);
  assert.equal(result.revalidate, 15);
  assert.ok(result.paths.includes('page:/static'));
  assert.ok(result.paths.includes('layout:/'));
  const model = await decodeFlight(result.flight, {}, options.distDir, { production: true });
  assert.match(await renderHtml(model.tree, model.router), /<h1>1:/);
  assert.equal(model.router.search, '');
  assert.deepEqual(model.css, options.route.css, 'cached Flight can restore layout styles after an error document');
  const wire = await renderAppIsrPage(options);
  assert.equal(wire.isr.htmlLength, wire.body[0].byteLength);
  assert.equal(wire.isr.dataLength, wire.body[1].byteLength);
  assert.match(wire.body[0].toString(), /<h1>2:/);
});

test('App rewrites separate visible hook URLs from destination page search parameters', async () => {
  const options = await fixture(`
    export const page={default:async({searchParams})=>React.createElement('p',null,JSON.stringify(await searchParams))};
    export const segments=[{layout:${layout}}];
  `);
  const result = await renderAppPage({ ...options,
    url: 'http://localhost/target?collision=destination&injected=yes', originalUrl: 'http://localhost/alias?collision=visible',
    headers: { RSC: '1' }, production: true });
  const model = await decodeFlight(result.body, {}, options.distDir, { production: true });
  assert.equal(model.router.pathname, '/alias');
  assert.equal(model.router.search, '?collision=visible');
  assert.equal(model.router.pageSearch, '?collision=destination&injected=yes');
  assert.match(await renderHtml(model.tree, model.router), /&quot;collision&quot;:&quot;destination&quot;/);
});

test('request APIs bail out auto static renders even when user code catches the error', async () => {
  for (const expression of ['await headers()', 'await cookies()', '(await searchParams).secret', '(await searchParams).toJSON',
    '(await searchParams).then', 'Object.hasOwn(await searchParams,"secret")', 'unstable_noStore()']) {
    const options = await fixture(`
      import {headers,cookies} from ${headersModule};import {unstable_noStore} from ${cacheModule};
      export const page={default:async({searchParams})=>{try{${expression}}catch{}return React.createElement('p',null,'private')}};
      export const segments=[{layout:${layout},error:{default:()=>React.createElement('p',null,'masked')}}];
    `);
    const result = await prerenderAppRoute(options);
    assert.equal(result.dynamic, true, expression);
    assert.match(result.reason, /headers|cookies|searchParams|unstable_noStore/);
    const wire = await renderAppIsrPage(options);
    assert.deepEqual(wire.body, []);
    assert.equal(wire.isr.dynamic, true);
  }
});

test('force-static empties request APIs while error mode and ordinary render failures reject', async () => {
  const options = await fixture(`
    import {headers,cookies} from ${headersModule};import {unstable_noStore} from ${cacheModule};
    export const page={default:async({searchParams})=>{unstable_noStore();return React.createElement('p',null,JSON.stringify({headers:[...(await headers())],cookies:(await cookies()).getAll(),query:await searchParams}))}};
    export const segments=[{layout:${layout}}];
  `, { dynamic: 'force-static' });
  const result = await prerenderAppRoute({ ...options, path: '/static?secret=1', headers: { cookie: 'secret=1' } });
  assert.match(result.body, /&quot;headers&quot;:\[\],&quot;cookies&quot;:\[\],&quot;query&quot;:\{\}/);
  const errorOptions = { ...options, route: { ...options.route, cacheConfig: { dynamic: 'error' } } };
  await assert.rejects(prerenderAppRoute(errorOptions), error => error.code === 'RUSTYX_DYNAMIC_SERVER_USAGE');
  const zero = await prerenderAppRoute({ ...options, route: { ...options.route, cacheConfig: { dynamic: 'force-static', revalidate: 0 } } });
  assert.equal(zero.revalidate, 0);
  assert.equal(zero.status, 200);
  const broken = await fixture(`export const page={default:()=>{throw new Error('application failure')}};export const segments=[{layout:${layout}}];`);
  await assert.rejects(prerenderAppRoute(broken), /application failure/);
});

test('static dependency metadata includes cached functions and fetches even without a native Data Cache', async t => {
  let calls = 0;
  const server = createServer((_request, response) => response.end(String(++calls)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = await fixture(`
    import {unstable_cache} from ${cacheModule};
    const read=unstable_cache(async()=> 'cached-function',['static'],{tags:['function-tag'],revalidate:9});
    export const page={default:async()=>React.createElement('p',null,await read()+':'+await(await fetch(${JSON.stringify(origin)},{next:{tags:['fetch-tag'],revalidate:4}})).text())};
    export const segments=[{layout:${layout}}];
  `, { revalidate: 20 });
  const result = await prerenderAppRoute(options);
  assert.equal(result.revalidate, 4);
  assert.deepEqual(result.tags.sort(), ['fetch-tag', 'function-tag']);
  assert.equal(calls, 1);
  const uncached = await fixture(`export const page={default:async()=>React.createElement('p',null,await(await fetch(${JSON.stringify(origin)},{cache:'no-store'})).text())};export const segments=[{layout:${layout}}];`);
  assert.equal((await prerenderAppRoute(uncached)).dynamic, true);
  assert.equal(calls, 1, 'explicit no-store bails before contacting origin');
  const automatic = await fixture(`export const page={default:async()=>React.createElement('p',null,await(await fetch(${JSON.stringify(origin)})).text())};export const segments=[{layout:${layout}}];`);
  assert.equal((await prerenderAppRoute(automatic)).status, 200);
  assert.equal(calls, 2);
  const strictNoStore = { dynamic: 'error', fetchCache: 'default-no-store' };
  await assert.rejects(prerenderAppRoute({ ...automatic, route: { ...automatic.route, cacheConfig: strictNoStore } }), /uncached fetch/);
  assert.equal(calls, 2, 'an explicit inherited no-store default must not be replaced by strict-mode caching');
  assert.equal((await prerenderAppRoute({ ...options, route: { ...options.route, cacheConfig: strictNoStore } })).status, 200,
    'an explicit cached fetch remains valid under a no-store default');
});

test('nested generateStaticParams runs in react-server context with parent expansion and scoped validation', async () => {
  const options = await fixture(`
    export const page={default:()=>null,generateStaticParams:({params})=>{if(React.useState)throw new Error('wrong React');return [{item:params.team+'-book'}]}};
    export const segments=[{path:'[team]',layout:{...${layout},generateStaticParams:()=>[{team:'red'},{team:'blue'}]}}];
  `);
  options.route.pattern = '/[team]/[item]';
  assert.deepEqual(await inspectAppStatic(options), { params: [{ team: 'red', item: 'red-book' }, { team: 'blue', item: 'blue-book' }], generated: true });
  const conflict = await fixture(`export const page={generateStaticParams:()=>[{team:'other'}]};export const segments=[{path:'[team]',layout:{generateStaticParams:()=>[{team:'red'}]}}];`);
  conflict.route.pattern = '/[team]';
  await assert.rejects(inspectAppStatic(conflict), /overwrite parent/);
  const wrongScope = await fixture(`export const page={};export const segments=[{path:'',layout:{generateStaticParams:()=>[{child:'secret'}]}}];`);
  wrongScope.route.pattern = '/[child]';
  await assert.rejects(inspectAppStatic(wrongScope), /cannot generate child/);
});

test('unused client page searchParams can be serialized without marking its route dynamic', async () => {
  const options = await fixture(`
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    export const page={default:registerClientReference(()=>{},'client-page','default')};
    export const segments=[{layout:${layout}}];
  `);
  await writeFile(path.join(options.distDir, 'client.mjs'), `import React from 'react';export default function Page(){return React.createElement('p',null,'Client page')}`);
  options.manifest.app.clientModules = { 'client-page': { ssrModule: 'client.mjs' } };
  const result = await prerenderAppRoute(options);
  assert.equal(result.status, 200);
  assert.match(result.body, /Client page/);
});

test('direct Client page query props follow the router while preserving static hydration and params', async () => {
  const options = await fixture(`
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    export const page={default:registerClientReference(()=>{},'query-page','default')};
    export const ClientPageRoot=registerClientReference(()=>{},'query-root','ClientPageRoot');
    export const segments=[{layout:${layout}}];
  `);
  await writeFile(path.join(options.distDir, 'query-page.mjs'), `import React from 'react';export default function Page({params,searchParams}){return React.createElement('p',null,React.use(params).id+':'+JSON.stringify(React.use(searchParams)))}`);
  await writeFile(path.join(options.distDir, 'query-root.mjs'), `export {ClientPageRoot} from ${JSON.stringify(new URL('../compat/app-client-page.cjs', import.meta.url).href)};`);
  options.manifest.app.clientModules = { 'query-page': { ssrModule: 'query-page.mjs' }, 'query-root': { ssrModule: 'query-root.mjs' } };
  options.params = { id: 'one' };
  const result = await prerenderAppRoute(options);
  assert.match(result.body, /<p>one:\{\}<\/p>/);
  const model = await decodeFlight(result.flight, options.manifest.app.clientModules, options.distDir, { production: true });
  const changed = await renderHtml(model.tree, { ...model.router, search: '?from=browser&tag=a&tag=b&__proto__=own&_rsc=transport' });
  assert.match(changed, /one:\{&quot;from&quot;:&quot;browser&quot;,&quot;tag&quot;:\[&quot;a&quot;,&quot;b&quot;\],&quot;__proto__&quot;:&quot;own&quot;\}/);
  assert.doesNotMatch(changed, /transport/);
  assert.match(await renderHtml(model.tree, { ...model.router, forceStatic: true, search: '?from=ignored' }), /<p>one:\{\}<\/p>/);
});

test('Server pages retain ownership of custom searchParams passed to nested Client Components', async () => {
  const options = await fixture(`
    import {registerClientReference} from 'react-server-dom-webpack/server.node';
    const Nested=registerClientReference(()=>{},'nested-query','default');
    export const page={default:()=>React.createElement(Nested,{searchParams:Promise.resolve({from:'server-owned'})})};
    export const ClientPageRoot=registerClientReference(()=>{},'query-root','ClientPageRoot');
    export const segments=[{layout:${layout}}];
  `);
  await writeFile(path.join(options.distDir, 'nested-query.mjs'), `import React from 'react';export default function Nested({searchParams}){return React.createElement('p',null,React.use(searchParams).from)}`);
  await writeFile(path.join(options.distDir, 'query-root.mjs'), `export {ClientPageRoot} from ${JSON.stringify(new URL('../compat/app-client-page.cjs', import.meta.url).href)};`);
  options.manifest.app.clientModules = { 'nested-query': { ssrModule: 'nested-query.mjs' }, 'query-root': { ssrModule: 'query-root.mjs' } };
  const result = await prerenderAppRoute(options);
  const model = await decodeFlight(result.flight, options.manifest.app.clientModules, options.distDir, { production: true });
  assert.match(await renderHtml(model.tree, { ...model.router, search: '?from=browser' }), /<p>server-owned<\/p>/);
});

test('hidden route config is rejected and development validates fresh generated paths', async () => {
  const hidden = await fixture(`export const page={default:()=>null,dynamic:'force-static'};export const pageConfig={};export const segments=[];`);
  await assert.rejects(inspectAppStatic(hidden), /Statically analyzable route config/);
  const options = await fixture(`let paths=0;export const page={default:()=>React.createElement('p',null,'allowed'),generateStaticParams:()=>[{id:String(++paths)}]};export const segments=[{layout:${layout}}];`, { dynamicParams: false });
  options.route.pattern = '/item/[id]';
  options.manifest.dev = true;
  assert.equal((await renderAppPage({ ...options, url: 'http://app/item/1', params: { id: '1' } })).status, 200);
  assert.equal((await renderAppPage({ ...options, url: 'http://app/item/1', params: { id: '1' } })).status, 404);
});
