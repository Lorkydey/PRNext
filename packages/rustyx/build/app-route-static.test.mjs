import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.rustyx-route-static-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('static Route Handlers publish one exact response artifact and retain explicit HTTP methods', async () => {
  await fixture({
    'app/layout.jsx': `export const dynamic='force-dynamic';export const generateStaticParams=()=>{throw new Error('Handler inherited layout generator')};export default({children})=>children`,
    'app/plain/route.js': `export function GET(){throw new Error('Default GET was prerendered')}`,
    'app/static/route.js': `export const revalidate=false;export function GET(){const headers=new Headers({'content-type':'application/octet-stream'});headers.append('set-cookie','one=1');headers.append('set-cookie','two=2');return new Response(new Uint8Array(8192).fill(42),{status:201,headers})}export function HEAD(){return new Response(null,{headers:{'x-head':'custom'}})}`,
    'app/mixed/route.js': `export const dynamic='force-static';export function GET(){throw new Error('Mixed-method GET was prerendered')}export function POST(){return new Response('written')}`,
    'app/encoded/route.js': `import{gzipSync}from'node:zlib';export const revalidate=60;export function GET(){return new Response(gzipSync('encoded response'.repeat(1000)),{headers:{'content-encoding':'gzip','content-type':'text/plain'}})}`,
    'app/missing/route.js': `export const dynamic='force-static';export function GET(){return new Response('missing',{status:404})}`,
    'app/failure/route.js': `export const dynamic='force-static';export function GET(){return new Response('try again',{status:503})}`,
  }, async root => {
    const result = await build(root);
    const routes = new Map(result.routes.map(route => [route.pattern, route]));
    const seeds = new Map(result.prerendered.map(seed => [seed.path, seed]));
    assert.deepEqual([...seeds.keys()].sort(), ['/encoded', '/missing', '/static']);
    for (const route of routes.values()) {
      if (route.internal) continue;
      assert.equal(route.kind, 'api');
      assert.equal(route.client, undefined);
      assert.ok(route.handlerMethods.includes('GET'));
    }
    assert.ok(routes.get('/static').handlerMethods.includes('HEAD'));
    assert.ok(routes.get('/mixed').handlerMethods.includes('POST'));
    for (const pathname of ['/plain', '/mixed', '/failure']) assert.equal(routes.get(pathname).ssg, undefined);
    assert.deepEqual(routes.get('/plain').handlerConfig, {});
    assert.deepEqual(routes.get('/static').handlerConfig, { revalidate: false });
    for (const seed of seeds.values()) {
      assert.match(seed.file, /^static\/route-[a-f\d]+\.body$/);
      assert.equal(Object.hasOwn(seed, 'dataFile'), false);
      assert.ok(seed.generatedAt > 0);
    }
    const binary = seeds.get('/static');
    assert.equal(binary.status, 201);
    assert.equal(binary.revalidate, false);
    assert.deepEqual(binary.headers['set-cookie'], ['one=1', 'two=2']);
    assert.deepEqual(await readFile(path.join(result.outputDirectory, binary.file)), Buffer.alloc(8192, 42));
    assert.deepEqual(gunzipSync(await readFile(path.join(result.outputDirectory, binary.file + '.gz'))), Buffer.alloc(8192, 42));
    const encoded = seeds.get('/encoded');
    assert.equal(encoded.revalidate, 60);
    assert.deepEqual(await readFile(path.join(result.outputDirectory, encoded.file)), gzipSync('encoded response'.repeat(1000)));
    await assert.rejects(stat(path.join(result.outputDirectory, encoded.file + '.gz')), { code: 'ENOENT' });
    assert.equal(seeds.get('/missing').status, 404);
  });
});

