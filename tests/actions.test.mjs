import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appFixture, startServer, repositoryRoot } from './support.mjs';

let fixture, server, manifest, actionId;
before(async () => {
  fixture = await appFixture();
  await rm(path.join(fixture.root, 'app'), { recursive: true });
  await mkdir(path.join(fixture.root, 'app'));
  await writeFile(path.join(fixture.root, 'app/layout.tsx'), `export default function Layout({children}){return <html><body>{children}</body></html>}`);
  await writeFile(path.join(fixture.root, 'app/actions.ts'), `'use server';
    import {appendFileSync} from 'node:fs';
    import {cookies} from 'next/headers';
    import {redirect} from 'next/navigation';
    export async function mutate(input) {
      const value = input instanceof FormData ? input.get('value') : input?.value;
      if (typeof value !== 'string') throw new Error('Invalid value');
      if (value === 'throw') throw new Error('RUSTYX_PRIVATE_ACTION_ERROR');
      appendFileSync('.action-invocations', JSON.stringify(value)+'\\n');
      (await cookies()).set('action-value', value, {httpOnly:true,sameSite:'lax'});
      if (value === 'redirect') redirect('/?redirected=1');
      return {value, at:new Date('2026-01-02T03:04:05.000Z'), tags:new Map([['framework','rustyx']])};
    }`);
  await writeFile(path.join(fixture.root, 'app/page.tsx'), `import {cookies} from 'next/headers';import {mutate} from './actions';
    export default async function Page(){const value=(await cookies()).get('action-value')?.value||'initial';return <><h1>Action fixture</h1><p data-testid="value">{value}</p><form action={mutate}><input name="value" defaultValue="form"/><button>Save</button></form></>}`);
  await mkdir(path.join(fixture.root, 'app/stream'));
  await writeFile(path.join(fixture.root, 'app/stream/page.tsx'), `import {Suspense} from 'react';import{cookies}from'next/headers';
    async function Slow(){const value=(await cookies()).get('action-value')?.value;await new Promise(resolve=>setTimeout(resolve,1200));return <p>stream-complete-{value}</p>}
    export default function Page(){return <main><h1>Action stream shell</h1><Suspense fallback={<p>waiting</p>}><Slow/></Suspense></main>}`);
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root]);
  manifest = JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
  const ids = Object.keys(manifest.app.actions);
  assert.equal(ids.length, 1);
  [actionId] = ids;
  server = await startServer(fixture.root);
});
after(async () => { await server?.close(); await fixture?.remove(); });

