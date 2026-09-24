import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

const run = promisify(execFile);
const cli = path.join(repositoryRoot, 'packages/rustyx/cli.mjs');
const invoke = (...args) => run(process.execPath, [cli, ...args], { timeout: 30000 });
const nextScripts = { dev: 'next dev --turbopack', build: 'next build', start: 'next start -p 4200', lint: 'eslint .' };

test('installed rx and rustyx aliases expose the same CLI and migration help', async () => {
  const pkg = JSON.parse(await readFile(path.join(repositoryRoot, 'packages/rustyx/package.json'), 'utf8'));
  assert.equal(pkg.bin.rx, pkg.bin.rustyx);
  // Resolve npm's actual executable links on POSIX; Windows uses .cmd wrappers.
  for (const name of ['rx', 'rustyx']) {
    const executable = process.platform === 'win32' ? cli : await realpath(path.join(repositoryRoot, 'node_modules/.bin', name));
    assert.equal((await run(process.execPath, [executable, '--version'])).stdout.trim(), pkg.version);
    const help = (await run(process.execPath, [executable, 'migrate', '--help'])).stdout;
    assert.match(help, /--dry-run/);
    assert.match(help, /--no-install/);
  }
});

test('migration CLI previews and prepares an App project without changing sources, then reports pending dependency validation', async t => {
  const f = await appFixture();
  t.after(() => f.remove());
  const file = path.join(f.root, 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.scripts = nextScripts;
  const original = JSON.stringify(pkg, null, 2) + '\n';
  await writeFile(file, original);
  const reactFile = path.join(f.root, 'node_modules/react/package.json');
  const react = await readFile(reactFile, 'utf8');
  await writeFile(reactFile, JSON.stringify({ ...JSON.parse(react), version: '19.0.0' }));
  const page = await readFile(path.join(f.root, 'app/page.tsx'), 'utf8');
  const before = (await readdir(f.root)).sort();
  const preview = JSON.parse((await invoke('migrate', f.root, '--dry-run', '--json')).stdout);
  assert.equal(preview.ok, true);
  assert.equal(preview.status, 'preview');
  assert.ok(preview.preflight.routes.some(route => route.router === 'app'));
  assert.deepEqual((await readdir(f.root)).sort(), before);
  assert.equal(await readFile(file, 'utf8'), original);
  const prepared = JSON.parse((await invoke('migrate', f.root, '--no-install', '--json')).stdout);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.status, 'prepared');
  assert.match(prepared.notes.join(' '), /installation.*pending/);
  assert.equal(await readFile(prepared.backups[0], 'utf8'), original);
  const migrated = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(migrated.scripts.build, 'rx build');
  assert.equal(migrated.scripts.start, 'rx start --port 4200');
  assert.equal(migrated.scripts['build:next'], nextScripts.build);
  assert.equal(migrated.scripts.lint, nextScripts.lint);
  assert.equal(await readFile(path.join(f.root, 'app/page.tsx'), 'utf8'), page);
  assert.equal(JSON.parse((await invoke('migrate', f.root, '--no-install', '--json')).stdout).status, 'unchanged');
  await assert.rejects(invoke('check', f.root, '--json'), error => {
    assert.match(JSON.parse(error.stdout).errors.join(' '), /npm install --save-exact/);
    return error.code === 1;
  });
  await writeFile(reactFile, react);
  assert.equal(JSON.parse((await invoke('check', f.root, '--json')).stdout).ok, true);
});

test('migration CLI blocks invalid configuration before backing up or editing the project', async t => {
  const f = await appFixture();
  t.after(() => f.remove());
  const file = path.join(f.root, 'package.json');
  const original = JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), scripts: nextScripts });
  await writeFile(file, original);
  await writeFile(path.join(f.root, 'next.config.mjs'), 'export default {webpack(config){config.plugins.push({});return config}};');
  await assert.rejects(invoke('migrate', f.root, '--no-install', '--json'), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(report.status, 'blocked');
    assert.match(report.error, /plugins must implement apply/);
    assert.deepEqual(report.backups, []);
    return error.code === 1;
  });
  assert.equal(await readFile(file, 'utf8'), original);
});
