import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);
const runtime = fileURLToPath(new URL('./', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));

function responses(bytes) {
  const parsed = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const newline = bytes.indexOf(10, offset);
    assert.notEqual(newline, -1, 'worker returned a complete control frame');
    const frame = JSON.parse(bytes.subarray(offset, newline));
    offset = newline + 1;
    if (frame.type === 'head') parsed.set(frame.id, { ...frame, chunks: [] });
    else if (frame.type === 'chunk') {
      assert.ok(offset + frame.length <= bytes.length);
      parsed.get(frame.id).chunks.push(bytes.subarray(offset, offset + frame.length));
      offset += frame.length;
    } else if (frame.type === 'end') {
      const response = parsed.get(frame.id);
      response.body = Buffer.concat(response.chunks);
      delete response.chunks;
    } else {
      assert.equal(frame.type, undefined, 'worker did not emit a streaming error');
      parsed.set(frame.id, { ...frame, body: Buffer.from(frame.body, 'base64') });
    }
  }
  return parsed;
}

test('middleware, Pages API, App API and handler ISR workers load React only when a page needs it', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(path.join(repository, '.prnext-lazy-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, '.prnext');
  await mkdir(path.join(dist, 'server'), { recursive: true });
  await mkdir(path.join(dist, 'runtime'));
  // Other test files create and remove fixtures inside runtime concurrently.
  // Copy only the production modules, as the actual build does.
  for (const entry of await readdir(runtime, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      await cp(path.join(runtime, entry.name), path.join(dist, 'runtime', entry.name));
    }
  }
  await cp(new URL('../compat/', import.meta.url), path.join(dist, 'compat'), { recursive: true });
  const files = {
    'snapshot.mjs': `import {createRequire} from 'node:module';
      import {unstable_cache} from '../compat/cache.cjs';
      const require=createRequire(import.meta.url);
      export async function snapshot(){return {
        react:Object.keys(require.cache).filter(name=>name.split(${JSON.stringify(path.sep)}).some((part,index,parts)=>parts[index-1]==='node_modules'&&['react','react-dom','react-server-dom-webpack'].includes(part))),
        cached:await unstable_cache(async()=>({value:'cache works'}))(),
        fetchPatched:!!globalThis.fetch[Symbol.for('prnext.fetch-cache')]
      }}`,
    'middleware.mjs': `import {NextResponse} from '../compat/server.cjs';import {snapshot} from './snapshot.mjs';export async function middleware(){return NextResponse.json(await snapshot())}`,
    'pages-api.mjs': `import {snapshot} from './snapshot.mjs';export default async function(req,res){res.json({...await snapshot(),body:req.body})}`,
    'app-api.mjs': `import {headers} from '../compat/headers.cjs';import {snapshot} from './snapshot.mjs';export async function GET(){return Response.json({...await snapshot(),header:(await headers()).get('x-test')})}`,
    'static-api.mjs': `import {snapshot} from './snapshot.mjs';export const revalidate=false;export async function GET(){return Response.json(await snapshot())}`,
    'failure.mjs': `export async function GET(){throw new Error('PRIVATE_FAILURE')}`,
    'page.mjs': `import React from 'react';export const getServerSideProps=()=>({props:{}});export default function Page(){return React.createElement('h1',null,'Pages renderer loaded lazily')}`,
  };
  for (const [name, source] of Object.entries(files)) await writeFile(path.join(dist, 'server', name), source);
  const routes = [
    { id: 'pages-api', kind: 'api', module: 'server/pages-api.mjs' },
    { id: 'app-api', kind: 'api', router: 'app', module: 'server/app-api.mjs' },
    { id: 'static-api', kind: 'api', router: 'app', module: 'server/static-api.mjs', pattern: '/static-api', handlerConfig: { revalidate: false }, cacheConfig: { revalidate: false } },
    { id: 'failure', kind: 'api', router: 'app', module: 'server/failure.mjs' },
    { id: 'page', kind: 'page', module: 'server/page.mjs' },
  ];
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({ routes, middleware: { module: 'server/middleware.mjs', exportName: 'middleware' } }));
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.PRNEXT_CACHE_URL;
  delete env.PRNEXT_CACHE_TOKEN;
  const child = spawn(process.execPath, [path.join(dist, 'runtime/worker.mjs'), root], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const requests = [
    { routeId: '__prnext_middleware', renderMode: 'middleware', stream: true },
    { routeId: 'pages-api', method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"hello":"world"}').toString('base64'), stream: true },
    { routeId: 'app-api', headers: { 'x-test': 'request context works' }, stream: true },
    { routeId: 'static-api', renderMode: 'isr', stream: true },
    { routeId: 'failure' },
    { routeId: 'page' },
    { routeId: 'app-api' },
  ];
  child.stdin.end(requests.map((request, index) => JSON.stringify({ id: index, url: 'http://app.test/' + request.routeId, method: 'GET', ...request }) + '\n').join(''));
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, stderr);
  const result = responses(Buffer.concat(chunks));
  assert.equal(result.size, requests.length);
  for (const id of [0, 1, 2, 3]) {
    assert.equal(result.get(id).status, 200, stderr);
    const value = JSON.parse(result.get(id).body);
    assert.deepEqual(value.react, [], `${requests[id].routeId} must not load React or ReactDOM`);
    assert.deepEqual(value.cached, { value: 'cache works' });
    assert.equal(value.fetchPatched, true, 'the lightweight runtime still installs extended fetch');
  }
  assert.deepEqual(JSON.parse(result.get(1).body).body, { hello: 'world' });
  assert.equal(JSON.parse(result.get(2).body).header, 'request context works');
  assert.equal(result.get(3).isr.kind, 'route');
  assert.equal(result.get(4).status, 500);
  assert.equal(result.get(4).body.toString(), 'Internal Server Error');
  assert.match(result.get(5).body.toString(), /<h1>Pages renderer loaded lazily<\/h1>/);
  assert.ok(JSON.parse(result.get(6).body).react.some(name => name.split(path.sep).includes('react-dom')), 'the same worker loads ReactDOM when Pages rendering begins');
});

test('loading the App renderer does not initialize Pages router or head contexts', async () => {
  const script = `import {createRequire} from 'node:module';import assert from 'node:assert/strict';
    const require=createRequire(import.meta.url);
    await import('./packages/prnext/runtime/app-render.mjs');
    assert.equal(require.cache[require.resolve('./packages/prnext/compat/router.cjs')],undefined);
    assert.equal(require.cache[require.resolve('./packages/prnext/compat/head.cjs')],undefined);
    process.stdout.write('isolated');`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: repository, timeout: 5_000 });
  assert.equal(result.stdout, 'isolated');
});