test('handler generators use their own complete params and explicit cold-generation policy', async () => {
  await fixture({
    'app/(group)/catalog/[team]/[...parts]/route.js': `export const revalidate=20;export const dynamicParams=false;export function generateStaticParams({params}){if(Object.keys(params).length)throw new Error('Unexpected parent params');return[{team:'café',parts:['a b','last']},{team:'café',parts:['a b','last']}]};export async function GET(request,{params}){return Response.json(await params)}`,
    'app/empty/[id]/route.js': `export function generateStaticParams(){return []};export const GET=()=>Response.json({ok:true})`,
    'app/forced/[id]/route.js': `export const dynamic='force-static';export const GET=()=>new Response('forced')`,
    'app/strict/[id]/route.js': `export const dynamic='error';export const GET=()=>new Response('strict')`,
    'app/ttl/[id]/route.js': `export const revalidate=30;export const GET=()=>new Response('uncached')`,
    'app/forever/[id]/route.js': `export const revalidate=false;export const GET=()=>new Response('uncached')`,
    'app/root/[[...parts]]/route.js': `export const generateStaticParams=()=>[{}];export const GET=()=>new Response('optional root')`,
  }, async root => {
    const result = await build(root);
    const routes = new Map(result.routes.map(route => [route.pattern, route]));
    const catalog = routes.get('/catalog/[team]/[...parts]');
    assert.equal(catalog.ssg, true);
    assert.equal(catalog.hasStaticParams, true);
    assert.equal(catalog.fallback, false);
    assert.deepEqual(catalog.allowedPaths, ['/catalog/caf%C3%A9/a%20b/last']);
    const seed = result.prerendered.find(seed => seed.path.startsWith('/catalog/'));
    assert.equal(seed.revalidate, 20);
    assert.deepEqual(JSON.parse(await readFile(path.join(result.outputDirectory, seed.file), 'utf8')), { team: 'café', parts: ['a b', 'last'] });
    for (const pathname of ['/empty/[id]', '/forced/[id]', '/strict/[id]']) {
      assert.equal(routes.get(pathname).ssg, true, pathname);
      assert.equal(routes.get(pathname).fallback, 'blocking');
    }
    for (const pathname of ['/ttl/[id]', '/forever/[id]']) assert.equal(routes.get(pathname).ssg, undefined, pathname);
    assert.equal(result.prerendered.find(seed => seed.path === '/root').dataFile, undefined);
    const dev = await build(root, { dev: true });
    assert.deepEqual(dev.prerendered, []);
    assert.ok(dev.routes.every(route => !route.ssg));
    assert.equal(dev.routes.find(route => route.pattern === '/catalog/[team]/[...parts]').handlerConfig.generateStaticParams, true);
  });
});

test('dynamic handler bailout retains closed params and failed generation keeps the published build', async () => {
  await fixture({
    'app/private/[id]/route.js': `import{headers}from'next/headers';export const dynamicParams=false;export const generateStaticParams=()=>[{id:'known'}];export async function GET(){return new Response((await headers()).get('host'))}`,
  }, async root => {
    const result = await build(root);
    const route = result.routes[0];
    assert.deepEqual(route.allowedPaths, ['/private/known']);
    assert.deepEqual(route.dynamicPaths, ['/private/known']);
    assert.equal(result.prerendered.length, 0);
    const before = await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8');
    await writeFile(path.join(root, 'app/private/[id]/route.js'), `export function generateStaticParams(){return [{id:'../escape'}]};export const GET=()=>new Response('invalid path')`);
    await assert.rejects(build(root), /generateStaticParams.*path separators/);
    assert.equal(await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8'), before);
  });
});

test('a handler export bailout preserves successful seeds but makes ungenerated paths dynamic', async () => {
  await fixture({
    'app/status/[id]/route.js': `export const revalidate=false;export const generateStaticParams=()=>[{id:'ok'},{id:'bad'}];export async function GET(_,{params}){const{id}=await params;return new Response(id,{status:id==='bad'?401:200})}`,
    'app/private/[id]/route.js': `import{headers}from'next/headers';export const revalidate=false;export const generateStaticParams=()=>[{id:'open'},{id:'private'}];export async function GET(_,{params}){const{id}=await params;return new Response(id==='private'?(await headers()).get('x-private'):id)}`,
    'app/closed/[id]/route.js': `export const revalidate=false;export const dynamicParams=false;export const generateStaticParams=()=>[{id:'ok'},{id:'bad'}];export async function GET(_,{params}){const{id}=await params;return new Response(id,{status:id==='bad'?503:200})}`,
  }, async root => {
    const result = await build(root);
    const routes = new Map(result.routes.map(route => [route.pattern, route]));
    assert.deepEqual(result.prerendered.map(seed => seed.path).sort(), ['/closed/ok', '/private/open', '/status/ok']);
    for (const [pattern, failed] of [['/status/[id]', '/status/bad'], ['/private/[id]', '/private/private']]) {
      const route = routes.get(pattern);
      assert.equal(route.ssg, true, 'successful build entries remain eligible for cache hits');
      assert.equal(route.fallback, 'dynamic');
      assert.deepEqual(route.dynamicPaths, [failed]);
    }
    const closed = routes.get('/closed/[id]');
    assert.equal(closed.fallback, false);
    assert.deepEqual(closed.allowedPaths, ['/closed/ok', '/closed/bad']);
    assert.deepEqual(closed.dynamicPaths, ['/closed/bad']);
  });
});
