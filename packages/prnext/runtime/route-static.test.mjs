import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectAppRouteHandler, prerenderAppRouteHandler, renderRouteHandlerIsr } from './route-static.mjs';
import { runApi } from './render.mjs';

const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));
const headersModule = JSON.stringify(new URL('../compat/headers.cjs', import.meta.url).href);
const cacheModule = JSON.stringify(new URL('../compat/cache.cjs', import.meta.url).href);
const serverModule = JSON.stringify(new URL('../compat/server.cjs', import.meta.url).href);
async function fixture(source, handlerConfig = {}, pattern = '/data') {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-route-static-'));
  roots.push(root);
  const modulePath = path.join(root, 'route.mjs');
  await writeFile(modulePath, source);
  return { modulePath, path: pattern, url: `http://app.test${pattern}`, production: true,
    route: { router: 'app', kind: 'api', pattern, handlerConfig,
      cacheConfig: { dynamic: 'auto', revalidate: false, dynamicParams: true, ...handlerConfig } } };
}

test('Route Handler generation requires explicit opt-in and excludes non-static method exports', async () => {
  const ordinary = await fixture(`export function GET(){throw new Error('must not run')}`);
  assert.equal((await inspectAppRouteHandler(ordinary)).staticEligible, false);
  assert.equal((await prerenderAppRouteHandler(ordinary)).dynamic, true);
  for (const [name, value] of [['revalidate', false], ['revalidate', 2], ['dynamic', 'force-static'], ['dynamic', 'error']]) {
    const options = await fixture(`export const ${name}=${JSON.stringify(value)};export function GET(){return new Response('static')}`, { [name]: value });
    assert.equal((await inspectAppRouteHandler(options)).staticEligible, true);
    assert.equal((await prerenderAppRouteHandler(options)).body.toString(), 'static');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const options = await fixture(`export const dynamic='force-static';export function GET(){throw new Error('must not run')}export function ${method}(){}`, { dynamic: 'force-static' });
    assert.equal((await inspectAppRouteHandler(options)).staticEligible, false);
    assert.equal((await prerenderAppRouteHandler(options)).dynamic, true);
  }
});

test('static Route Handlers retain binary bytes, statuses, cookies and route dependencies', async () => {
  const options = await fixture(`export const revalidate=7;let count=0;
    export function GET(request){const headers=new Headers({'content-type':'application/octet-stream','cache-control':'private, no-store','x-count':String(++count),'x-path':request.nextUrl.pathname});headers.append('set-cookie','one=1');headers.append('set-cookie','two=2');return new Response(new Uint8Array([0,255,128,1]),{status:201,headers})}`, { revalidate: 7 });
  const result = await prerenderAppRouteHandler({ ...options, path: '/data?private=secret', headers: { cookie: 'private=secret' } });
  assert.deepEqual(result.body, Buffer.from([0, 255, 128, 1]));
  assert.equal(result.status, 201);
  assert.equal(result.revalidate, 7);
  assert.deepEqual(result.headers['set-cookie'], ['one=1', 'two=2']);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(result.headers['x-count'], '1');
  assert.equal(result.headers['x-path'], '/data');
  assert.ok(result.paths.includes('page:/data'));
  assert.ok(result.paths.includes('layout:/'));
  const wire = await renderRouteHandlerIsr(options);
  assert.equal(wire.isr.kind, 'route');
  assert.equal(wire.isr.htmlLength, 4);
  assert.equal(wire.isr.dataLength, 0);
  assert.deepEqual(wire.body, [result.body]);
});

test('request and clone access dynamically bail even if application code catches the error', async () => {
  for (const expression of ['request.url', 'request.headers', 'request.cookies', 'request.body', 'request.text',
    'request.nextUrl.searchParams', 'request.nextUrl.origin', 'request.nextUrl.toString()',
    'request.clone().headers', 'request.clone().nextUrl.href', 'request.nextUrl.clone().search',
    'await headers()', 'await cookies()', 'unstable_noStore()']) {
    const options = await fixture(`import {headers,cookies} from ${headersModule};import {unstable_noStore} from ${cacheModule};
      export const revalidate=false;export async function GET(request){try{${expression}}catch{}return new Response('caught')}`, { revalidate: false });
    assert.equal((await prerenderAppRouteHandler(options)).dynamic, true, expression);
  }
  const options = await fixture(`export const dynamic='error';export function GET(request){try{request.headers}catch{}return new Response('caught')}`, { dynamic: 'error' });
  await assert.rejects(prerenderAppRouteHandler(options), error => error.code === 'PRNEXT_DYNAMIC_SERVER_USAGE');
});

