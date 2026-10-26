import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageRoot, packageManifest } from '../native/resolve.mjs';
import { executeNpm } from '../native/npm.mjs';
import { verifyAiDocumentation } from '../release/ai-docs.mjs';
import { readArchive } from '../../../scripts/verify-npm-artifacts.mjs';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('bundled AI guides remain focused, exported and linked inside the npm package', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-docs-validation-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await cp(path.join(packageRoot, 'docs'), path.join(root, 'docs'), {recursive: true});
  await cp(path.join(packageRoot, 'AI.md'), path.join(root, 'AI.md'));
  await mkdir(path.join(root, 'runtime'));
  await mkdir(path.join(root, 'build'));
  await cp(path.join(packageRoot, 'build/ADAPTERS.md'), path.join(root, 'build/ADAPTERS.md'));
  await writeFile(path.join(root, 'runtime/ai-docs.mjs'), '');
  assert.equal((await verifyAiDocumentation(root, packageManifest)).topics, 6);
  const withoutExport = structuredClone(packageManifest);
  delete withoutExport.exports['./AI.md'];
  await assert.rejects(verifyAiDocumentation(root, withoutExport), /documentation export/);
  const original = await readFile(path.join(root, 'AI.md'), 'utf8');
  for (const [addition, expected] of [
    ['\n[Missing topic](docs/ai/missing.md)\n', /Broken AI guide link/],
    ['\n[Outside](../outside.md)\n', /leaves the package/],
    ['x'.repeat(6_001), /reading budget/],
  ]) {
    await writeFile(path.join(root, 'AI.md'), original + addition);
    await assert.rejects(verifyAiDocumentation(root, packageManifest), expected);
  }
});

test('actual npm tarball supplies offline docs and exports without native, dependencies or project config', {timeout: 90_000}, async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'prnext-ai-packed-')));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const result = await executeNpm(['pack', '--workspace', packageManifest.name, '--json', '--ignore-scripts', '--pack-destination', temporary],
    {cwd: repositoryRoot, timeout: 60_000, maxBuffer: 4 * 1024 ** 2});
  const [packed] = JSON.parse(result.stdout);
  const entries = readArchive(await readFile(path.join(temporary, packed.filename)));
  const consumer = path.join(temporary, 'consumer with spaces');
  const installed = path.join(consumer, 'node_modules', packageManifest.name);
  await mkdir(installed, {recursive: true});
  for (const [entry, {data}] of entries) {
    const file = path.join(installed, entry.slice('package/'.length));
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, data);
    assert.doesNotMatch(entry, /\.test\./, 'Test fixtures must not ship in the package.');
  }
  assert.ok(entries.has('package/AI.md'));
  assert.ok(entries.has('package/docs/ai/manifest.json'));
  await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  await writeFile(path.join(consumer, 'prnext.config.mjs'), 'throw Error("Docs must not evaluate configuration")');
  const before = await readdir(consumer);
  const run = args => execute(process.execPath, [path.join(installed, 'cli.mjs'), 'docs', ...args],
    {cwd: consumer, env: {...process.env, PRNEXT_BINARY: path.join(temporary, 'missing-native'), npm_config_registry: 'http://127.0.0.1:1'}, timeout: 15_000});
  const catalog = JSON.parse((await run(['--ai', '--list', '--json'])).stdout);
  assert.equal(catalog.version, packageManifest.version);
  assert.equal(catalog.topics.length, 7);
  const require = createRequire(path.join(consumer, 'package.json'));
  for (const topic of catalog.topics) {
    const report = JSON.parse((await run(['--ai', topic.id, '--json'])).stdout);
    const source = await readFile(path.join(packageRoot, topic.file), 'utf8');
    assert.equal(report.content, source);
    assert.equal(require.resolve(`${packageManifest.name}/${topic.file}`), path.join(installed, topic.file));
    assert.equal(report.version, packageManifest.version);
  }
  assert.equal(require.resolve(`${packageManifest.name}/docs/ai/manifest.json`), path.join(installed, 'docs/ai/manifest.json'));
  assert.deepEqual(await readdir(consumer), before, 'Documentation reads must not modify the consumer.');
  const agents = '# Application instructions\r\n\r\nKeep the existing workflow.\r\n';
  await writeFile(path.join(consumer, 'AGENTS.md'), agents);
  assert.equal(JSON.parse((await run(['--ai', '--init', '--json'])).stdout).initialized.changed, true);
  const initialized = await readFile(path.join(consumer, 'AGENTS.md'), 'utf8');
  assert.ok(initialized.startsWith(agents));
  assert.equal(JSON.parse((await run(['--ai', '--init', '--json'])).stdout).initialized.changed, false);
  assert.equal(await readFile(path.join(consumer, 'AGENTS.md'), 'utf8'), initialized);
  // The command reports installed metadata; no second hand-maintained version.
  const manifestFile = path.join(installed, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.version = '9.8.7-ai-test';
  await writeFile(manifestFile, JSON.stringify(manifest));
  assert.equal(JSON.parse((await run(['--ai', '--json'])).stdout).version, manifest.version);
});
