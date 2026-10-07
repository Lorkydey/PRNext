import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, repositoryRoot, startServer } from './support.mjs';
import { startRequestLoad } from './request-load.mjs';

let fixture;
before(async () => {
  fixture = await appFixture();
  for (const folder of ['app', 'pages']) await rm(path.join(fixture.root, folder), { recursive: true, force: true });
  const gate = path.join(fixture.root, 'release-render');
  const files = {
    'public/robots.txt': 'ready',
    'app/api/stream/route.js': `export const dynamic='force-dynamic';export function GET(request){const id=new URL(request.url).searchParams.get('id');let timer;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('start:'+id+':'+process.pid+'\\n'));timer=setInterval(()=>{c.enqueue(new TextEncoder().encode('tick:'+id+'\\n'))},15)},cancel(){clearInterval(timer)}}),{headers:{'content-type':'text/plain'}})}`,
    'pages/api/raw.js': `import{createHash}from'node:crypto';export const config={api:{bodyParser:false}};export default async function handler(req,res){const hash=createHash('sha256');let length=0;for await(const chunk of req){length+=chunk.length;hash.update(chunk)}res.json({length,hash:hash.digest('hex')})}`,
    'pages/api/stuck.js': `import{writeFileSync}from'node:fs';export default async function handler(req,res){writeFileSync(${JSON.stringify(path.join(fixture.root,'stuck-started'))},String(process.pid));if(req.query.block){for(;;){}}else await new Promise(()=>{});res.end('never')}`,
    'pages/api/probe.js': `import{existsSync}from'node:fs';let active=0;export default async function handler(req,res){if(req.query.stats)return res.json({active,pid:process.pid,sockets:process._getActiveHandles().filter(h=>h.constructor.name==='Socket'&&h.remotePort).length});active++;try{if(req.query.gate)while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));res.json({pid:process.pid,value:req.query.value})}finally{active--}}`,

    'pages/pages-ssr.jsx': `export function getServerSideProps({query}){return {props:{value:query.value}}}export default function Page({value}){return <p>{value}</p>}`,
    'app/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
    'app/app-ssr/page.jsx': `export const dynamic='force-dynamic';export default async function Page({searchParams}){return <p>{(await searchParams).value}</p>}`,
    'app/suspended/page.jsx': `import{Suspense}from'react';import{cookies,headers}from'next/headers';import{existsSync}from'node:fs';export const dynamic='force-dynamic';async function Content({id}){while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));return <p>{id+':'+(await cookies()).get('session')?.value+':'+(await headers()).get('x-test-id')}</p>}export default async function Page({searchParams}){const {id}=await searchParams;return <Suspense fallback={<p>{'pending:'+id}</p>}><Content id={id}/></Suspense>}`,
    'app/before-shell/page.jsx': `import{appendFileSync,existsSync}from'node:fs';export const dynamic='force-dynamic';export default async function Page({searchParams}){const{id}=await searchParams;appendFileSync(${JSON.stringify(path.join(fixture.root,'render-starts'))},id+'\\n');while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));return <p>{'completed:'+id}</p>}`,
    'pages/api/echo.js': `import{existsSync}from'node:fs';export default async function handler(req,res){if(req.query.gate)while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,5));res.json({value:req.query.value,body:req.body||null})}`,
  };
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(fixture.root, name)), { recursive: true });
    await writeFile(path.join(fixture.root, name), source);
  }
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
});
after(async () => { await fixture?.remove(); });

test('one cold worker accepts bursts of 32 Pages SSR, App SSR and POST requests without 503 or context mixing', async () => {
  const server = await startServer(fixture.root);
  try {
    for (const endpoint of ['/pages-ssr', '/app-ssr', '/api/echo']) {
      await Promise.all(Array.from({ length: 32 }, async (_, index) => {
        const value = `request-${index}-end`;
        const api = endpoint === '/api/echo';
        const response = await fetch(`${server.url}${endpoint}?value=${value}`, {
          ...(api ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index, value }) } : {}),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200, `${endpoint} ${value}`);
        if (api) assert.deepEqual(await response.json(), { value, body: { index, value } });
        else assert.ok((await response.text()).includes(`<p>${value}</p>`), value);
      }));
    }
  } finally { await server.close(); }
});

