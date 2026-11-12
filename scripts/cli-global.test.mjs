import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeNpm } from '../packages/prnext/native/npm.mjs';
import { checkCliLaunchers } from './cli-launchers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('npm pack installs real global CLI launchers in paths with spaces', { timeout: 600000 }, async t => {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, 'prnext-cli-global-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), tempRoot);
    assert.ok(path.basename(directory).startsWith('prnext-cli-global-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:PRNEXT_|RUSTYX_|NODE_PATH$|NODE_OPTIONS$|NPM_TOKEN$|NODE_AUTH_TOKEN$|npm_config_|npm_execpath$|npm_lifecycle_|npm_package_|INIT_CWD$)/i.test(name)) delete env[name];
  const prefix = path.join(directory, 'global prefix with spaces');
  const cwd = path.join(directory, 'consumer with spaces');
  await mkdir(cwd);
  const emptyConfig = path.join(directory, 'empty.npmrc');
  await writeFile(emptyConfig, '');
  Object.assign(env, {
    npm_config_userconfig: emptyConfig,
    npm_config_globalconfig: path.join(directory, 'global.npmrc'),
    npm_config_cache: process.env.PRNEXT_CLI_TEST_CACHE || path.join(directory, 'npm-cache'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false'
  });
  const source = JSON.parse(await readFile(path.join(root, 'packages/prnext/package.json'), 'utf8'));
  const pack = await executeNpm(['pack', '--workspace', source.name, '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, env, timeout: 60000, maxBuffer: 4 * 1024 ** 2 });
  const archive = JSON.parse(pack.stdout)[0];
  assert.equal(archive.name, source.name);
  assert.equal(archive.version, source.version);
  assert.ok(archive.files.some(file => file.path === 'cli.mjs' && (process.platform === 'win32' || (file.mode & 0o111))));
  // No package install hook is needed to create or repair launchers. Native
  // binaries are exercised by the separate complete package qualification.
  await executeNpm(['install', '--global', '--prefix', prefix, path.join(directory, archive.filename), '--omit=optional', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'], { cwd, env, timeout: 480000, maxBuffer: 2 * 1024 ** 2 });
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', source.name);
  const relative = path.relative(await realpath(prefix), await realpath(installed));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Global package must be installed inside the isolated prefix');
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.engines, source.engines);
  for (const name of ['prnext', 'prn']) assert.equal(manifest.bin[name].replace(/^\.\//, ''), 'cli.mjs');
  const cli = await readFile(path.join(installed, 'cli.mjs'));
  assert.deepEqual(cli, await readFile(path.join(root, 'packages/prnext/cli.mjs')));
  assert.match(cli.toString('utf8'), /^#!\/usr\/bin\/env node\r?\n/);
  assert.match(await readFile(path.join(installed, 'docs/windows-cli.md'), 'utf8'), /Windows 10, Windows 11/);
  const report = await checkCliLaunchers({ prefix, cwd, version: source.version, env, requirePowerShellCore: process.env.GITHUB_ACTIONS === 'true' });
  t.diagnostic(JSON.stringify({ node: process.version, platform: process.platform, ...report }));
});
