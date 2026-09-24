import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appFixture, startServer, repositoryRoot } from './support.mjs';

let fixture, server;
before(async () => {
  fixture = await appFixture();
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root]);
  server = await startServer(fixture.root, ['--workers', '2']);
});
after(async () => { await server?.close(); await fixture?.remove(); });

test('async App Server Components SSR with client references, cookies and private server imports', async () => {
  const response = await fetch(server.url, { headers: { 'x-example': 'from-request', cookie: 'theme=light' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('vary'), /RSC/);
  const html = await response.text();
  assert.match(html, /Server power/);
  assert.match(html, /from-request/);
  assert.match(html, />light</);
  assert.match(html, /__RUSTYX_FLIGHT_STREAM__\.push\(null\)/);
  const flightChunks=[...html.matchAll(/__RUSTYX_FLIGHT_STREAM__\|\|=\[\]\)\.push\("([A-Za-z0-9+/=]+)"\)/g)];
  assert.ok(flightChunks.length,'the document embeds its progressive Flight payload');
  const flight=Buffer.concat(flightChunks.map(match=>Buffer.from(match[1],'base64'))).toString();
  assert.match(flight, /"tree"/);
  assert.match(flight, /from-request/);
  assert.ok(!flight.includes('RUSTYX_APP_SERVER_ONLY_SENTINEL'));
  assert.match(html, /Page count/);
  assert.ok(!html.includes('RUSTYX_APP_SERVER_ONLY_SENTINEL'));
  for (const name of await readdir(path.join(fixture.root, '.rustyx/assets'))) {
    if (!/\.(js|map)$/.test(name)) continue;
    const asset = await readFile(path.join(fixture.root, '.rustyx/assets', name), 'utf8');
    assert.ok(!asset.includes('RUSTYX_APP_SERVER_ONLY_SENTINEL'), name);
    assert.ok(!asset.includes('node:crypto'), name);
  }
});

test('RSC requests return the real Flight payload rather than a document', async () => {
  const response = await fetch(`${server.url}/items/alpha?tag=one&tag=two`, { headers: { RSC: '1' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/x-component/);
  const body = await response.text();
  assert.ok(!body.startsWith('<!DOCTYPE'));
  assert.match(body, /:I\[/);
  assert.match(body, /"tree"/);
  assert.match(body, /alpha/);
  assert.match(body, /one, two/);
  assert.ok(!body.includes('RUSTYX_APP_SERVER_ONLY_SENTINEL'));
});

test('route groups, dynamic params and nested layouts render through the Rust router', async () => {
  assert.equal((await fetch(`${server.url}/about`)).status, 200);
  const html = await (await fetch(`${server.url}/items/alpha?tag=one&tag=two`)).text();
  assert.match(html, /data-testid="nested-layout"/);
  assert.match(html, /one, two/);
  assert.equal((await fetch(`${server.url}/_private`)).status, 404);
  assert.equal((await fetch(`${server.url}/(marketing)/about`)).status, 404);
  assert.match(await (await fetch(`${server.url}/legacy`)).text(), /Pages Router still works/);
});

test('App route handlers implement NextRequest, NextResponse and mutable cookie context', async () => {
  const get = await fetch(`${server.url}/api/echo?name=Thomas`, { headers: { 'x-example': 'header', cookie: 'theme=light' } });
  assert.deepEqual(await get.json(), { framework: 'rustyx', name: 'Thomas', header: 'header', theme: 'light' });
  assert.match(get.headers.getSetCookie().join(';'), /visited=1/);
  const post = await fetch(`${server.url}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"value":42}' });
  assert.equal(post.status, 201);
  assert.deepEqual(await post.json(), { received: { value: 42 } });
  assert.match(post.headers.getSetCookie().join(';'), /theme=dark/);
  assert.equal((await fetch(`${server.url}/api/echo`, { method: 'OPTIONS' })).status, 204);
  const disallowed = await fetch(`${server.url}/api/echo`, { method: 'DELETE' });
  assert.equal(disallowed.status, 405);
  assert.deepEqual(new Set(disallowed.headers.get('allow').split(/,\s*/)), new Set(['GET', 'POST', 'HEAD', 'OPTIONS']));
});

test('server redirects and nearest not-found conventions preserve HTTP semantics', async () => {
  const redirect = await fetch(`${server.url}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), '/about');
  for (const headers of [{}, { RSC: '1' }]) {
    const missing = await fetch(`${server.url}/items/missing`, { headers });
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Item not found/);
  }
});

test('concurrent RSC contexts do not leak headers or cookies between requests', async () => {
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const marker = `visitor_${index}_unique`;
    const response = await fetch(server.url, { headers: { 'x-example': marker, cookie: `theme=${marker}` } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`data-testid="request-header">${marker}<`));
    assert.match(html, new RegExp(`data-testid="cookie-theme">${marker}<`));
  }));
});

test('RSC artifacts run after relocation with app dependencies and no source tree', async () => {
  const deployed = await mkdtemp(path.join(tmpdir(), 'rustyx-app-deployment-'));
  let relocated;
  try {
    for (const entry of ['.rustyx', 'node_modules', 'package.json']) await cp(path.join(fixture.root, entry), path.join(deployed, entry), { recursive: true });
    relocated = await startServer(deployed);
    const response = await fetch(relocated.url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /Server power/);
  } finally { await relocated?.close(); await rm(deployed, { recursive: true, force: true }); }
});
