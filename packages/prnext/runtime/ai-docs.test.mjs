import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {executeAiDocs} from './ai-docs.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'prnext-ai-docs-')));
  const packageRoot = path.join(directory, 'installed-package'), cwd = path.join(directory, 'consumer');
  await mkdir(path.join(packageRoot, 'docs/ai'), {recursive: true});
  await mkdir(cwd);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: '@thomas.f/prnext', version: '9.8.7-test'}));
  await writeFile(path.join(packageRoot, 'AI.md'), '# Installed AI index\n\nRead only what is needed.\n');
  await writeFile(path.join(packageRoot, 'docs/ai/manifest.json'), JSON.stringify({schemaVersion: 1, topics: [
    {id: 'quickstart', title: 'Getting started', file: 'docs/ai/quickstart.md'},
    {id: 'routing', title: 'Routes and boundaries', file: 'docs/ai/routing.md'},
  ]}));
  await writeFile(path.join(packageRoot, 'docs/ai/quickstart.md'), '# Quickstart\n\nUse installed APIs.\n');
  await writeFile(path.join(packageRoot, 'docs/ai/routing.md'), '# Routing\n');
  t.after(() => rm(directory, {recursive: true, force: true}));
  const options = {cwd, packageRoot};
  return {directory, packageRoot, cwd, options, run: args => executeAiDocs(args, options)};
}