test('a large admission limit does not preallocate or rotate through hundreds of connections', async () => {
  const server = await startServer(fixture.root);
  try {
    for (let i = 0; i < 80; i++) {
      const stats = await fetch(server.url + '/api/probe?stats=1').then(r => r.json());
      assert.ok(stats.sockets <= 4, `Sequential requests opened ${stats.sockets} connections`);
    }
  } finally { await server.close(); }
});

test('32 Suspense shells progress together, a 33rd waits, and cancellation admits it without cancelling peers', { timeout: 15000 }, async () => {
  const server = await startServer(fixture.root), gate = path.join(fixture.root, 'release-render');
  const controllers = [], readers = [];
  const pending = [];
  async function open(id) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${server.url}/suspended?id=${id}`, {
      headers: { 'accept-encoding': 'identity', cookie: `session=cookie-${id}`, 'x-test-id': `header-${id}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); readers.push(reader);
    let html = '';
    while (!html.includes(`pending:${id}`)) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      html += Buffer.from(chunk.value).toString();
    }
    return { id, reader, html, controller };
  }
  try {
    await rm(gate, { force: true });
    for (let id = 0; id < 32; id++) pending.push(open(id));
    const active = await Promise.all(pending);
    let admitted = false;
    const waiting = open(32).then(value => { admitted = true; return value; }); pending.push(waiting);
    await delay(100);
    assert.equal(admitted, false, 'The active render limit must remain bounded');
    const api = await fetch(server.url + '/api/probe?value=stream-peers', { signal: AbortSignal.timeout(3000) });
    assert.equal((await api.json()).value, 'stream-peers', 'Suspended pages must not monopolize API admission');
    active[0].controller.abort();
    await active[0].reader.cancel().catch(() => {});
    const next = await waiting;
    await writeFile(gate, 'release');
    await Promise.all([...active.slice(1), next].map(async ({ id, reader, html }) => {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; html += Buffer.from(chunk.value).toString(); }
      assert.ok(html.includes(`${id}:cookie-${id}:header-${id}`), `request context ${id}`);
      assert.ok(html.endsWith('</body></html>'));
    }));
  } finally {
    await writeFile(gate, 'release');
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(pending); await Promise.allSettled(readers.map(reader => reader.cancel()));
    await server.close(); await rm(gate, { force: true });
  }
});

test('pre-header rendering stays at 16 even when 32 live responses are allowed', { timeout: 15000 }, async () => {
  const server = await startServer(fixture.root), gate = path.join(fixture.root, 'release-render');
  const audit = path.join(fixture.root, 'render-starts'), controller = new AbortController();
  let pending = [];
  try {
    await rm(gate, { force: true }); await writeFile(audit, '');
    pending = Array.from({ length: 32 }, (_, id) => fetch(`${server.url}/before-shell?id=${id}`, { signal: controller.signal }).then(async response => {
      assert.equal(response.status, 200); assert.ok((await response.text()).includes('completed:'+id));
    }));
    for (let attempt = 0; attempt < 150; attempt++) {
      if ((await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).length >= 16) break;
      await delay(20);
    }
    await delay(100);
    assert.equal((await readFile(audit, 'utf8')).trim().split('\n').length, 16);
    await writeFile(gate, 'release'); await Promise.all(pending);
    assert.equal(new Set((await readFile(audit, 'utf8')).trim().split('\n')).size, 32);
  } finally {
    await writeFile(gate, 'release'); controller.abort(); await Promise.allSettled(pending);
    await server.close(); await rm(gate, { force: true }); await rm(audit, { force: true });
  }
});

