import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appFixture, repositoryRoot, startServer } from './support.mjs';

let fixture, server, origin, originUrl, manifest, release, background = 0, cachedCalls = 0;
before(async () => {
  fixture = await appFixture();
  origin = createServer(async (request, response) => {
    if (request.url === '/cached') { response.end(String(++cachedCalls)); return; }
    if (request.url === '/redirect') { response.writeHead(302, { location: '/final' }); response.end(); return; }
    if (request.url === '/background') background++;
    if (request.url === '/gate') await new Promise(resolve => { release = resolve; });
    response.end('origin');
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  originUrl = `http://127.0.0.1:${origin.address().port}`;
  for (const name of ['app', 'pages', 'components', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
  const files = {
    'app/edge-allowed/[id]/route.js': `export const runtime='edge';export const dynamicParams=false;export function generateStaticParams(){return[{id:'one'}]}export async function GET(req,{params}){return Response.json(await params)}`,
    'app/edge-cached/route.js': `import {revalidateTag} from 'next/cache';export const runtime='edge';export async function GET(){return new Response(await (await fetch(${JSON.stringify(originUrl + '/cached')},{cache:'force-cache',next:{tags:['edge-cached'],revalidate:60}})).text())}export async function POST(){revalidateTag('edge-cached',{expire:0});return new Response('invalidated')}`,
    'prnext.config.mjs': `export default{basePath:'/docs',env:{EDGE_CONFIG:'configured'}}`,
    'node_modules/edge-esm/package.json': JSON.stringify({ name: 'edge-esm', type: 'module', exports: { 'edge-light': './edge.js', default: './node.js' } }),
    'node_modules/edge-esm/edge.js': `export const packageValue=await Promise.resolve('web-esm');`,
    'node_modules/edge-esm/node.js': `import fs from 'node:fs';export const packageValue=fs;`,
    'middleware.js': `import {NextResponse} from 'next/server';
      export const config={runtime:'edge',matcher:['/edge/:path*','/edge-alias/:path*','/edge-middleware-stream']};
      export default async function middleware(request,event){
        event.waitUntil(fetch(${JSON.stringify(originUrl + '/background')}));
        if(request.nextUrl.pathname==='/edge-middleware-stream')return new Response(new ReadableStream({async start(c){c.enqueue(new TextEncoder().encode('first'));await fetch(${JSON.stringify(originUrl + '/gate')});c.enqueue(new TextEncoder().encode('last'));c.close()}}));
        const headers=new Headers(request.headers);headers.set('x-edge-middleware',[EdgeRuntime,typeof Buffer,request instanceof Request].join(':'));
        const response=request.nextUrl.pathname.startsWith('/edge-alias/')?NextResponse.rewrite(new URL('/docs/edge/'+request.nextUrl.pathname.split('/').pop(),request.url),{request:{headers}}):NextResponse.next({request:{headers}});
        response.cookies.set('edge-middleware','yes');return response;
      }`,
    'app/edge/[id]/route.ts': `import {NextResponse} from 'next/server';import {cookies,headers} from 'next/headers';import {packageValue} from 'edge-esm';
      export const runtime='edge';
      export async function GET(request:Request,{params}){
        const h=await headers(),c=await cookies();await Promise.resolve();
        const response=NextResponse.json({params:await params,request:request instanceof Request,edge:EdgeRuntime,buffer:typeof Buffer,require:typeof require,node:typeof process.versions,environment:process.env.EDGE_CONFIG,packageValue,middleware:h.get('x-edge-middleware'),cookie:c.get('edge-middleware')?.value,auth:h.get('authorization'),hash:(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('web'))).byteLength});
        response.cookies.set('one','1');response.cookies.set('two','2');return response;
      }
      export async function POST(request){const form=await request.formData();const file=form.get('file');return Response.json({field:form.get('field'),file:await file.text(),type:file.type,request:request instanceof Request})}`,
    'app/edge-stream/route.js': `export const runtime='edge';export async function GET(){return new Response(new ReadableStream({async start(c){c.enqueue(new TextEncoder().encode('first'));await fetch(${JSON.stringify(originUrl + '/gate')});c.enqueue(new TextEncoder().encode('last'));c.close()}}))}`,
    'app/edge-cookie/route.js': `import {cookies} from 'next/headers';export const runtime='edge';export async function GET(){(await cookies()).set('adapter','yes');return Response.json({cookie:(await cookies()).get('adapter').value})}`,
    'app/edge-eval/route.js': `export const runtime='edge';export async function GET(){try{(()=>{}).constructor('return 1')();return Response.json({blocked:false})}catch(error){return Response.json({blocked:true,name:error.name})}}`,
    'app/edge-fetch/route.js': `export const runtime='edge';export async function GET(){const response=await fetch(new Request(${JSON.stringify(originUrl + '/redirect')},{credentials:'omit',cache:'no-store'}));const clone=response.clone(),again=clone.clone();return Response.json({url:response.url,redirected:response.redirected,type:response.type,cloneUrl:clone.url,cloneRedirected:clone.redirected,cloneType:clone.type,againUrl:again.url,bodies:await Promise.all([response.text(),clone.text(),again.text()])})}`,
  };
  for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
  manifest = JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
  server = await startServer(fixture.root);
});
test('Edge generated-path restrictions survive dynamic rendering without static responses', async () => {
  const known = await fetch(server.url + '/docs/edge-allowed/one');
  assert.equal(known.status, 200); assert.deepEqual(await known.json(), {id:'one'});
  assert.equal((await fetch(server.url + '/docs/edge-allowed/unknown')).status, 404);
  const route = manifest.routes.find(route => route.pattern === '/edge-allowed/[id]');
  assert.equal(route.ssg, undefined); assert.deepEqual(route.allowedPaths, ['/edge-allowed/one']);
});
after(async () => { release?.(); await server?.close(); origin?.closeAllConnections(); if (origin) await new Promise(resolve => origin.close(resolve)); await fixture?.remove(); });

test('Edge middleware and handlers use Web globals, ESM packages, crypto and request-scoped credentials', async () => {
  assert.equal(manifest.middleware.runtime, 'edge');
  for (const route of manifest.routes.filter(route => route.router === 'app' && route.kind === 'api')) assert.equal(route.handlerConfig.runtime, 'edge');
  assert.equal(manifest.prerendered.length, 0);
  const replies = await Promise.all(['one', 'two'].map(async name => {
    const response = await fetch(`${server.url}/docs/edge/${name}`, { headers: { authorization: name, cookie: 'edge-middleware=client' } });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie().join(';');
    assert.match(cookies, /one=1/); assert.match(cookies, /two=2/); assert.match(cookies, /edge-middleware=yes/);
    return response.json();
  }));
  for (const [index, data] of replies.entries()) {
    assert.deepEqual(data, { params: { id: ['one', 'two'][index] }, request: true, edge: 'edge-runtime', buffer: 'undefined', require: 'undefined', node: 'undefined', environment: 'configured', packageValue: 'web-esm', middleware: 'edge-runtime:undefined:true', cookie: 'client', auth: ['one', 'two'][index], hash: 32 });
  }
  for (let attempt = 0; background < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(background >= 2, 'waitUntil completed independently');
});

test('Edge middleware rewrites and Route Handler cookie mutations preserve native transport', async () => {
  const rewrite = await fetch(`${server.url}/docs/edge-alias/rewritten`);
  assert.equal(rewrite.status, 200); assert.deepEqual((await rewrite.json()).params, { id: 'rewritten' });
  const response = await fetch(`${server.url}/docs/edge-cookie`);
  assert.deepEqual(await response.json(), { cookie: 'yes' }); assert.match(response.headers.get('set-cookie'), /adapter=yes/);
});

test('Edge request bodies retain multipart files and standard method dispatch', async () => {
  const body = new FormData(); body.set('field', 'hello'); body.set('file', new Blob(['file content'], { type: 'text/plain' }), 'sample.txt');
  const response = await fetch(`${server.url}/docs/edge/post`, { method: 'POST', body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { field: 'hello', file: 'file content', type: 'text/plain', request: true });
  const options = await fetch(`${server.url}/docs/edge/post`, { method: 'OPTIONS' });
  assert.equal(options.status, 204); assert.equal(options.headers.get('allow'), 'GET, HEAD, OPTIONS, POST');
});

test('Edge middleware and route bodies stream before their asynchronous work finishes', async () => {
  for (const pathname of ['/edge-stream', '/edge-middleware-stream']) {
    release = undefined;
    const response = await fetch(`${server.url}/docs${pathname}`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
    for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release); release();
    let rest = ''; for (;;) { const item = await reader.read(); if (item.done) break; rest += new TextDecoder().decode(item.value); }
    assert.equal(rest, 'last');
  }
});

test('V8 rejects dynamic JavaScript compilation even when reached indirectly', async () => {
  const response = await fetch(`${server.url}/docs/edge-eval`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { blocked: true, name: 'EvalError' });
});

test('Edge fetch(Request) preserves redirect response metadata and cloned response bodies', async () => {
  const response = await fetch(`${server.url}/docs/edge-fetch`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: originUrl + '/final', redirected: true, type: 'basic', cloneUrl: originUrl + '/final', cloneRedirected: true, cloneType: 'basic', againUrl: originUrl + '/final', bodies: ['origin', 'origin', 'origin'] });
});

test('Edge dynamic handlers share the native fetch cache and invalidate its tags', async () => {
  assert.equal(await (await fetch(server.url + '/docs/edge-cached')).text(), '1');
  assert.equal(await (await fetch(server.url + '/docs/edge-cached')).text(), '1');
  await (await fetch(server.url + '/docs/edge-cached', { method: 'POST' })).text();
  assert.equal(await (await fetch(server.url + '/docs/edge-cached')).text(), '2');
  assert.equal(cachedCalls, 2);
});
