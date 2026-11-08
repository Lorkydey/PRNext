import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLocalArguments, collectSources, syncSnapshot, validationPlan, localEnvironment, mapBounded, runCommand, cloneDependencies, dependencyFingerprint, dependenciesReady, reserveLocalPorts } from './ci-local.mjs';
import { fastUnitFiles } from './ci-unit-fast.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-local-plan-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}
test('local plans retain full shard coverage, bounded jobs and distinct development feedback', () => {
  assert.equal(validationPlan('quick').length, 1);
  const full = validationPlan('full'); assert.equal(full.length, 10);
  for (const suite of ['integration', 'browser']) assert.deepEqual(full.filter(task => task.suite === suite).map(task => task.commands[0][5]), ['1/4', '2/4', '3/4', '4/4']);
  assert.equal(parseLocalArguments(['--mode', 'full', '--jobs', '4']).jobs, 4);
  for (const args of [['--jobs', '0'], ['--jobs', '5'], ['--jobs', '02'], ['--mode', 'other'], ['--list', '--list'], ['--root']]) assert.throws(() => parseLocalArguments(args));
});
test('local execution excludes account tokens and redirects config/state into owned directories', () => {
  const env = localEnvironment('workspace', 'cache', { PATH: 'tools', NPM_TOKEN: 'secret', NODE_AUTH_TOKEN: 'secret', STRIPE_SECRET_KEY: 'secret', GITHUB_TOKEN: 'secret', NODE_OPTIONS: '--import=untrusted', PRNEXT_PM_HOME: 'production' });
  for (const name of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'STRIPE_SECRET_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
  assert.equal(env.PRNEXT_PM_HOME, path.join('workspace', 'processes')); assert.equal(env.npm_config_userconfig, path.join('workspace', 'empty.npmrc'));
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join('cache', 'browsers'));
  assert.equal(localEnvironment('lane', 'cache', { PLAYWRIGHT_BROWSERS_PATH: '0' }).PLAYWRIGHT_BROWSERS_PATH, '0');
});

