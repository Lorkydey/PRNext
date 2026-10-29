import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, rm, cp, symlink, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appFixture, startServer, repositoryRoot } from './support.mjs';
import { redisServer } from './redis-test-support.mjs';

test('independent native servers share HTML/ISR, fetch and functions and fence a remotely invalidated render', { timeout: 180000 }, async () => {
  const redis = await redisServer(), fixture = await appFixture(), counts = new Map(), values = new Map();
  let a, b, replica, release, blocked = false;
  const origin = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://local').searchParams.get('key'), value = values.get(key) || 1;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (blocked && key === 'app-race') await new Promise(resolve => { release = resolve; });
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ key, value }));
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${origin.address().port}`, renders = path.join(fixture.root, 'render-counts');
  const write = async (name, source) => { const filename = path.join(fixture.root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); };
  try {
    for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    await mkdir(renders); await mkdir(path.join(fixture.root, 'node_modules/@redis'));
    await symlink(fileURLToPath(new URL('./toolchain/node_modules/@redis/client', import.meta.url)), path.join(fixture.root, 'node_modules/@redis/client'), 'junction');
    const files = {
      'prnext.config.mjs': `export default{cacheHandler:'./redis-handler.mjs',cacheMaxMemorySize:0}`,
      'redis-handler.mjs': `import{createRedisIncrementalCache}from'@thomas.f/prnext/cache/redis';export default createRedisIncrementalCache({namespace:${JSON.stringify(randomUUID())},urlEnv:'PRNEXT_REDIS_TEST_URL'})`,
      'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
      'app/catalog/[id]/page.jsx': `import{appendFile}from'node:fs/promises';export const revalidate=60;export function generateStaticParams(){return []}export default async function Page({params}){const{id}=await params;await appendFile(${JSON.stringify(renders)}+'/app-'+id,'x');const data=await(await fetch(${JSON.stringify(url)}+'/?key=app-'+id,{cache:'force-cache',next:{tags:['product:'+id]}})).json();return <h1>{'Product '+id+' value '+data.value}</h1>}`,
      'pages/items/[id].jsx': `import{appendFile}from'node:fs/promises';export async function getStaticPaths(){return {paths:[],fallback:'blocking'}}export async function getStaticProps({params}){await appendFile(${JSON.stringify(renders)}+'/pages-'+params.id,'x');const data=await(await fetch(${JSON.stringify(url)}+'/?key=pages-'+params.id)).json();return {props:data,revalidate:60}}export default({value})=> <h1>{'Pages value '+value}</h1>`,
      'app/api/fetch/route.js': `export async function GET(request){const key=new URL(request.url).searchParams.get('key');const response=await fetch(${JSON.stringify(url)}+'/?key=fetch-'+key,{cache:'force-cache',headers:{authorization:request.headers.get('authorization')||''},next:{tags:['fetch:'+key]}});return Response.json(await response.json())}`,
      'app/api/function/route.js': `import{unstable_cache}from'next/cache';const read=unstable_cache(async key=>(await fetch(${JSON.stringify(url)}+'/?key=function-'+key,{cache:'no-store'})).json(),['function'],{revalidate:60,tags:['functions']});export async function GET(request){return Response.json(await read(new URL(request.url).searchParams.get('key')))}`,
      'app/api/invalidate/route.js': `import{revalidateTag,revalidatePath}from'next/cache';export async function POST(request){const data=await request.json();if(data.tag)revalidateTag(data.tag,data.soft?'max':{expire:0});if(data.path)revalidatePath(data.path);return Response.json({ok:true})}`,
    };
    for (const [name, source] of Object.entries(files)) await write(name, source);
    const env = { PRNEXT_REDIS_TEST_URL: redis.url };
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { cwd: fixture.root, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
    replica = await mkdtemp(path.join(tmpdir(), 'prnext-redis-replica-'));
    await cp(path.join(fixture.root, '.prnext'), path.join(replica, '.prnext'), { recursive: true });
    await symlink(path.join(fixture.root, 'node_modules'), path.join(replica, 'node_modules'), 'junction');
    await writeFile(path.join(replica, 'package.json'), '{"private":true,"type":"module"}');
    a = await startServer(fixture.root, ['--workers', '1'], env); b = await startServer(replica, ['--workers', '1'], env);
    async function get(server, route, json = false) {
      const response = await fetch(server.url + route); const body = await response.text();
      assert.equal(response.status, 200, body + '\n' + server.output()); return json ? JSON.parse(body) : body;
    }
    const app = await Promise.all([get(a, '/catalog/shared'), get(b, '/catalog/shared')]);
    for (const html of app) assert.match(html, /Product shared value 1/);
    assert.equal(await readFile(path.join(renders, 'app-shared'), 'utf8'), 'x', 'one native App regeneration across independent cache directories');
    const pages = await Promise.all([get(a, '/items/shared'), get(b, '/items/shared')]);
    for (const html of pages) assert.match(html, /Pages value 1/);
    assert.equal(await readFile(path.join(renders, 'pages-shared'), 'utf8'), 'x', 'one native Pages regeneration');
    for (const kind of ['fetch', 'function']) {
      const result = await Promise.all([get(a, '/api/' + kind + '?key=shared', true), get(b, '/api/' + kind + '?key=shared', true)]);
      assert.deepEqual(result[0], result[1]); assert.equal(counts.get(kind + '-shared'), 1);
    }
    values.set('app-shared', 2);
    const invalidation = await fetch(b.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag: 'product:shared', path: '/catalog/shared' }) });
    assert.equal(invalidation.status, 200, await invalidation.text());
    assert.match(await get(a, '/catalog/shared'), /Product shared value 2/);
    assert.match(await get(b, '/catalog/shared'), /Product shared value 2/);
    assert.equal(await readFile(path.join(renders, 'app-shared'), 'utf8'), 'xx');

    values.set('app-shared', 3);
    const softened = await fetch(b.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag: 'product:shared', soft: true }) });
    assert.equal(softened.status, 200, await softened.text());
    assert.match(await get(a, '/catalog/shared'), /Product shared value 2/, 'soft invalidation serves the old page while one replacement is generated');
    let refreshed = ''; const refreshDeadline = Date.now() + 10000;
    do { await delay(20); refreshed = await get(b, '/catalog/shared'); } while (!refreshed.includes('Product shared value 3') && Date.now() < refreshDeadline);
    assert.match(refreshed, /Product shared value 3/);
    assert.equal(await readFile(path.join(renders, 'app-shared'), 'utf8'), 'xxx');

    blocked = true; const running = get(a, '/catalog/race'); void running.catch(() => {});
    const deadline = Date.now() + 10000; while (!release && Date.now() < deadline) await delay(10);
    assert.ok(release, 'the first render reached its held origin request'); values.set('app-race', 2);
    const changed = await fetch(b.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tag: 'product:race', path: '/catalog/race' }) });
    assert.equal(changed.status, 200, await changed.text()); blocked = false; release();
    assert.match(await running, /Product race value 2/);
    assert.match(await get(b, '/catalog/race'), /Product race value 2/);
    assert.equal(counts.get('app-race'), 2, 'an invalidated render cannot reseed its obsolete HTML or fetch');
  } finally {
    blocked = false; release?.(); await a?.close(); await b?.close();
    await new Promise(resolve => origin.close(resolve)); await fixture.remove();
    if (replica) await rm(replica, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await redis.close();
  }
});