const actionHeaders = () => ({ 'Next-Action': actionId, 'content-type': 'text/plain;charset=UTF-8', origin: server.url });
async function invocations() {
  try { return (await readFile(path.join(fixture.root, '.action-invocations'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('POST invokes an allowlisted Server Action once, sets cookies and returns updated Flight', async () => {
  const response = await fetch(server.url, { method: 'POST', headers: actionHeaders(), body: JSON.stringify([{ value: 'rpc' }]) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type'), /^text\/x-component/);
  assert.match(response.headers.getSetCookie().join(';'), /action-value=rpc.*HttpOnly/);
  const flight = await response.text();
  assert.match(flight, /"actionResult"/);
  assert.match(flight, /rpc/);
  assert.match(flight, /2026-01-02T03:04:05/);
  assert.match(flight, /rustyx/);
  assert.equal((await invocations()).filter(value => value === 'rpc').length, 1);
});

test('action Flight sends its shell before slow components and commits the mutation exactly once', async () => {
  const response = await fetch(server.url + '/stream', { method: 'POST', headers: actionHeaders(), body: JSON.stringify([{ value: 'streamed' }]) });
  assert.equal(response.status, 200);
  assert.match(response.headers.getSetCookie().join(';'), /action-value=streamed/);
  const reader = response.body.getReader();
  const first = await reader.read();
  let text = Buffer.from(first.value).toString();
  assert.ok(text.includes('Action stream shell'), text);
  assert.ok(!text.includes('stream-complete-'), 'slow component must remain pending when the shell arrives');
  for (;;) { const next = await reader.read(); if (next.done) break; text += Buffer.from(next.value).toString(); }
  assert.match(text, /stream-complete-/); assert.match(text, /streamed/);
  assert.equal((await invocations()).filter(value => value === 'streamed').length, 1);
});

test('native form posts work without JavaScript and use 303 for redirect after a mutation', async () => {
  const html = await (await fetch(server.url)).text();
  assert.ok(html.includes(`$ACTION_ID_${actionId}`), 'SSR emits the official progressive form action name');
  for (const multipart of [false, true]) {
    const data = multipart ? new FormData() : new URLSearchParams();
    data.set(`$ACTION_ID_${actionId}`, '');
    data.set('value', multipart ? 'multipart' : 'urlencoded');
    const response = await fetch(server.url, { method: 'POST', headers: { origin: server.url }, body: data });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), new RegExp(`data-testid="value">${multipart ? 'multipart' : 'urlencoded'}<`));
  }
  const data = new FormData();
  data.set(`$ACTION_ID_${actionId}`, ''); data.set('value', 'redirect');
  const response = await fetch(server.url, { method: 'POST', headers: { origin: server.url }, body: data, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?redirected=1');
  assert.match(response.headers.getSetCookie().join(';'), /action-value=redirect/);
  assert.equal((await invocations()).filter(value => value === 'redirect').length, 1);
});

test('cross-origin, forged IDs, malformed bodies and oversized actions fail before mutation', async () => {
  const before = await invocations();
  for (const origin of ['https://attacker.invalid', 'null', `${server.url}/not-an-origin`]) {
    const response = await fetch(server.url, { method: 'POST', headers: { ...actionHeaders(), origin }, body: '[{"value":"forbidden"}]' });
    assert.equal(response.status, 403);
  }
  for (const id of ['not-built', '__proto__', 'constructor', 'toString']) {
    const response = await fetch(server.url, { method: 'POST', headers: { ...actionHeaders(), 'Next-Action': id }, body: '[{"value":"forged"}]' });
    assert.equal(response.status, 404);
  }
  const invalid = await fetch(server.url, { method: 'POST', headers: actionHeaders(), body: 'not valid JSON' });
  assert.equal(invalid.status, 400);
  const tooLarge = await fetch(server.url, { method: 'POST', headers: actionHeaders(), body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(tooLarge.status, 413);
  const get = await fetch(server.url, { headers: { 'Next-Action': actionId } });
  assert.equal(get.status, 200);
  const put = await fetch(server.url, { method: 'PUT', headers: actionHeaders(), body: '[]' });
  assert.equal(put.status, 405);
  assert.deepEqual(await invocations(), before);
});

test('action errors hide server details and leave the worker usable', async () => {
  const response = await fetch(server.url, { method: 'POST', headers: actionHeaders(), body: '[{"value":"throw"}]' });
  const body = await response.text();
  assert.ok(!body.includes('RUSTYX_PRIVATE_ACTION_ERROR'));
  assert.match(body, /actionError/);
  assert.equal((await fetch(server.url)).status, 200);
});

test('deployed action manifests work with only build artifacts and installed dependencies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rustyx-actions-deployed-'));
  let deployed;
  try {
    for (const name of ['.rustyx', 'node_modules', 'package.json']) await cp(path.join(fixture.root, name), path.join(directory, name), { recursive: true });
    deployed = await startServer(directory);
    const response = await fetch(deployed.url, { method: 'POST', headers: { ...actionHeaders(), origin: deployed.url }, body: '[{"value":"relocated"}]' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /relocated/);
    assert.deepEqual((await readFile(path.join(directory, '.action-invocations'), 'utf8')).trim(), '"relocated"');
  } finally { await deployed?.close(); await rm(directory, { recursive: true, force: true }); }
});