test('dependency reuse requires the matching resolution and installed package manifests', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.dependencies.json'), 'locked inputs');
  assert.equal(await dependenciesReady(root, 'locked inputs', ['react']), false);
  await mkdir(path.join(root, 'node_modules/react'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/react/package.json'), '{}');
  assert.equal(await dependenciesReady(root, 'locked inputs', ['react']), true);
  assert.equal(await dependenciesReady(root, 'changed inputs', ['react']), false);
  assert.equal(await dependenciesReady(root, 'locked inputs', ['react', 'redis']), false);
});
test('the fast file set includes new pure units while retaining the native dev scenario for full mode', async t => {
  const root = await fixture(t);
  for (const folder of ['packages/prnext/runtime', 'packages/prnext/native']) await mkdir(path.join(root, folder), { recursive: true });
  for (const file of ['runtime/new.test.mjs', 'runtime/dev-env.test.mjs', 'native/resolve.test.mjs']) await writeFile(path.join(root, 'packages/prnext', file), 'fixture');
  assert.deepEqual(await fastUnitFiles(root), ['packages/prnext/runtime/new.test.mjs', 'packages/prnext/native/resolve.test.mjs']);
  assert.ok(validationPlan('full')[0].commands.some(command => command.includes('test:unit')));
});
test('snapshot includes dirty code, excludes environment files and removes only stale managed files', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), destination = path.join(root, 'snapshot'); await mkdir(source);
  execFileSync('git', ['init', '-q'], { cwd: source, windowsHide: true });
  for (const [name, body] of Object.entries({ 'package.json': '{}', 'package-lock.json': '{}', 'dirty.mjs': 'changed code', '.env.local': 'never copy account secrets' })) await writeFile(path.join(source, name), body);
  const before = await collectSources(source); assert.ok(before.files.some(f => f.name === 'dirty.mjs')); assert.ok(!before.files.some(f => f.name === '.env.local'));
  await syncSnapshot(destination, before); await writeFile(path.join(destination, 'unmanaged.txt'), 'preserved');
  const timestamp = (await stat(path.join(destination, 'dirty.mjs'))).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 25)); await syncSnapshot(destination, before);
  assert.equal((await stat(path.join(destination, 'dirty.mjs'))).mtimeMs, timestamp, 'Unchanged source must retain Cargo and Node cache validity');
  const after = { files: before.files.filter(f => f.name !== 'dirty.mjs') }; await syncSnapshot(destination, after);
  await assert.rejects(access(path.join(destination, 'dirty.mjs'))); assert.equal(await readFile(path.join(destination, 'unmanaged.txt'), 'utf8'), 'preserved');
  assert.equal(await readFile(path.join(source, 'dirty.mjs'), 'utf8'), 'changed code');
});
test('an existing directory without the local CI marker is preserved', async t => {
  const root = await fixture(t); await writeFile(path.join(root, 'user.txt'), 'preserved');
  await assert.rejects(syncSnapshot(root, { files: [] }), /unowned/); assert.equal(await readFile(path.join(root, 'user.txt'), 'utf8'), 'preserved');
});
test('parallel lanes copy dependency files independently and bind workspace links to their own snapshot', async t => {
  const root = await fixture(t), lane = path.join(root, 'lane'), sources = path.join(root, 'sources'), alias = path.join(root, 'source-alias');
  await mkdir(sources); await symlink(sources, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const base = path.join(alias, 'base');
  await syncSnapshot(lane, { files: [] });
  for (const folder of [path.join(base, 'node_modules/library'), path.join(base, 'packages/widget'), path.join(lane, 'packages/widget')]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(base, 'node_modules/library/index.js'), 'base dependency');
  await symlink(path.join(base, 'packages/widget'), path.join(base, 'node_modules/widget'), process.platform === 'win32' ? 'junction' : 'dir');
  await cloneDependencies(base, lane, 'exact lock');
  assert.equal(await realpath(path.join(lane, 'node_modules/widget')), await realpath(path.join(lane, 'packages/widget')));
  await writeFile(path.join(lane, 'node_modules/library/index.js'), 'isolated edit');
  assert.equal(await readFile(path.join(base, 'node_modules/library/index.js'), 'utf8'), 'base dependency');
  await symlink(path.join(root, 'lane'), path.join(base, 'node_modules/escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cloneDependencies(base, lane, 'changed lock'), /leaves the isolated checkout/);
});
test('local scheduling respects the process budget and records every result', async () => {
  let active = 0, peak = 0;
  const results = await mapBounded([1, 2, 3, 4, 5], 2, async value => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return value * 2; });
  assert.equal(peak, 2); assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test('browser lanes reserve distinct free ports and release their listeners idempotently', async t => {
  const leases = await reserveLocalPorts(4); t.after(() => Promise.all(leases.map(lease => lease.release())));
  assert.equal(new Set(leases.map(lease => lease.port)).size, 4);
  const probe = createServer();
  await assert.rejects(new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ host: '127.0.0.1', port: leases[0].port, exclusive: true }, resolve); }), { code: 'EADDRINUSE' });
  await leases[0].release(); await leases[0].release();
  const reused = createServer();
  await new Promise((resolve, reject) => { reused.once('error', reject); reused.listen({ host: '127.0.0.1', port: leases[0].port, exclusive: true }, resolve); });
  await new Promise(resolve => reused.close(resolve));
});
test('dependency cache invalidation follows resolution inputs rather than test script edits', () => {
  const file = manifest => [{ name: 'package.json', bytes: Buffer.from(JSON.stringify(manifest)) }, { name: 'package-lock.json', sha256: 'locked bytes' }];
  const first = dependencyFingerprint(file({ dependencies: { react: '19.3.1' }, scripts: { test: 'first' } }));
  assert.equal(dependencyFingerprint(file({ dependencies: { react: '19.3.1' }, scripts: { test: 'changed' } })), first);
  assert.notEqual(dependencyFingerprint(file({ dependencies: { react: 'another' } })), first);
  assert.notEqual(dependencyFingerprint(file({ dependencies: { react: '19.3.1' } }), 'another Node runtime'), first);
});
test('owned local commands produce logs, report failure and obey cancellation', async t => {
  const root = await fixture(t), options = { cwd: root, env: localEnvironment(root, root), log: path.join(root, 'run.log') };
  const success = await runCommand([process.execPath, '-e', 'console.log("owned output")'], options); assert.equal(success.code, 0);
  assert.match(await readFile(options.log, 'utf8'), /owned output/);
  assert.equal((await runCommand([process.execPath, '-e', 'process.exit(7)'], options)).code, 7);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 150);
  try { assert.equal((await runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { ...options, signal: controller.signal })).cancelled, true); } finally { clearTimeout(timer); }
});
