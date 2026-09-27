import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, startServer, repositoryRoot } from './support.mjs';

let fixture, server;
const gateSource = `import {existsSync} from 'node:fs';
  import {setTimeout as delay} from 'node:timers/promises';
  async function waitForGate(name){while(!existsSync(name))await delay(5);}`;
before(async () => {
  fixture = await appFixture();
  await rm(path.join(fixture.root, 'app'), { recursive: true });
  for (const folder of ['app/api/progressive', 'app/api/large', 'app/api/failure', 'app/slow', 'pages/api']) {
    await mkdir(path.join(fixture.root, folder), { recursive: true });
  }
  await writeFile(path.join(fixture.root, 'app/layout.jsx'), `export default function Layout({children}){return <html><head/><body><header>Streaming layout</header>{children}</body></html>}`);
  await writeFile(path.join(fixture.root, 'app/page.jsx'), `export default function Page(){return <h1>Healthy stream worker</h1>}`);
  await writeFile(path.join(fixture.root, 'app/api/progressive/route.js'), `${gateSource}
    export async function GET(request){
      const gate=new URL(request.url).searchParams.get('gate');
      return new Response(new ReadableStream({
        start(controller){controller.enqueue(new TextEncoder().encode('first\\0é🚀\\n'));},
        async pull(controller){await waitForGate(gate);controller.enqueue(new TextEncoder().encode('second\\n'));controller.close();}
      }),{headers:{'content-type':'text/plain','x-worker-pid':String(process.pid),'set-cookie':'stream=yes; Path=/'}});
    }`);
  await writeFile(path.join(fixture.root, 'pages/api/pages-progressive.js'), `${gateSource}
    export default async function handler(req,res){
      res.setHeader('content-type','text/plain');res.setHeader('x-worker-pid',String(process.pid));
      res.flushHeaders();res.write(Buffer.from('first\\0é🚀\\n'));
      await waitForGate(req.query.gate);res.end('second\\n');
    }`);
  await writeFile(path.join(fixture.root, 'app/api/large/route.js'), `
    export function GET(){let index=0;return new Response(new ReadableStream({pull(controller){
      if(index===320){controller.close();return;}
      const bytes=new Uint8Array(65536);bytes.fill(index++%251);controller.enqueue(bytes);
    }}),{headers:{'content-type':'application/octet-stream'}});}`);
  await writeFile(path.join(fixture.root, 'app/api/failure/route.js'), `${gateSource}
    export function GET(request){const query=new URL(request.url).searchParams;
      if(query.has('early'))throw new Error('PRIVATE_STREAM_FAILURE');
      return new Response(new ReadableStream({
        start(controller){controller.enqueue(new TextEncoder().encode('before failure'));},
        async pull(controller){await waitForGate(query.get('gate'));controller.error(new Error('PRIVATE_STREAM_FAILURE'));}
      }),{headers:{'content-type':'text/plain'}});
    }`);
  await writeFile(path.join(fixture.root, 'app/slow/loading.jsx'), `export default function Loading(){return <p data-testid="stream-loading">Waiting for streamed content</p>}`);
  await writeFile(path.join(fixture.root, 'app/slow/page.jsx'), `${gateSource}
    export default async function Page({searchParams}){await waitForGate((await searchParams).gate);return <p data-testid="stream-result">Finished streamed content é🚀</p>}`);
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
  server = await startServer(fixture.root);
});
after(async () => { await server?.close(); await fixture?.remove(); });

async function withGate(name, callback) {
  const filename = path.join(fixture.root, name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('The response waited for completion instead of streaming')), 5000);
  try { await callback(filename, controller.signal, async () => { clearTimeout(timeout); await writeFile(filename, 'ready'); }); }
  finally { clearTimeout(timeout); controller.abort(); await writeFile(filename, 'ready'); }
}

