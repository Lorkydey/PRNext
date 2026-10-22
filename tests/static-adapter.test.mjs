import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStatic } from '../packages/prnext/build/static-adapter.mjs';
import { binary, repositoryRoot, startServer } from './support.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-static-native-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const put = async (file, contents) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), contents); };
  await put('dist/index.html', '<!doctype html><h1>Vite-shaped static output</h1>');
  await put('dist/docs/index.html', '<!doctype html><h1>Documentation</h1>');
  await put('dist/assets/app.js', 'window.staticAdapter=true;');
  await put('dist/data.json', '{"ok":true}');
  await put('public/outside.txt', 'MUST NOT BE SERVED');
  await put('dist/file with space.txt', 'space');
  return { root, put };
}

test('native static server serves imported routes, HTTP semantics and zero Node workers', async t => {
  const { root } = await fixture(t);
  await buildStatic(root);
  const server = await startServer(root, ['--node', path.join(root, 'no-node-executable')]);
  t.after(server.close);
  assert.match(await fetch(server.url).then(r => r.text()), /Vite-shaped/);
  assert.match(await fetch(server.url + '/docs').then(r => r.text()), /Documentation/);
  assert.equal(await fetch(server.url + '/file%20with%20space.txt').then(r => r.text()), 'space');
  const asset = await fetch(server.url + '/assets/app.js');
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal(await asset.text(), 'window.staticAdapter=true;');
  assert.ok(asset.headers.get('last-modified'));
  assert.equal((await fetch(server.url + '/assets/app.js', { headers: { 'If-Modified-Since': asset.headers.get('last-modified') } })).status, 304);
  const head = await fetch(server.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const range = await fetch(server.url + '/assets/app.js', { headers: { Range: 'bytes=0-5' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), 'window');
  assert.equal((await fetch(server.url + '/data.json').then(r => r.json())).ok, true);
  for (const url of ['/missing', '/outside.txt', '/build-output.json', '/manifest.json', '/_prnext/image?url=/outside.txt&w=32&q=75']) assert.equal((await fetch(server.url + url)).status, 404, url);
  assert.notEqual((await fetch(server.url, { method: 'POST' })).status, 200);
  const traversal = await fetch(server.url + '/%2e%2e%2foutside.txt'); assert.notEqual(traversal.status, 200);
  assert.doesNotMatch(server.output(), /spawn|worker.*error|ENOENT/i);
});

test('CLI builds package-free HTML and CSS with no flags and native requests keep private files inaccessible',async t=>{
  const {root,put}=await fixture(t),cli=path.join(repositoryRoot,'packages/prnext/cli.mjs');
  await put('index.html','<!doctype html><link rel="stylesheet" href="/style.css"><h1>Plain site</h1>');
  await put('style.css','h1{color:rebeccapurple}');await put('server.js','SECRET');await put('credentials.json','SECRET');
  await run(process.execPath,[cli,'build',root]);
  const server=await startServer(root,['--node',path.join(root,'no-node')]);t.after(server.close);
  assert.match(await fetch(server.url).then(r=>r.text()),/Plain site/);
  const css=await fetch(server.url+'/style.css');assert.match(css.headers.get('content-type'),/text\/css/);assert.match(await css.text(),/rebeccapurple/);
  for(const file of ['server.js','credentials.json','package.json'])assert.equal((await fetch(server.url+'/'+file)).status,404,file);
});

test('imported gzip files are negotiated by the native server with correct bodies and ranges', async t => {
  const {root,put}=await fixture(t), text='const staticText="compress me";\n'.repeat(2000);
  await put('dist/assets/large.js',text);await buildStatic(root);
  const server=await startServer(root,['--node',path.join(root,'no-node')]);t.after(server.close);
  const encoded=await fetch(server.url+'/assets/large.js',{headers:{'accept-encoding':'gzip'}});
  assert.equal(encoded.headers.get('content-encoding'),'gzip');assert.match(encoded.headers.get('vary'),/accept-encoding/i);assert.equal(await encoded.text(),text);
  const plain=await fetch(server.url+'/assets/large.js',{headers:{'accept-encoding':'identity'}});assert.equal(plain.headers.get('content-encoding'),null);assert.equal(await plain.text(),text);
  const range=await fetch(server.url+'/assets/large.js',{headers:{'accept-encoding':'identity',range:'bytes=0-4'}});assert.equal(range.status,206);assert.equal(await range.text(),text.slice(0,5));
});

test('SPA fallback is opt-in and only applies to HTML navigation, never missing files or APIs', async t => {
  const { root } = await fixture(t);
  await buildStatic(root, { spa: true });
  const server = await startServer(root, ['--node', path.join(root, 'no-node-executable')]); t.after(server.close);
  for (const url of ['/dashboard', '/account/profile?tab=details']) {
    const response = await fetch(server.url + url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    assert.equal(response.status, 200); assert.match(await response.text(), /Vite-shaped/);
  }
  for (const [url, accept] of [['/missing.js', 'text/html'], ['/api/users', 'text/html'], ['/.env', 'text/html'], ['/_next/unknown', 'text/html'], ['/missing', 'application/json'], ['/missing', '*/*'], ['/missing', 'text/html;q=0']]) assert.equal((await fetch(server.url + url, { headers: { Accept: accept } })).status, 404, url + ' ' + accept);
  const docs = await fetch(server.url + '/docs', { headers: { Accept: 'text/html' } }); assert.match(await docs.text(), /Documentation/);
});

test('CLI imports and inspects output; future, missing and inconsistent contracts cannot start', async t => {
  const { root } = await fixture(t), cli = path.join(repositoryRoot, 'packages/prnext/cli.mjs');
  await run(process.execPath, [cli, 'build', root, '--adapter', 'static', '--from', 'dist', '--spa']);
  const output = JSON.parse((await run(process.execPath, [cli, 'output', root, '--json'])).stdout);
  assert.equal(output.version, 1); assert.equal(output.adapter, 'static'); assert.equal(output.fallback, 'index.html');
  for (const args of [['--adapter', 'unknown'], ['--from'], ['--adapter', 'static', '--dev'], ['--adapter', 'react', '--spa']]) await assert.rejects(run(process.execPath, [cli, 'build', root, ...args]));
  const file = path.join(root, '.prnext/build-output.json');
  for (const value of [{ ...output, version: 99 }, { ...output, adapter: 'react' }, { ...output, buildId: 'stale' }, { ...output, assets: '../secret' }]) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(startServer(root), /build output|entrypoints|adapter/);
  }
  await rm(file); await assert.rejects(startServer(root), /build output contract/);
});

test('native host validates, wakes and sleeps static builds without Node installed', { timeout: 30000 }, async t => {
  const { root, put } = await fixture(t);
  await buildStatic(root);
  const config = path.join(root, 'host.json');
  await put('host.json', JSON.stringify({ port: 0, memoryMb: 128, apps: [{ name: 'static', root, hosts: ['static.localhost'], memoryMb: 64, idleSeconds: 1 }] }));
  const result = await run(binary, ['host', config, '--node', path.join(root, 'no-node-executable'), '--check']);
  assert.match(result.stdout, /valid|checked|static|ready/i);
  const child = spawn(binary, ['host', config, '--node', path.join(root, 'no-node-executable'), '--shutdown-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', error;
  child.on('error', value => { error = value; });
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
  });
  async function until(check) {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (error) throw error;
      if (child.exitCode !== null) assert.fail(output);
      const value = await check(); if (value) return value;
      await delay(50);
    }
    assert.fail('Static host did not reach expected state: ' + output);
  }
  const base = await until(() => /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]);
  const snapshot = async () => JSON.parse(await readFile(path.join(root, 'host.status.json'), 'utf8').catch(() => '{"apps":[]}'));
  const get = (host = 'static.localhost') => new Promise((resolve, reject) => {
    const request = http.get(base + '/', { headers: { host }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('Static host request timed out')));
  });
  for (let cycle = 0; cycle < 2; cycle++) {
    await until(async () => (await snapshot()).apps[0]?.pid === null);
    const responses = await Promise.all(Array.from({ length: 12 }, () => get()));
    for (const response of responses) { assert.equal(response.status, 200); assert.match(response.text, /Vite-shaped/); }
    await until(async () => (await snapshot()).apps[0]?.starts === cycle + 1);
  }
  assert.equal((await get('other.localhost')).status, 421);
});
