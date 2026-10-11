// Functional compatibility control, not a load generator. Uses a disposable
// copy of a frozen build and never modifies the original application or build.
// node static-mutations-v5.mjs BINARY FROZEN_BUILD OUTPUT_DIRECTORY [PORT]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm, rename, symlink, stat, utimes } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const [binaryArg, buildArg, outputArg, portArg = '32990'] = process.argv.slice(2);
assert.ok(binaryArg && buildArg && outputArg, 'BINARY FROZEN_BUILD OUTPUT_DIRECTORY [PORT] required');
const binary = path.resolve(binaryArg), build = path.resolve(buildArg), output = path.resolve(outputArg);
const port = Number(portArg), project = path.join(output, 'project'), dist = path.join(project, '.prnext');
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
const hash = data => createHash('sha256').update(data).digest('hex');
const evidence = { complete: false, node: process.version, platform: process.platform, binary,
  binarySha256: hash(await readFile(binary)), originalBuild: build,
  originalManifestSha256: hash(await readFile(path.join(build, 'manifest.json'))),
  port, startedAt: new Date().toISOString(), checks: [], skipped: [] };
await mkdir(output, { recursive: false });
await mkdir(project);
await cp(build, dist, { recursive: true });
const publicRoot = path.join(project, 'public'), outside = path.join(project, 'public-secret');
await mkdir(publicRoot); await mkdir(outside);
await writeFile(path.join(publicRoot, 'robots.txt'), 'v5 functional readiness');
await writeFile(path.join(outside, 'secret.txt'), 'PRIVATE-SHOULD-NEVER-BE-SERVED');
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
const page = manifest.prerendered.find(row => row.path === '/pages-static');
assert.ok(page, 'frozen build must contain /pages-static');
const originalHtml = await readFile(path.join(dist, page.file));
const args = ['start', project, '--node', process.execPath, '--hostname', '127.0.0.1', '--port', String(port)];
evidence.command = [binary, ...args];
const child = spawn(binary, args, { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', childError;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.on('error', error => { childError = error; });
function request(route, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'accept-encoding': 'identity', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('request timeout'))); req.end();
  });
}
async function check(name, run) { await run(); evidence.checks.push(name); }
async function expect(route, value, status = 200, method = 'GET', headers = {}) {
  const response = await request(route, method, headers);
  assert.equal(response.status, status, route);
  if (value !== null) assert.deepEqual(response.bytes, Buffer.from(value), route);
  assert.ok(!response.bytes.includes(Buffer.from('PRIVATE-SHOULD-NEVER-BE-SERVED')), route);
  return response;
}
async function link(target, destination, type) {
  try { await symlink(target, destination, type); return true; }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error;
    evidence.skipped.push({ case: path.basename(destination), reason: error.code }); return false;
  }
}
try {
  for (let i = 0; ; i++) {
    if (childError) throw childError;
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { await expect('/robots.txt', 'v5 functional readiness'); break; }
    catch (error) { if (i >= 100) throw error; await delay(50); }
  }
  await check('existing static route retains original bytes', () => expect('/pages-static', originalHtml));
  await check('public create after repeated miss is visible immediately', async () => {
    await expect('/created.txt', null, 404); await expect('/created.txt', null, 404);
    await writeFile(path.join(publicRoot, 'created.txt'), 'created live');
    await expect('/created.txt', 'created live');
  });
  await check('nested public creation after miss is visible without root-directory change', async () => {
    const folder = path.join(publicRoot, 'nested'); await mkdir(folder);
    await expect('/nested/new.txt', null, 404);
    await writeFile(path.join(folder, 'new.txt'), 'nested live'); await expect('/nested/new.txt', 'nested live');
  });
  await check('public file overrides GET and HEAD on an existing page, deletion restores it', async () => {
    const filename = path.join(publicRoot, 'pages-static'); await writeFile(filename, 'public override');
    await expect('/pages-static', 'public override');
    const head = await expect('/pages-static', '', 200, 'HEAD'); assert.equal(head.headers['content-length'], '15');
    await expect('/pages-static', null, 405, 'POST');
    await rm(filename); await expect('/pages-static', originalHtml);
  });
  await check('public same-length edit with restored mtime, rename and deletion remain visible', async () => {
    const filename = path.join(publicRoot, 'mutable.txt'); await writeFile(filename, 'first');
    const before = await stat(filename); await expect('/mutable.txt', 'first');
    await writeFile(filename, 'other'); await utimes(filename, before.atime, before.mtime); await expect('/mutable.txt', 'other');
    await writeFile(filename + '.new', 'renamed'); await rm(filename); await rename(filename + '.new', filename);
    await expect('/mutable.txt', 'renamed'); await rm(filename); await expect('/mutable.txt', null, 404);
  });
  await check('directory replaced with a file is served, file replaced with directory is not', async () => {
    const filename = path.join(publicRoot, 'switch'); await mkdir(filename); await expect('/switch', null, 404);
    await rm(filename, { recursive: true }); await writeFile(filename, 'now a file'); await expect('/switch', 'now a file');
    await rm(filename); await mkdir(filename); await expect('/switch', null, 404);
  });
  const inside = path.join(publicRoot, 'inside'), linked = path.join(publicRoot, 'linked');
  await mkdir(inside); await writeFile(path.join(inside, 'secret.txt'), 'safe internal target');
  if (await link(inside, linked, process.platform === 'win32' ? 'junction' : 'dir')) {
    await check('internal directory link works; retarget outside root is rejected; restoring works', async () => {
      await expect('/linked/secret.txt', 'safe internal target'); await rm(linked);
      await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
      await expect('/linked/secret.txt', null, 404); await rm(linked);
      await symlink(inside, linked, process.platform === 'win32' ? 'junction' : 'dir'); await expect('/linked/secret.txt', 'safe internal target');
    });
  }
  const fileLink = path.join(publicRoot, 'file-link.txt');
  if (await link(path.join(outside, 'secret.txt'), fileLink, 'file')) {
    await check('external file symlink is rejected', () => expect('/file-link.txt', null, 404));
  }
  await check('encoded traversal and separators never reach private sibling', async () => {
    for (const route of ['/%2e%2e/public-secret/secret.txt', '/linked%2fsecret.txt', '/linked%5csecret.txt', '/%00']) {
      await expect(route, null, 400);
    }
  });
  const asset = path.join(dist, 'assets', 'v5-mutable.txt'), route = '/_prnext/assets/v5-mutable.txt';
  const first = Buffer.from('first built representation '.repeat(100)), second = Buffer.from('other built representation '.repeat(100));
  const stamp = new Date('2025-01-01T00:00:00.000Z');
  await writeFile(asset, first); await writeFile(asset + '.gz', gzipSync(first));
  await utimes(asset, stamp, stamp); await utimes(asset + '.gz', stamp, stamp);
  await check('built GET/HEAD reuse exact gzip bytes and preserve HTTP conditions', async () => {
    const wire = await readFile(asset + '.gz');
    const compressed = await expect(route, wire, 200, 'GET', { 'accept-encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    const head = await expect(route, '', 200, 'HEAD', { 'accept-encoding': 'gzip' }); assert.equal(Number(head.headers['content-length']), wire.length);
    await expect(route, first, 200, 'GET', { 'accept-encoding': 'gzip;q=0, identity;q=1' });
    await expect(route, first.subarray(0, 16), 206, 'GET', { range: 'bytes=0-15' });
    await expect(route, first, 200, 'GET', { range: 'bytes=0-15', 'if-range': '"not-current"' });
    const identity = await expect(route, first); await expect(route, '', 304, 'GET', { 'if-modified-since': identity.headers['last-modified'] });
  });
  await check('built identity edit invalidates stale gzip immediately', async () => {
    await writeFile(asset, second); const changed = new Date('2025-01-02T00:00:00.000Z'); await utimes(asset, changed, changed);
    await expect(route, second);
    const response = await request(route, 'GET', { 'accept-encoding': 'gzip' }); assert.equal(response.status, 200);
    assert.deepEqual(response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.bytes) : response.bytes, second);
  });
  const unsafeGzip = path.join(outside, 'outside.gz'); await writeFile(unsafeGzip, gzipSync(Buffer.from('PRIVATE-SHOULD-NEVER-BE-SERVED')));
  await rm(asset + '.gz');
  if (await link(unsafeGzip, asset + '.gz', 'file')) {
    await check('external gzip sidecar is rejected even with matching timestamps', async () => {
      const current = await stat(asset); await utimes(unsafeGzip, current.atime, current.mtime);
      const response = await request(route, 'GET', { 'accept-encoding': 'gzip' }); assert.equal(response.status, 200);
      assert.deepEqual(response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.bytes) : response.bytes, second);
    });
  }
  await check('built file deletion is visible after prior gzip and identity hits', async () => {
    await rm(asset); await expect(route, null, 404);
  });
  evidence.complete = true;
} catch (error) { evidence.error = error.stack || String(error); process.exitCode = 1; }
finally {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { child.once('close', resolve); child.kill(); });
  }
  evidence.finishedAt = new Date().toISOString(); evidence.serverExitCode = child.exitCode; evidence.serverSignal = child.signalCode;
  await writeFile(path.join(output, 'server.stdout.log'), stdout); await writeFile(path.join(output, 'server.stderr.log'), stderr);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ complete: evidence.complete, checks: evidence.checks.length, skipped: evidence.skipped, error: evidence.error }));
}