test('classic: 384 asynchronous handlers actually run together in one process and keep their contexts', async () => {
  const server = await startServer(fixture.root, ['--profile', 'classic']), gate = path.join(fixture.root, 'release-render');
  let pending;
  try {
    await rm(gate, { force: true });
    pending = await startRequestLoad(384, index => fetch(`${server.url}/api/probe?gate=1&value=${index}`, { signal: AbortSignal.timeout(15000) }).then(r => { assert.equal(r.status, 200); return r.json(); }));
    let stats;
    for (let i = 0; i < 100; i++) {
      stats = await fetch(server.url + '/api/probe?stats=1', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
      if (stats.active === 384) break;
      await delay(20);
    }
    assert.equal(stats.active, 384, 'Pending application work must run concurrently, not sit in the native queue');
    const page = await fetch(server.url + '/app-ssr?value=while-apis-wait', { signal: AbortSignal.timeout(3000) });
    assert.equal(page.status, 200); assert.match(await page.text(), /while-apis-wait/);
    await writeFile(gate, 'release');
    const results = await Promise.all(pending);
    assert.equal(new Set(results.map(r => r.pid)).size, 1);
    assert.deepEqual(results.map(r => r.value), Array.from({ length: 384 }, (_, i) => String(i)));
  } finally {
    await writeFile(gate, 'release'); if (pending) await Promise.allSettled(pending);
    await server.close(); await rm(gate, { force: true });
  }
});

test('balanced by default: API overload stays bounded, returns Retry-After and recovers after the gate opens', async () => {
  const server = await startServer(fixture.root, [], { PRNEXT_PROFILE: '', PRNEXT_MEMORY_PROFILE: '' });
  const gate = path.join(fixture.root, 'release-render');
  const completed = [];
  let pending;
  try {
    pending = await startRequestLoad(560, async index => {
      const response = await fetch(`${server.url}/api/echo?gate=1&value=${index}`, { signal: AbortSignal.timeout(10000) });
      const result = { status: response.status, retry: response.headers.get('retry-after'), body: await response.text() };
      completed.push(result);
      return result;
    });
    try {
      for (let attempt = 0; completed.length < 48 && attempt < 200; attempt++) await delay(10);
      assert.equal(completed.length, 48, 'Exactly 560 minus 512 requests must be rejected before the gate opens');
      assert.ok(completed.every(r => r.status === 503), 'Accepted work must remain behind the gate');
    } finally { await writeFile(gate, 'release'); }
    const results = await Promise.all(pending);
    const accepted = results.filter(r => r.status === 200);
    assert.equal(accepted.length, 512, '256 active API requests plus 256 unread waiters; body bytes have a separate budget');
    for (const result of results.filter(r => r.status !== 200)) {
      assert.equal(result.status, 503);
      assert.equal(result.retry, '1');
      assert.match(result.body, /Render queue is full/);
    }
    const response = await fetch(`${server.url}/api/echo?value=recovered`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).value, 'recovered');
  } finally {
    await writeFile(gate, 'release');
    if (pending) await Promise.allSettled(pending);
    await server.close();
    await rm(gate, { force: true });
  }
});