test('reads the installed version and index without native code or project configuration', async t => {
  const {cwd, run} = await fixture(t);
  await writeFile(path.join(cwd, 'prnext.config.mjs'), 'throw new Error("The documentation must not load project configuration")');
  const result = await run(['--ai']);
  assert.match(result.output, /@thomas\.f\/prnext 9\.8\.7-test/);
  assert.match(result.output, /# Installed AI index/);
  assert.deepEqual((await readdir(cwd)), ['prnext.config.mjs']);
});

test('JSON topic output is structured and includes the full installed topic', async t => {
  const {run} = await fixture(t);
  const result = JSON.parse((await run(['--ai', 'quickstart', '--json'])).output);
  assert.equal(result.name, '@thomas.f/prnext');
  assert.equal(result.version, '9.8.7-test');
  assert.equal(result.topic, 'quickstart');
  assert.equal(result.content, '# Quickstart\n\nUse installed APIs.\n');
  assert.deepEqual(result.topics.map(topic => topic.id), ['index', 'quickstart', 'routing']);
});

test('list enumerates the implicit index and topic metadata without reading page contents', async t => {
  const {packageRoot, run} = await fixture(t);
  await rm(path.join(packageRoot, 'docs/ai/routing.md'));
  assert.match((await run(['--ai', '--list'])).output, /index\s+AI documentation index/);
  const report = JSON.parse((await run(['--ai', '--list', '--json'])).output);
  assert.deepEqual(report.topics.map(topic => topic.id), ['index', 'quickstart', 'routing']);
  assert.equal(report.content, undefined);
});

test('help needs no installed package and describes explicit initialization', async () => {
  const result = await executeAiDocs(['--help'], {packageRoot: 'does-not-exist'});
  assert.match(result.output, /--init \[directory\]/);
  assert.match(result.output, /Existing instructions are preserved/);
  assert.equal((await executeAiDocs(['--ai', '--help'])).output, result.output);
});

test('rejects unknown flags, invalid combinations, duplicate options and topic traversal', async t => {
  const {run, cwd} = await fixture(t);
  for (const args of [[], ['--list'], ['--ai', '--unknown'], ['--ai', '--ai'], ['--ai', 'one', 'two'],
    ['--ai', '--list', 'routing'], ['--ai', '--list', '--init'], ['--ai', '--help', '--init'],
    ['--ai', '../../package.json'], ['--ai', '/absolute/path'], ['--ai', 'routing.md'], ['--ai', '--json', '--json']]) {
    await assert.rejects(run(args), undefined, JSON.stringify(args));
  }
  assert.deepEqual(await readdir(cwd), []);
});

test('rejects malformed documentation manifests before touching a consumer project', async t => {
  const {packageRoot, cwd, run} = await fixture(t);
  for (const manifest of [{topics: []}, {schemaVersion: 2, topics: []}, {schemaVersion: 1, topics: 'routing'},
    {schemaVersion: 1, topics: [{id: '../outside', title: 'Outside', file: '../outside.md'}]},
    {schemaVersion: 1, topics: [{id: 'index', title: 'Index', file: 'AI.md'}]},
    {schemaVersion: 1, topics: [{id: 'routing', title: 'Route\nInjected', file: 'docs/ai/routing.md'}]},
    {schemaVersion: 1, topics: [{id: 'routing', title: 'Route', file: '/outside.md'}]},
    {schemaVersion: 1, topics: [{id: 'routing', title: 'Routes', file: 'docs/ai/routing.md'}, {id: 'routing', title: 'Duplicate', file: 'docs/ai/routing.md'}]}]) {
    await writeFile(path.join(packageRoot, 'docs/ai/manifest.json'), JSON.stringify(manifest));
    await assert.rejects(run(['--ai', '--init']), /manifest/);
    assert.deepEqual(await readdir(cwd), []);
  }
});

test('init creates only an explicit short AGENTS pointer with package-manager alternatives', async t => {
  const {cwd, run} = await fixture(t);
  const result = await run(['--ai', '--init']);
  assert.deepEqual(result.initialized, {path: path.join(cwd, 'AGENTS.md'), changed: true});
  const text = await readFile(result.initialized.path, 'utf8');
  assert.match(text, /npx --no-install prnext docs --ai/);
  assert.match(text, /pnpm exec prnext docs --ai/);
  assert.match(text, /yarn prnext docs --ai/);
  assert.doesNotMatch(text, /node_modules|postinstall|9\.8\.7/);
  assert.deepEqual(await readdir(cwd), ['AGENTS.md']);
});

test('init preserves existing bytes, UTF-8 BOM and CRLF and is byte-identical on a second run', async t => {
  const {cwd, run} = await fixture(t);
  const file = path.join(cwd, 'AGENTS.md');
  const original = Buffer.from('\ufeff# Mes consignes\r\n\r\nPréserver exactement mon contenu.');
  await writeFile(file, original);
  await run(['--ai', '--init']);
  const first = await readFile(file);
  assert.deepEqual(first.subarray(0, original.length), original);
  const text = first.toString('utf8');
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  const again = await run(['--ai', '--init', '--json']);
  assert.equal(JSON.parse(again.output).initialized.changed, false);
  assert.deepEqual(await readFile(file), first);
});

test('init keeps an existing complete managed block even if the owner edited it', async t => {
  const {cwd, run} = await fixture(t);
  const original = '# Rules\n<!-- prnext-ai-docs:start -->\nOwner-customized instructions.\n<!-- prnext-ai-docs:end -->\n';
  const file = path.join(cwd, 'AGENTS.md');
  await writeFile(file, original);
  assert.equal((await run(['--ai', '--init'])).initialized.changed, false);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('init rejects incomplete or duplicate markers without modifying existing instructions', async t => {
  const {cwd, run} = await fixture(t);
  const file = path.join(cwd, 'AGENTS.md');
  for (const original of ['Keep this\n<!-- prnext-ai-docs:start -->\n', '<!-- prnext-ai-docs:end -->\n',
    '<!-- prnext-ai-docs:end --><!-- prnext-ai-docs:start -->',
    '<!-- prnext-ai-docs:start --><!-- prnext-ai-docs:end --><!-- prnext-ai-docs:start --><!-- prnext-ai-docs:end -->']) {
    await writeFile(file, original);
    await assert.rejects(run(['--ai', '--init']), /markers/);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await readdir(cwd), ['AGENTS.md']);
  }
});

test('init supports a specified existing directory without modifying the current one', async t => {
  const {directory, cwd, run} = await fixture(t);
  const requested = path.join(directory, 'explicit-project');
  await mkdir(requested);
  const report = JSON.parse((await run(['--ai', '--init', requested, '--json'])).output);
  assert.equal(report.initialized.path, path.join(requested, 'AGENTS.md'));
  assert.deepEqual(await readdir(cwd), []);
  assert.deepEqual(await readdir(requested), ['AGENTS.md']);
  await assert.rejects(run(['--ai', '--init', path.join(directory, 'missing')]), {code: 'ENOENT'});
});

test('init rejects a directory, hard link or oversized instructions at AGENTS.md', async t => {
  const {directory, cwd, run} = await fixture(t);
  const file = path.join(cwd, 'AGENTS.md');
  await mkdir(file);
  await assert.rejects(run(['--ai', '--init']), /regular file/);
  await rm(file, {recursive: true});
  const external = path.join(directory, 'external.md');
  await writeFile(external, 'External instructions');
  await link(external, file);
  await assert.rejects(run(['--ai', '--init']), /hard links/);
  assert.equal(await readFile(external, 'utf8'), 'External instructions');
  await rm(file);
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(run(['--ai', '--init']), /limit/);
  assert.equal((await lstat(file)).size, 1024 * 1024 + 1);
});

test('init rejects invalid UTF-8 without changing the file', async t => {
  const {cwd, run} = await fixture(t);
  const file = path.join(cwd, 'AGENTS.md'), original = Buffer.from([0xff, 0xfe, 0x00]);
  await writeFile(file, original);
  await assert.rejects(run(['--ai', '--init']), /UTF-8/);
  assert.deepEqual(await readFile(file), original);
});

test('init respects an existing lock and leaves its content untouched', async t => {
  const {cwd, run} = await fixture(t);
  const lock = path.join(cwd, '.prnext-ai-docs.lock');
  await writeFile(lock, 'Another initializer owns this');
  await assert.rejects(run(['--ai', '--init']), /existing lock/);
  assert.equal(await readFile(lock, 'utf8'), 'Another initializer owns this');
  assert.deepEqual(await readdir(cwd), ['.prnext-ai-docs.lock']);
});

test('init flushes the physical file when a package manager leaves FileHandle.sync unimplemented', async t => {
  const {cwd, run} = await fixture(t);
  const probe = await open(path.join(cwd, 'AGENTS.md'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.mock.method(prototype, 'sync', () => { throw new Error('Method not implemented.'); });
  const originalFsync = fs.fsync;
  let flushed = 0;
  t.mock.method(fs, 'fsync', (fd, callback) => { flushed++; return originalFsync(fd, callback); });
  assert.equal((await run(['--ai', '--init'])).initialized.changed, true);
  assert.equal(flushed, 1);
  assert.equal((await run(['--ai', '--init'])).initialized.changed, false);
  assert.equal(flushed, 1, 'An unchanged file needs no additional flush.');
  assert.deepEqual(await readdir(cwd), ['AGENTS.md']);
});

test('init reports genuine fsync errors and still releases its lock', async t => {
  const {cwd, run} = await fixture(t);
  const failure = Object.assign(new Error('Disk flush failed'), {code: 'EIO'});
  t.mock.method(fs, 'fsync', (fd, callback) => callback(failure));
  await assert.rejects(run(['--ai', '--init']), error => error === failure);
  assert.deepEqual(await readdir(cwd), ['AGENTS.md']);
  assert.match(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), /prnext-ai-docs:start/);
});

test('simultaneous initialization never duplicates the block or loses existing instructions', async t => {
  const {cwd, run} = await fixture(t);
  const file = path.join(cwd, 'AGENTS.md');
  await writeFile(file, 'Preserve these instructions.\n');
  const results = await Promise.allSettled([run(['--ai', '--init']), run(['--ai', '--init'])]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.match(result.reason.message, /existing lock/);
  const content = await readFile(file, 'utf8');
  assert.ok(content.startsWith('Preserve these instructions.\n'));
  assert.equal(content.split('<!-- prnext-ai-docs:start -->').length - 1, 1);
  assert.deepEqual(await readdir(cwd), ['AGENTS.md']);
});

test('init rejects a symbolic AGENTS file without following it', async t => {
  const {directory, cwd, run} = await fixture(t);
  const external = path.join(directory, 'external.md'), file = path.join(cwd, 'AGENTS.md');
  await writeFile(external, 'Do not modify this external file.');
  try { await symlink(external, file, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Creating file symlinks is not permitted by this Windows account.'); throw error; }
  await assert.rejects(run(['--ai', '--init']), /symbolic/);
  assert.equal(await readFile(external, 'utf8'), 'Do not modify this external file.');
});

test('init rejects symbolic directory components and junctions', async t => {
  const {directory, run} = await fixture(t);
  const external = path.join(directory, 'elsewhere'), pointer = path.join(directory, 'linked');
  await mkdir(path.join(external, 'nested'), {recursive: true});
  await symlink(external, pointer, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(['--ai', '--init', path.join(pointer, 'nested')]), /symbolic link or junction/);
  assert.deepEqual(await readdir(path.join(external, 'nested')), []);
});

test('documentation reads reject a topic symlink escaping the package', async t => {
  const {directory, packageRoot, run} = await fixture(t);
  const outside = path.join(directory, 'outside.md'), topic = path.join(packageRoot, 'docs/ai/routing.md');
  await writeFile(outside, 'Do not expose an arbitrary file.');
  await rm(topic);
  try { await symlink(outside, topic, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Creating file symlinks is not permitted by this Windows account.'); throw error; }
  await assert.rejects(run(['--ai', 'routing']), /escapes the installed package/);
});
