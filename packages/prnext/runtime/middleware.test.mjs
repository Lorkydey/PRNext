import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { runMiddleware, drainMiddlewareWork, middlewareBackgroundState } from './middleware.mjs';
import { runApi } from './render.mjs';
import { NextResponse } from '../compat/server.cjs';
import { runRequestContext, headers, cookies } from '../compat/headers.cjs';

const roots = [];
after(async () => { await drainMiddlewareWork(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const serverModule = JSON.stringify(new URL('../compat/server.cjs', import.meta.url).href);
const headersModule = JSON.stringify(new URL('../compat/headers.cjs', import.meta.url).href);
async function fixture(source, exportName = 'middleware') {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-middleware-'));
  roots.push(root);
  const modulePath = path.join(root, 'middleware.mjs');
  await writeFile(modulePath, `import {NextResponse} from ${serverModule};\n${source}`);
  return { modulePath, url: 'http://app.test/private?user=one', production: true,
    manifest: { middleware: { module: 'middleware.mjs', exportName, convention: exportName === 'proxy' ? 'proxy' : 'middleware' } } };
}
async function bodyText(response) {
  if (Buffer.isBuffer(response.body)) return response.body.toString();
  const chunks = [];
  for await (const chunk of response.body) chunks.push(chunk);
  await response.finalizeCache?.();
  return Buffer.concat(chunks).toString();
}

test('NextResponse middleware controls and request overrides survive response clones', async () => {
  const request = new Headers({ 'x-user': 'private', cookie: 'session=one' });
  const response = NextResponse.next({ request: { headers: request }, headers: { 'x-visible': 'public' } });
  const clone = response.clone();
  request.set('x-user', 'changed');
  assert.equal(clone.headers.get('x-middleware-next'), '1');
  assert.equal(clone.headers.get('x-middleware-override-headers'), 'cookie,x-user');
  assert.equal(clone.headers.get('x-middleware-request-x-user'), 'private');
  assert.equal(clone.headers.get('x-visible'), 'public');
  const rewrite = NextResponse.rewrite(new URL('https://origin.test/destination?value=one'), { request: { headers: new Headers() } });
  assert.equal(rewrite.clone().headers.get('x-middleware-rewrite'), 'https://origin.test/destination?value=one');
  assert.equal(rewrite.headers.get('x-middleware-override-headers'), '');
  assert.throws(() => NextResponse.next({ request: { headers: {} } }), /instance of Headers/);
  assert.throws(() => NextResponse.rewrite('/relative'), /Invalid URL/);
});

test('middleware cookie markers preserve repeated cookies and merge only into App rendering', async () => {
  const response = NextResponse.next();
  response.cookies.set('fresh', 'hello,world', { expires: new Date('2037-10-21T07:28:00Z') });
  response.cookies.set('session', 'replacement');
  response.cookies.delete('gone');
  const marker = response.clone().headers.get('x-middleware-set-cookie');
  assert.equal(response.headers.getSetCookie().length, 3);
  for (const phase of ['render', 'action', 'route', 'middleware', 'pages']) {
    await runRequestContext({ phase, headers: { cookie: 'session=original', 'x-middleware-set-cookie': marker } }, async () => {
      const store = await cookies();
      assert.equal(store.get('session').value, ['render', 'action'].includes(phase) ? 'replacement' : 'original');
      assert.equal(store.get('fresh')?.value, ['render', 'action'].includes(phase) ? 'hello,world' : undefined);
      assert.equal((await headers()).get('cookie'), 'session=original');
    });
  }
  await runRequestContext({ phase: 'render', cacheConfig: { dynamic: 'force-static' }, headers: { 'x-middleware-set-cookie': marker } }, async () => assert.deepEqual((await cookies()).getAll(), []));
});

test('middleware normalizes transport details while preserving the URL, request body and visible headers', async () => {
  const options = await fixture(`export async function proxy(request){return Response.json({url:request.url,path:request.nextUrl.pathname,query:[...request.nextUrl.searchParams],headers:[...request.headers],body:await request.text(),cookie:request.cookies.get('session')?.value})}`, 'proxy');
  const response = await runMiddleware({ ...options, url: 'http://app.test/page?user=one&_rsc=internal&tag=a&tag=b', originalUrl: 'http://app.test/_prnext/data/build/page.json',
    method: 'POST', body: Buffer.from('original upload').toString('base64'), headers: { rsc: '1', 'next-router-state-tree': 'private', 'next-router-prefetch': '1', 'next-hmr-refresh': 'yes', 'next-router-segment-prefetch': 'tree', 'next-url': '/visible', cookie: 'session=one', 'x-middleware-next': '1', 'x-middleware-rewrite': 'http://spoofed', 'x-middleware-set-cookie': 'bad=1' } });
  const value = JSON.parse(await bodyText(response));
  assert.equal(value.url, 'http://app.test/page?user=one&tag=a&tag=b');
  assert.deepEqual(value.query, [['user', 'one'], ['tag', 'a'], ['tag', 'b']]);
  assert.equal(value.body, 'original upload');
  assert.equal(value.cookie, 'one');
  assert.deepEqual(value.headers, [['cookie', 'session=one'], ['next-url', '/visible']]);
});

test('middleware accepts default exports and no response, while invalid responses and API controls fail clearly', async () => {
  const options = await fixture(`export default function(){}`, 'default');
  assert.equal((await runMiddleware(options)).headers['x-middleware-next'], '1');
  const invalid = await fixture(`export function middleware(){return 'invalid'}`);
  await assert.rejects(runMiddleware(invalid), /must return a Response/);
  const route = await fixture(`export function GET(){return NextResponse.next()}`);
  await assert.rejects(runApi({ ...route, method: 'GET' }), /only supported in middleware/);
  const cookieRoute = await fixture(`export function GET(){const response=NextResponse.json({ok:true});response.cookies.set('session','one');return response}`);
  const result = await runApi({ ...cookieRoute, method: 'GET' });
  assert.deepEqual(result.headers['set-cookie'], ['session=one; Path=/']);
  assert.equal(result.headers['x-middleware-set-cookie'], undefined);
});

test('waitUntil does not delay responses and retains isolated request contexts with frozen response cookies', async () => {
  globalThis.__prnextMiddlewareEvents = [];
  globalThis.__prnextMiddlewareRelease = [];
  const options = await fixture(`import {headers,cookies} from ${headersModule};export function middleware(request,event){event.waitUntil(new Promise(resolve=>globalThis.__prnextMiddlewareRelease.push(resolve)).then(async()=>{let frozen=false;try{(await cookies()).set('late','bad')}catch{frozen=true}globalThis.__prnextMiddlewareEvents.push([(await headers()).get('x-id'),frozen])}));return NextResponse.next()}`);
  try {
    await runMiddleware({ ...options, headers: { 'x-id': 'one' } });
    await runMiddleware({ ...options, headers: { 'x-id': 'two' } });
    assert.deepEqual(middlewareBackgroundState(), { scopes: 2, promises: 2 });
    assert.deepEqual(globalThis.__prnextMiddlewareEvents, []);
    for (const release of globalThis.__prnextMiddlewareRelease.reverse()) release();
    await drainMiddlewareWork();
    assert.deepEqual(globalThis.__prnextMiddlewareEvents, [['two', true], ['one', true]]);
    assert.deepEqual(middlewareBackgroundState(), { scopes: 0, promises: 0 });
  } finally { delete globalThis.__prnextMiddlewareEvents; delete globalThis.__prnextMiddlewareRelease; }
});

test('waitUntil deadlines release framework tracking and abort the completed invocation signal', async () => {
  globalThis.__prnextMiddlewareSignal = undefined;
  const errors = [];
  const options = await fixture(`export function middleware(request,event){globalThis.__prnextMiddlewareSignal=request.signal;event.waitUntil(new Promise(()=>{}));return NextResponse.next()}`);
  try {
    await runMiddleware({ ...options, waitUntilTimeoutMs: 20, onBackgroundError: error => errors.push(error) });
    assert.equal(globalThis.__prnextMiddlewareSignal.aborted, false);
    await drainMiddlewareWork();
    assert.equal(globalThis.__prnextMiddlewareSignal.aborted, true);
    assert.deepEqual(middlewareBackgroundState(), { scopes: 0, promises: 0 });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /waitUntil.*timed out/);
  } finally { delete globalThis.__prnextMiddlewareSignal; }
});

test('waitUntil bounds total promises and observes rejected registrations', async () => {
  globalThis.__prnextMiddlewareRelease = [];
  globalThis.__prnextMiddlewareCapacity = '';
  const options = await fixture(`export function middleware(request,event){for(let i=0;i<128;i++)event.waitUntil(new Promise(resolve=>globalThis.__prnextMiddlewareRelease.push(resolve)));try{event.waitUntil(Promise.reject(new Error('refused rejection')))}catch(error){globalThis.__prnextMiddlewareCapacity=error.message}return NextResponse.next()}`);
  try {
    await runMiddleware(options);
    assert.equal(middlewareBackgroundState().promises, 128);
    assert.match(globalThis.__prnextMiddlewareCapacity, /capacity exceeded/);
    globalThis.__prnextMiddlewareRelease.forEach(resolve => resolve());
    await drainMiddlewareWork();
    assert.deepEqual(middlewareBackgroundState(), { scopes: 0, promises: 0 });
  } finally { delete globalThis.__prnextMiddlewareRelease; delete globalThis.__prnextMiddlewareCapacity; }
});

test('waitUntil bounds concurrent invocation scopes independently of pending promise count', async () => {
  globalThis.__prnextMiddlewareRelease = [];
  const options = await fixture(`export function middleware(request,event){event.waitUntil(new Promise(resolve=>globalThis.__prnextMiddlewareRelease.push(resolve)));return NextResponse.next()}`);
  try {
    for (let i = 0; i < 32; i++) await runMiddleware(options);
    await assert.rejects(runMiddleware(options), /capacity exceeded/);
    assert.deepEqual(middlewareBackgroundState(), { scopes: 32, promises: 32 });
    globalThis.__prnextMiddlewareRelease.forEach(resolve => resolve());
    await drainMiddlewareWork();
  } finally { delete globalThis.__prnextMiddlewareRelease; }
});

test('middleware streams final bodies beyond static limits and cancels control bodies without awaiting user cleanup', async () => {
  const large = await fixture(`export function middleware(){let count=0;return new Response(new ReadableStream({pull(controller){if(count++<272)controller.enqueue(new Uint8Array(65536));else controller.close()}}),{headers:{'content-type':'application/octet-stream'}})}`);
  const response = await runMiddleware(large);
  let size = 0;
  for await (const chunk of response.body) { assert.ok(chunk.length <= 65536); size += chunk.length; }
  assert.equal(size, 17 * 1024 * 1024);
  globalThis.__prnextMiddlewareCanceled = false;
  const control = await fixture(`export function middleware(){return new Response(new ReadableStream({cancel(){globalThis.__prnextMiddlewareCanceled=true;return new Promise(()=>{})}}),{headers:{'x-middleware-next':'1'}})}`);
  try {
    const next = await runMiddleware(control);
    assert.equal(next.body.length, 0);
    assert.equal(globalThis.__prnextMiddlewareCanceled, true);
  } finally { delete globalThis.__prnextMiddlewareCanceled; }
});

test('middleware body handling follows rewrite, Location, then continuation precedence', async () => {
  const final = await fixture(`export function middleware(){return new Response('created',{status:201,headers:{location:'/target','x-middleware-next':'1'}})}`);
  const response = await runMiddleware(final);
  assert.equal(response.status, 201);
  assert.equal(await bodyText(response), 'created');
  const continuation = await fixture(`export function middleware(){return new Response('discarded',{headers:{'x-middleware-next':'custom'}})}`);
  assert.equal((await runMiddleware(continuation)).body.length, 0);
  const rewrite = await fixture(`export function middleware(){return new Response('discarded',{headers:{location:'/redirect','x-middleware-rewrite':'http://app.test/target'}})}`);
  assert.equal((await runMiddleware(rewrite)).body.length, 0);
});

test('middleware bounds handler execution and cancels rejected header responses', async () => {
  const stalled = await fixture(`export async function middleware(){await new Promise(()=>{})}`);
  await assert.rejects(runMiddleware({ ...stalled, timeoutMs: 20 }), /response headers timed out/);
  globalThis.__prnextMiddlewareCanceled = false;
  const oversized = await fixture(`export function middleware(){return new Response(new ReadableStream({cancel(){globalThis.__prnextMiddlewareCanceled=true}}),{headers:{'x-large':'x'.repeat(64*1024)}})}`);
  try {
    await assert.rejects(runMiddleware(oversized), /metadata limit/);
    assert.equal(globalThis.__prnextMiddlewareCanceled, true);
  } finally { delete globalThis.__prnextMiddlewareCanceled; }
});

test('middleware worker handles the next invocation while previous waitUntil work is pending', async t => {
  const options = await fixture(`let release;export function middleware(request,event){if(request.nextUrl.pathname==='/one')event.waitUntil(new Promise(resolve=>{release=resolve}));else release();return NextResponse.next()}`);
  const root = path.dirname(options.modulePath);
  await mkdir(path.join(root, 'runtime'));
  await writeFile(path.join(root, 'runtime/http.mjs'), `export * from ${JSON.stringify(new URL('./http.mjs', import.meta.url).href)}`);
  await writeFile(path.join(root, 'runtime/middleware.mjs'), `export * from ${JSON.stringify(new URL('./middleware.mjs', import.meta.url).href)}`);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...options.manifest, routes: [] }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), root, '.'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { child.kill('SIGKILL'); });
  const lines = readline.createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  for (const [id, pathname] of [[1, '/one'], [2, '/two']]) {
    child.stdin.write(JSON.stringify({ id, routeId: '__prnext_middleware', renderMode: 'middleware', url: `http://app.test${pathname}`, method: 'GET', headers: {} }) + '\n');
    const line = await Promise.race([iterator.next(), new Promise((_, reject) => { const timer=setTimeout(()=>reject(new Error(`worker blocked: ${stderr}`)),2000);timer.unref(); })]);
    assert.equal(line.done, false);
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    assert.equal(response.headers['x-middleware-next'], '1');
  }
  child.stdin.end();
  await new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
});


test('skipProxyUrlNormalize exposes the data alias, Flight headers and _rsc without changing the mount', async () => {
  const options = await fixture(`export function middleware(request) { return Response.json({url:request.url,pathname:request.nextUrl.pathname,basePath:request.nextUrl.basePath,rsc:request.headers.get('rsc'),tree:request.headers.get('next-router-state-tree')}) }`);
  options.url = 'http://app.test/docs/post?query=one&_rsc=token';
  options.originalUrl = 'http://app.test/docs/_next/data/build/post.json?query=one&_rsc=token';
  options.headers = { rsc: '1', 'next-router-state-tree': 'tree' };
  options.manifest.config = { basePath: '/docs', skipProxyUrlNormalize: true };
  const result = JSON.parse(await bodyText(await runMiddleware(options)));
  assert.equal(result.url, options.originalUrl);
  assert.equal(result.pathname, '/_next/data/build/post.json');
  assert.equal(result.basePath, '/docs');
  assert.equal(result.rsc, '1');
  assert.equal(result.tree, 'tree');
});