test('async work and slow streams share one process without blocking, mixing contexts or cancelling peers', async () => {
  const server = await startServer(fixture.root),gate = path.join(fixture.root, 'release-render');
  let slow,reader,peerReader;
  try {
    await rm(gate,{force:true});
    slow=fetch(server.url+'/api/probe?gate=1&value=slow').then(r=>r.json());
    const fast=await fetch(server.url+'/api/probe?value=fast',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    assert.equal(fast.value,'fast');
    const stream=await fetch(server.url+'/api/stream?id=first');reader=stream.body.getReader();
    assert.ok(new TextDecoder().decode((await reader.read()).value).includes('start:first:'+fast.pid));
    const peer=await fetch(server.url+'/api/stream?id=second');peerReader=peer.body.getReader();
    assert.ok(new TextDecoder().decode((await peerReader.read()).value).includes('start:second:'+fast.pid));
    await reader.cancel();reader=undefined;
    const bytes=new TextDecoder().decode((await peerReader.read()).value);
    assert.ok(bytes.includes('second'));assert.ok(!bytes.includes('first'));
    const alive=await fetch(server.url+'/api/probe?value=after',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    assert.equal(alive.pid,fast.pid);assert.equal(alive.value,'after');
    await writeFile(gate,'release');const completed=await slow;
    assert.equal(completed.pid,fast.pid);assert.equal(completed.value,'slow');
  } finally {await writeFile(gate,'release');await reader?.cancel();await peerReader?.cancel();await slow?.catch(()=>{});await server.close();await rm(gate,{force:true})}
});

test('stopping the native parent retires its shared socket worker', async () => {
  const server = await startServer(fixture.root);
  let pid;
  try { ({pid} = await fetch(server.url+'/api/probe?value=lifetime').then(r=>r.json())); }
  finally { await server.close(); }
  const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { if(error.code==='ESRCH')return false; throw error; } };
  for(let i=0;i<100 && alive();i++)await delay(20);
  assert.equal(alive(),false,'The shared worker must not survive the native parent');
});

test('workers without socket capability keep the legacy stdio protocol', async () => {
  const file=path.join(fixture.root,'.prnext/runtime/worker.mjs'),original=await readFile(file,'utf8');
  let server;
  try {
    await writeFile(file,original.replace(/\/\/ prnext-transport:socket-v[12]/,'// legacy transport'));
    server=await startServer(fixture.root);
    const response=await fetch(server.url+'/api/probe?value=legacy',{signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,200);assert.equal((await response.json()).value,'legacy');
  } finally {await server?.close();await writeFile(file,original)}
});


test('binary uploads preserve byte content through reusable lanes and reject oversize bodies', async () => {
  const { createHash } = await import('node:crypto');
  const { Readable } = await import('node:stream');
  const server = await startServer(fixture.root);
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const expected = { length: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') };
  try {
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const body = i % 2 ? Readable.from((async function*(){for(let at=0;at<bytes.length;at+=65537)yield bytes.subarray(at,at+65537)})()) : bytes;
      const response = await fetch(server.url+'/api/raw', {method:'POST', body, duplex:'half'});
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
    }));
    const tooLarge = await fetch(server.url+'/api/raw', {method:'POST', body:Buffer.alloc(8*1024*1024+1)});
    assert.equal(tooLarge.status, 413); await tooLarge.text();
    const healthy=await fetch(server.url+'/api/probe?value=after-upload').then(r=>r.json());
    assert.equal(healthy.value,'after-upload');
  } finally { await server.close(); }
});

test('cancelled uncooperative npm code retires the process and a subsequent request recovers', {timeout:50000}, async () => {
  for(const mode of ['async','block']) {
    const server=await startServer(fixture.root), abort=new AbortController(), started=path.join(fixture.root,'stuck-started');
    let pending;
    try {
      await rm(started,{force:true});
      // Leave peer lanes connected: cancellation must recover the shared host,
      // not merely drop the last reference to a cold single-lane process.
      await Promise.all(Array.from({length:16},()=>fetch(server.url+'/api/probe?value=warm').then(r=>r.json())));
      pending=fetch(server.url+'/api/stuck'+(mode==='block'?'?block=1':''),{signal:abort.signal}).catch(()=>null);
      let pid;
      for(let i=0;i<200;i++){try{pid=Number(await readFile(started,'utf8'));break}catch{await delay(10)}}
      assert.ok(pid,'handler started'); abort.abort(); await pending;
      const exited=()=>{try{process.kill(pid,0);return false}catch(e){if(e.code==='ESRCH')return true;throw e}};
      for(let i=0;i<340 && !exited();i++)await delay(100);
      assert.ok(exited(),mode+' ignored cancellation must not retain a process forever: '+server.output());
      let healthy;
      for(let i=0;i<20;i++){const response=await fetch(server.url+'/api/probe?value=recovered',{signal:AbortSignal.timeout(3000)});if(response.status===200){healthy=await response.json();break}await response.text();await delay(100)}
      assert.equal(healthy?.value,'recovered');assert.notEqual(healthy.pid,pid);
    } finally {abort.abort();await pending;await server.close();await rm(started,{force:true})}
  }
});