test('force-static empties request data but retains params and a clean full URL', async () => {
  const options = await fixture(`import {headers,cookies} from ${headersModule};
    export const dynamic='force-static';export async function GET(request,{params}){return Response.json({headers:[...request.headers],cookies:request.cookies.getAll(),ambientHeaders:[...await headers()],ambientCookies:(await cookies()).getAll(),url:request.url,cloneUrl:request.clone().url,query:[...request.nextUrl.searchParams],params:await params})}`, { dynamic: 'force-static' }, '/item/[id]');
  const result = await prerenderAppRouteHandler({ ...options, path: '/item/one?secret=1', params: { id: 'one' }, headers: { cookie: 'secret=1' } });
  assert.deepEqual(JSON.parse(result.body), { headers: [], cookies: [], ambientHeaders: [], ambientCookies: [],
    url: 'http://localhost:3000/item/one', cloneUrl: 'http://localhost:3000/item/one', query: [], params: { id: 'one' } });
  const dynamic = await runApi({ ...options, url: 'https://private.example/item/one?secret=1', headers: { cookie: 'secret=1' }, params: { id: 'one' } });
  assert.equal(JSON.parse(dynamic.body).url, 'http://localhost:3000/item/one');
  assert.deepEqual(JSON.parse(dynamic.body).ambientCookies, []);
});

test('Route Handler HEAD regeneration honors explicit methods and retains the complete returned body', async () => {
  const options = await fixture(`export const revalidate=false;export function GET(request){return new Response(request.method,{status:201})}export function HEAD(request){return new Response(request.method,{status:202})}`, { revalidate: false });
  assert.equal((await inspectAppRouteHandler(options)).hasExplicitHead, true);
  const build = await prerenderAppRouteHandler({ ...options, method: 'HEAD' });
  assert.equal(build.status, 201);
  assert.equal(build.body.toString(), 'GET');
  const head = await renderRouteHandlerIsr({ ...options, method: 'HEAD' });
  assert.equal(head.status, 202);
  assert.equal(head.body[0].toString(), 'HEAD');
  const ordinary = await runApi({ ...options, method: 'HEAD' });
  assert.equal(ordinary.status, 202);
  assert.equal(ordinary.body.length, 0);
  const implicit = await fixture(`export const revalidate=false;export function GET(request){return new Response(request.method)}`, { revalidate: false });
  assert.equal((await renderRouteHandlerIsr({ ...implicit, method: 'HEAD' })).body[0].toString(), 'HEAD');
  const allow = await runApi({ ...options, method: 'OPTIONS' });
  assert.equal(allow.status, 204);
  assert.equal(allow.headers.allow, 'GET, HEAD, OPTIONS');
});

test('Route Handler nextUrl clones support URL setters without bypassing static data guards', async () => {
  const source = `import {NextResponse} from ${serverModule};
    export function GET(request){const url=request.nextUrl.clone();url.pathname='/target';url.search='?updated=yes';return NextResponse.redirect(url)}`;
  const ordinary = await fixture(source);
  const response = await runApi({ ...ordinary, url: 'https://private.example/data?before=secret' });
  assert.equal(response.status, 307);
  assert.equal(response.headers.location, 'https://private.example/target?updated=yes');
  const automatic = await fixture(`export const revalidate=false;${source}`, { revalidate: false });
  assert.equal((await prerenderAppRouteHandler(automatic)).dynamic, true);
  const forced = await fixture(`export const dynamic='force-static';${source}`, { dynamic: 'force-static' });
  const rendered = await prerenderAppRouteHandler(forced);
  assert.equal(rendered.status, 307);
  assert.equal(rendered.headers.location, 'http://localhost:3000/target');
});

test('build status eligibility differs from request-time ISR without losing 404 and redirects', async () => {
  for (const status of [204, 301, 404, 401, 500]) {
    const options = await fixture(`export const revalidate=false;export function GET(){return new Response(${status === 204 ? 'null' : "'response'"},{status:${status},headers:{location:'/target'}})}`, { revalidate: false });
    const build = await prerenderAppRouteHandler(options);
    assert.equal(Boolean(build.dynamic), status >= 400 && status !== 404);
    const runtime = await renderRouteHandlerIsr(options);
    assert.equal(runtime.status, status);
    assert.equal(runtime.isr.dynamic, undefined);
  }
});

