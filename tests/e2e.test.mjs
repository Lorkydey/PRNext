import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, mkdir, rm, readdir, readFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { startServer, repositoryRoot } from './support.mjs';

let root;
let server;
before(async () => {
  root = await mkdtemp(path.join(repositoryRoot, '.prnext-test-'));
  await cp(path.join(repositoryRoot, 'examples/basic'), root, { recursive: true, filter: source => !source.includes('.prnext') && !source.includes('node_modules') });
  await writeFile(path.join(root, '.env'), 'SECRET=do-not-serve-this-fixture-secret');
  await symlink(path.join(root, '.env'), path.join(root, 'public/leak.txt'));
  await writeFile(path.join(root, 'pages/redirect.tsx'), `export function getServerSideProps() { return { redirect: { destination: '/server', permanent: false } }; } export default function Page() { return null; }`);
  await writeFile(path.join(root, 'pages/gone.tsx'), `export function getServerSideProps() { return { notFound: true }; } export default function Page() { return null; }`);
  await writeFile(path.join(root, 'pages/escape.tsx'), `export function getServerSideProps() { return { props: { value: '</script><script>window.pwned=true</script>' } }; } export default function Page({value}) { return <p>{value}</p>; }`);
  await writeFile(path.join(root, 'pages/api/crash.ts'), `export default function handler() { process.exit(42); }`);
  await writeFile(path.join(root, 'pages/api/log.ts'), `export default function handler(req, res) { console.log('application log'); res.json({ok:true}); }`);
  await writeFile(path.join(root, 'pages/api/private-error.ts'), `export default function handler() { throw new Error('private_database_password'); }`);
  await writeFile(path.join(root, 'pages/api/binary.ts'), `export default function handler(req, res) { res.setHeader('Content-Type','application/octet-stream'); res.send(Buffer.from([0,255,1,128])); }`);
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', root], { timeout: 60000 });
  server = await startServer(root, ['--workers', '2']);
}, { timeout: 90000 });
after(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test('static HTML, Head and content-hashed browser assets are served', async () => {
  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /PRNext — Rust meets React/);
  assert.match(html, /id="__prnext"/);
  const scripts = [...html.matchAll(/src="([^\"]+\.js)"/g)].map(match => match[1]);
  assert.ok(scripts.length);
  for (const script of scripts) { const asset = await fetch(new URL(script, server.url)); assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/); }
});
test('precompressed build HTML and assets negotiate gzip with exact lengths and HEAD semantics', async () => {
  const manifest=JSON.parse(await readFile(path.join(root,'.prnext/manifest.json'),'utf8'));
  const home=manifest.prerendered.find(page=>page.path==='/');
  const html=await readFile(path.join(root,'.prnext',home.file),'utf8');
  const asset=html.match(/src="([^\"]+\.js)"/)?.[1];
  assert.ok(asset);
  for(const [url,file]of [['/',home.file],[asset,'assets/'+path.basename(asset)]]) {
    const original=await readFile(path.join(root,'.prnext',file));
    const compressed=await readFile(path.join(root,'.prnext',file+'.gz'));
    assert.ok(compressed.length<original.length);
    const response=await fetch(new URL(url,server.url),{headers:{'accept-encoding':'gzip'}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-encoding'),'gzip');
    assert.equal(Number(response.headers.get('content-length')),compressed.length,'the stored gzip representation is served directly');
    assert.match(response.headers.get('vary'),/accept-encoding/i);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
    const identity=await fetch(new URL(url,server.url),{headers:{'accept-encoding':'gzip;q=0, identity'}});
    assert.equal(identity.headers.get('content-encoding'),null);
    assert.match(identity.headers.get('vary'),/accept-encoding/i);
    assert.deepEqual(Buffer.from(await identity.arrayBuffer()),original);
    const head=await fetch(new URL(url,server.url),{method:'HEAD',headers:{'accept-encoding':'gzip'}});
    assert.equal(head.status,200);
    assert.equal(head.headers.get('content-encoding'),'gzip');
    assert.equal(Number(head.headers.get('content-length')),compressed.length);
    assert.equal((await head.arrayBuffer()).byteLength,0);
  }
});
test('SSR receives query, uses Node crypto and preserves response headers', async () => {
  const response = await fetch(`${server.url}/server?name=Thomas`);
  assert.equal(response.headers.get('x-prnext-example'), 'server');
  assert.match(await response.text(), /Thomas/);
});
test('dynamic SSG and fallback:false', async () => {
  const response = await fetch(`${server.url}/blog/hello`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /hello/);
  assert.equal((await fetch(`${server.url}/blog/not-generated`)).status, 404);
});
test('optional catch-all params work with and without segments', async () => {
  assert.match(await (await fetch(`${server.url}/docs/routing/dynamic`)).text(), /routing \/ dynamic/);
  assert.match(await (await fetch(`${server.url}/docs`)).text(), /Index/);
});
test('npm API handlers support query, JSON body and status', async () => {
  const get = await fetch(`${server.url}/api/hello?name=Thomas`);
  assert.equal(get.headers.get('x-prnext-api'), 'npm');
  assert.deepEqual(await get.json(), { framework: 'prnext', hello: 'Thomas' });
  const post = await fetch(`${server.url}/api/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 42 }) });
  assert.equal(post.status, 201);
  assert.deepEqual(await post.json(), { received: { value: 42 } });
});
test('JSON decoding errors return 400', async () => {
  const response = await fetch(`${server.url}/api/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(response.status, 400);
});
test('multiple cookies and binary payloads survive IPC', async () => {
  const response = await fetch(`${server.url}/api/cookies`);
  assert.equal(response.headers.getSetCookie().length, 2);
  const binary = await fetch(`${server.url}/api/binary`);
  assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [0, 255, 1, 128]);
});
test('redirect, notFound, HEAD and missing routes', async () => {
  const redirect = await fetch(`${server.url}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), '/server');
  assert.equal((await fetch(`${server.url}/gone`)).status, 404);
  assert.equal((await fetch(`${server.url}/missing-route`)).status, 404);
  const head = await fetch(`${server.url}/server`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
test('HTML data escapes script termination and browser output excludes server code', async () => {
  const html = await (await fetch(`${server.url}/escape`)).text();
  assert.ok(!html.includes('</script><script>window.pwned=true</script>'));
  const assets = path.join(root, '.prnext/assets');
  for (const entry of await readdir(assets)) {
    if (/\.(js|map)$/.test(entry)) assert.ok(!(await readFile(path.join(assets, entry), 'utf8')).includes('PRNEXT_SERVER_ONLY_SENTINEL'), `Server code leaked to ${entry}`);
  }
});
test('private files, build internals and public symlink escapes are not exposed', async () => {
  for (const route of ['/.env', '/_prnext/manifest.json', '/_prnext/server/index.cjs', '/leak.txt', '/%2e%2e/.env']) {
    const response = await fetch(server.url + route);
    assert.ok(!(await response.text()).includes('do-not-serve-this-fixture-secret'), route);
    assert.notEqual(response.status, 200, route);
  }
});
test('console output cannot corrupt protocol and internal errors remain private', async () => {
  assert.deepEqual(await (await fetch(`${server.url}/api/log`)).json(), { ok: true });
  const response = await fetch(`${server.url}/api/private-error`);
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('private_database_password'));
});
test('a crashed npm worker is replaced for following requests', async () => {
  const crashed = await fetch(`${server.url}/api/crash`);
  assert.ok([500, 502, 503].includes(crashed.status));
  for (let i = 0; i < 4; i++) assert.equal((await fetch(`${server.url}/api/hello`)).status, 200);
});
test('concurrent SSR isolates query and head state', async () => {
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const response = await fetch(`${server.url}/server?name=visitor_${index}_unique`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(`visitor_${index}_unique`));
    assert.equal((html.match(/<title(?:\s[^>]*)?>/g) || []).length, 1);
  }));
});