for (const [label, route] of [['Web route', '/api/progressive'], ['Pages API', '/api/pages-progressive']]) {
  test(`${label} sends headers and binary text before the producer completes`, async () => {
    await withGate(`gate-${label.replaceAll(' ', '-')}`, async (gate, signal, release) => {
      const response = await fetch(`${server.url}${route}?gate=${encodeURIComponent(gate)}`, { headers: { 'accept-encoding': 'identity' }, signal });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), null);
      if (label === 'Web route') assert.match(response.headers.getSetCookie().join(';'), /stream=yes/);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(Buffer.from(first.value).toString(), 'first\0é🚀\n');
      await release();
      let remainder = '';
      for (;;) { const {value,done}=await reader.read();if(done)break;remainder+=Buffer.from(value).toString(); }
      assert.equal(remainder, 'second\n');
    });
  });
}

test('gzip flushes the first stream chunk while the producer is still waiting', async () => {
  await withGate('gate-gzip', async (gate, signal, release) => {
    const response = await fetch(`${server.url}/api/progressive?gate=${encodeURIComponent(gate)}`, { headers: { 'accept-encoding': 'gzip' }, signal });
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first\0é🚀\n');
    await release();
    let remainder='';
    for (;;) {const {value,done}=await reader.read();if(done)break;remainder+=Buffer.from(value).toString();}
    assert.equal(remainder,'second\n');
  });
});

test('a response larger than the buffered limit streams with exact binary bytes', async () => {
  const response = await fetch(`${server.url}/api/large`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(response.status, 200);
  let offset = 0;
  for await (const chunk of response.body) {
    for (let index=0; index<chunk.length; index++) assert.equal(chunk[index], Math.floor((offset+index)/65536)%251);
    offset += chunk.length;
  }
  assert.equal(offset, 320*65536);
});

test('a failed stream terminates after its sent prefix, stays private and leaves a healthy worker', async () => {
  const early = await fetch(`${server.url}/api/failure?early=1`);
  assert.equal(early.status, 500);
  assert.ok(!(await early.text()).includes('PRIVATE_STREAM_FAILURE'));
  await withGate('gate-failure', async (gate, signal, release) => {
    const response = await fetch(`${server.url}/api/failure?gate=${encodeURIComponent(gate)}`, { headers: { 'accept-encoding': 'identity' }, signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'before failure');
    await release();
    await assert.rejects(reader.read());
  });
  assert.equal((await fetch(`${server.url}/api/large`, { method:'HEAD' })).status, 200);
});

test('disconnecting a waiting stream releases its worker for the next request', async () => {
  await withGate('gate-disconnected', async (gate, signal) => {
    const response = await fetch(`${server.url}/api/progressive?gate=${encodeURIComponent(gate)}`, { headers: { 'accept-encoding': 'identity' }, signal });
    const reader = response.body.getReader();
    assert.ok((await reader.read()).value.length);
    await reader.cancel();
    const next = await fetch(`${server.url}/api/large`, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    assert.equal(next.status, 200);
  });
});

for (const flight of [false, true]) {
  test(`${flight ? 'Flight' : 'HTML'} sends a loading shell before the async Server Component completes`, async () => {
    await withGate(`gate-${flight ? 'flight' : 'html'}`, async (gate, signal, release) => {
      const response = await fetch(`${server.url}/slow?gate=${encodeURIComponent(gate)}`, { headers: { 'accept-encoding': 'identity', ...(flight ? { RSC:'1' } : {}) }, signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      let prefix = '';
      while (!prefix.includes('Waiting for streamed content')) {
        const {value,done}=await reader.read();assert.equal(done,false);prefix+=Buffer.from(value).toString();
      }
      assert.ok(!prefix.includes('Finished streamed content'));
      await release();
      let suffix = '';
      for (;;) {const {value,done}=await reader.read();if(done)break;suffix+=Buffer.from(value).toString();}
      assert.ok(suffix.includes('Finished streamed content'), 'the completed component arrives in a later chunk');
    });
  });
}