test('Route Handler dependency capture includes cached functions and fetches and rejects uncached I/O', async t => {
  const server = createServer((_request, response) => response.end('fetch'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = await fixture(`import {unstable_cache} from ${cacheModule};export const revalidate=20;
    const value=unstable_cache(async()=> 'function',[],{tags:['function-tag'],revalidate:9});
    export async function GET(){return new Response(await value()+':'+await(await fetch(${JSON.stringify(origin)},{next:{revalidate:4,tags:['fetch-tag']}})).text())}`, { revalidate: 20 });
  const result = await prerenderAppRouteHandler(options);
  assert.equal(result.body.toString(), 'function:fetch');
  assert.equal(result.revalidate, 4);
  assert.deepEqual(result.tags.sort(), ['fetch-tag', 'function-tag']);
  const uncached = await fixture(`export const revalidate=false;export async function GET(){return await fetch(${JSON.stringify(origin)},{cache:'no-store'})}`, { revalidate: false });
  assert.equal((await prerenderAppRouteHandler(uncached)).dynamic, true);
});

test('Route Handler generation validates scoped params and dev checks each updated generator result', async () => {
  const options = await fixture(`export const revalidate=false;export const dynamicParams=false;let count=0;export function generateStaticParams(){return [{id:String(++count)}]}export function GET(){return new Response('allowed')}`, { revalidate: false, dynamicParams: false, generateStaticParams: true }, '/data/[id]');
  const listing = await inspectAppRouteHandler(options);
  assert.equal(listing.generated, true);
  assert.deepEqual(listing.params, [{ id: '1' }]);
  assert.equal((await runApi({ ...options, manifest: { dev: true }, url: 'http://app/data/2', params: { id: '2' } })).status, 200);
  assert.equal((await runApi({ ...options, manifest: { dev: true }, url: 'http://app/data/2', params: { id: '2' } })).status, 404);
  const hidden = await fixture(`export const revalidate=false;export function GET(){return new Response('hidden')}`);
  await assert.rejects(inspectAppRouteHandler(hidden), /Statically analyzable route config/);
});

test('Route Handler imports and parameter generators time out and do not retain a child worker', async () => {
  const generator = await fixture(`export const revalidate=false;export async function generateStaticParams(){await new Promise(()=>{})}export function GET(){return new Response('unused')}`, { revalidate: false, generateStaticParams: true });
  await assert.rejects(inspectAppRouteHandler({ ...generator, timeoutMs: 20 }), /static parameters timed out/);
  const pendingModule = await fixture(`await new Promise(()=>{});export const revalidate=false;export function GET(){return new Response('unused')}`, { revalidate: false });
  const runtime = new URL('./route-static.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';import {inspectAppRouteHandler,prerenderAppRouteHandler} from ${JSON.stringify(runtime)};
    const options=${JSON.stringify({ ...pendingModule, timeoutMs: 20 })};
    await assert.rejects(inspectAppRouteHandler(options),/static parameters timed out/);
    await assert.rejects(prerenderAppRouteHandler(options),/static Route Handler timed out/);
    console.log('imports bounded; process can exit');`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.match(stdout, /imports bounded; process can exit/);
});

test('static Route Handler body work remains guarded and oversized or stalled streams are canceled', async () => {
  const lazy = await fixture(`import {headers} from ${headersModule};export const revalidate=false;export function GET(){let calls=0;return new Response(new ReadableStream({async pull(controller){if(++calls===1){controller.enqueue(new TextEncoder().encode('first'));return}try{await headers()}catch{}controller.close()}}))}`, { revalidate: false });
  assert.equal((await prerenderAppRouteHandler(lazy)).dynamic, true);
  const oversized = await fixture(`export const revalidate=false;export function GET(){return new Response(new Uint8Array(16*1024*1024+1))}`, { revalidate: false });
  await assert.rejects(prerenderAppRouteHandler(oversized), /16 MiB/);
  const stalled = await fixture(`export const revalidate=false;export function GET(){return new Response(new ReadableStream({pull(){return new Promise(()=>{})},cancel(){globalThis.__prnextRouteCanceled=true}}))}`, { revalidate: false });
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(prerenderAppRouteHandler({ ...stalled, timeoutMs: 25 }), /timed out/); }
  finally { clearInterval(keepAlive); }
  assert.equal(globalThis.__prnextRouteCanceled, true);
  delete globalThis.__prnextRouteCanceled;
});

test('revalidation cannot mutate the shared cache during static generation, including force-static', async () => {
  for (const dynamic of ['auto', 'force-static', 'error']) {
    const options = await fixture(`import {revalidateTag} from ${cacheModule};export const dynamic=${JSON.stringify(dynamic)};export const revalidate=false;export function GET(){try{revalidateTag('changed')}catch{}return new Response('caught')}`, { dynamic, revalidate: false });
    if (dynamic === 'error') await assert.rejects(prerenderAppRouteHandler(options), /revalidateTag/);
    else assert.equal((await prerenderAppRouteHandler(options)).dynamic, true);
  }
});
