import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderAppPage, renderFlight, decodeFlight, closeAppRuntime } from './app-render.mjs';
import { workerStreamChannel, APP_STREAM_CHUNK_BYTES } from './app-stream-channel.mjs';

const directories = [];
after(async () => { await closeAppRuntime(); await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(page = `await new Promise(resolve=>setTimeout(resolve,250)); return React.createElement('h1',null,'Delayed content')`) {
  const distDir = await mkdtemp(fileURLToPath(new URL('./.stream-test-', import.meta.url)));
  directories.push(distDir);
  const modulePath = path.join(distDir, 'page.mjs');
  await writeFile(modulePath, `import React from 'react';
    export const page={default:async()=>{${page}}};
    export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))},loading:{default:()=>React.createElement('p',null,'Loading shell')}}];`);
  return { modulePath, distDir, url: 'http://localhost/slow', production: true, route: { client: '/client.js' } };
}

test('the Flight thread sends no chunks without credit and splits transferable allocations', async () => {
  const messages = [];
  const channel = workerStreamChannel({ postMessage(message, transfer) { messages.push(structuredClone(message, { transfer })); } }, 1);
  const bytes = new Uint8Array(APP_STREAM_CHUNK_BYTES * 2 + 3).fill(123);
  const writing = channel.write(bytes);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 0);
  for (let count = 1; count <= 3; count++) {
    channel.credit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, count);
  }
  await writing;
  assert.deepEqual(messages.map(message => message.chunk.byteLength), [APP_STREAM_CHUNK_BYTES, APP_STREAM_CHUNK_BYTES, 3]);
  assert.equal(new Uint8Array(messages[2].chunk)[2], 123);
  const blocked = channel.write(bytes);
  channel.cancel();
  await assert.rejects(blocked, /cancelled/);
});

test('a completed small Flight payload transfers with its headers using one bounded initial credit', async () => {
  const messages = [];
  const channel = workerStreamChannel({ postMessage(message, transfer) { messages.push(structuredClone(message, { transfer })); } }, 2);
  const bytes = new Uint8Array([1, 2, 3]);
  channel.start({ status: 200 });
  await channel.write(bytes, undefined, true);
  channel.end();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'start');
  assert.equal(messages[0].status, 200);
  assert.equal(messages[0].done, true);
  assert.deepEqual([...new Uint8Array(messages[0].chunk)], [1, 2, 3]);
  assert.equal(bytes.buffer.byteLength, 0, 'the owned allocation is transferred rather than copied');

  const pooled = Buffer.from([4, 5, 6]);
  const other = workerStreamChannel({ postMessage(message, transfer) { messages.push(structuredClone(message, { transfer })); } }, 3);
  other.start({ status: 200 });
  await other.write(pooled, undefined, true);
  assert.deepEqual([...pooled], [4, 5, 6], 'Node pooled Buffer ownership stays with its producer');
  assert.equal(messages[1].chunk.byteLength, 3);
});

test('progressive HTML sends Suspense shell and async bootstrap before its deferred content', async () => {
  const options = await fixture();
  const response = await renderAppPage({ ...options, stream: true });
  assert.equal(response.status, 200);
  const iterator = response.body[Symbol.asyncIterator]();
  const first = (await iterator.next()).value.toString();
  assert.match(first, /Loading shell/);
  assert.doesNotMatch(first, /Delayed content/);
  assert.match(first, /type="module" src="\/client.js" async=""/);
  let html = first;
  for (;;) { const next = await iterator.next(); if (next.done) break; html += next.value.toString(); }
  assert.match(html, /Delayed content/);
  assert.match(html, /__PRNEXT_FLIGHT_STREAM__.*push/);
  assert.ok(html.endsWith('</body></html>'));
  const payload = [...html.matchAll(/\.push\("([A-Za-z\d+/=]+)"\)/g)].map(match => Buffer.from(match[1], 'base64'));
  const model = await decodeFlight(Buffer.concat(payload), {}, options.distDir);
  assert.equal(model.router.pathname, '/slow');
});

for (const stream of [false, true]) {
  test(`an immediate server error inside a valid Suspense shell retains HTTP 200 (${stream ? 'streamed' : 'buffered'})`, async () => {
    const options = await fixture(`throw new Error('PRIVATE_IMMEDIATE_SERVER_FAILURE')`);
    const response = await renderAppPage({ ...options, stream });
    let html = '';
    if (stream) { for await (const chunk of response.body) html += chunk; }
    else html = response.body.toString();
    assert.equal(response.status, 200);
    assert.match(html, /Loading shell/);
    assert.doesNotMatch(html, /__prnext_error__|PRIVATE_IMMEDIATE_SERVER_FAILURE/);
    assert.ok(html.endsWith('</body></html>'));
  });
}

test('progressive Flight is readable before its async page resolves and cancelled readers release the worker', async () => {
  const options = await fixture();
  const response = await renderFlight({ ...options, stream: true });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value.byteLength > 0);
  assert.doesNotMatch(Buffer.from(first.value).toString(), /Delayed content/);
  await reader.cancel();
  const next = await renderAppPage({ ...await fixture(`return React.createElement('p',null,'Healthy after cancellation')`), stream: true });
  let html = '';
  for await (const chunk of next.body) html += chunk;
  assert.match(html, /Healthy after cancellation/);
});

test('streaming validates root document and preserves redirects before committing headers', async () => {
  const options = await fixture(`throw Object.assign(new Error('redirect'),{digest:'NEXT_REDIRECT;replace;/target;307;'})`);
  const response = await renderAppPage({ ...options, stream: true });
  assert.equal(response.status, 307);
  assert.equal(response.headers.location, '/target');
  const invalid = await fixture(`return React.createElement('p',null,'invalid')`);
  await writeFile(invalid.modulePath, `import React from 'react';export const page={default:()=>React.createElement('p',null,'invalid')};export const segments=[];`);
  await assert.rejects(renderAppPage({ ...invalid, stream: true }), /root layout must render/);
});

test('soft deadlines wake a Flight writer blocked on credit, and HEAD cancels suspended work', async () => {
  const options = await fixture();
  const response = await renderFlight({ ...options, stream: true }, { softTimeoutMs: 40, hardTimeoutMs: 1000 });
  // Do not grant any credit: the deadline must not depend on another pull.
  await new Promise(resolve => setTimeout(resolve, 90));
  await assert.rejects(response.body.getReader().read(), error => error.statusCode === 504);
  const head = await renderAppPage({ ...await fixture(), stream: true, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.byteLength, 0);
});

test('an oversized SSR raw-text element is bounded before its closing tag arrives', async () => {
  const options = await fixture();
  await writeFile(path.join(options.distDir, 'huge.mjs'), `import React from 'react';export default function Huge(){return React.createElement('script',{dangerouslySetInnerHTML:{__html:'x'.repeat(17*1024*1024)}})}`);
  await writeFile(options.modulePath, `import React from 'react';import {registerClientReference} from 'react-server-dom-webpack/server.node';
    const Huge=registerClientReference(()=>{},'huge','default');export const page={default:()=>React.createElement(Huge)};
    export const segments=[{layout:{default:({children})=>React.createElement('html',null,React.createElement('head'),React.createElement('body',null,children))}}];`);
  const manifest = { app: { clientModules: { huge: { ssrModule: 'huge.mjs', browserModule: '/huge.js' } } } };
  await assert.rejects(async () => {
    const response = await renderAppPage({ ...options, manifest, stream: true });
    for await (const _ of response.body) { /* Drain only until the bound rejects. */ }
  }, /16 MiB/);
});
