import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedDispatcher } from './install-hooks.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'prnext-install-hooks-'));
  const root = path.join(directory, 'main checkout');
  mkdirSync(root);
  const config = path.join(directory, 'empty-config');
  writeFileSync(config, '');
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || process.env.Path || ''), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_AUTHOR_NAME: 'Hook fixture', GIT_COMMITTER_NAME: 'Hook fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT']) delete env[key];
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (name, text) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text); };
  git(['-c', 'init.defaultBranch=main', 'init', '-q']);
  put('.gitignore', 'node_modules/\n.checks/\n');
  put('.gitattributes', '* text=auto eol=lf\n');
  put('README.md', 'Fixture repository.\n');
  const commit = () => { git(['add', '-A']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'synthetic fixture']); return git(['rev-parse', 'HEAD']); };
  const base = commit();
  put('scripts/install-hooks.mjs', readFileSync(path.join(source, 'scripts/install-hooks.mjs'), 'utf8'));
  const install = () => {
    try { return { code: 0, output: execFileSync(process.execPath, [path.join(root, 'scripts/install-hooks.mjs')], { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (error) { return { code: error.status, output: String(error.stdout || '') + String(error.stderr || '') }; }
  };
  const controls = () => {
    put('package.json', '{"type":"module"}\n');
    for (const name of ['scripts/pre-push.mjs', 'scripts/ci-scope.mjs', '.githooks/pre-push']) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      copyFileSync(path.join(source, name), path.join(root, name));
    }
    put('scripts/ci-scope.test.mjs', "import test from 'node:test';import {appendFileSync} from 'node:fs';test('fixture',()=>appendFileSync('.checks/events','tooling\\n'));\n");
    for (const project of ['tests/types', 'examples/basic', 'examples/app']) put(project + '/tsconfig.json', '{}\n');
    put('node_modules/typescript/package.json', '{"type":"commonjs"}\n');
    put('node_modules/typescript/bin/tsc', "require('node:fs').appendFileSync('.checks/events','types\\n');\n");
    mkdirSync(path.join(root, '.checks'));
  };
  return { directory, root, env, git, put, commit, base, install, controls, target: path.join(root, '.git/hooks/pre-push'), close: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5 }) };
}

test('installation is opt-in, repository-local, idempotent and leaves core.hooksPath unset', () => {
  const f = fixture();
  try {
    assert.equal(existsSync(f.target), false);
    assert.equal(f.install().code, 0);
    assert.equal(readFileSync(f.target, 'utf8'), managedDispatcher);
    const modified = statSync(f.target).mtimeMs;
    const second = f.install();
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /already installed/);
    assert.equal(statSync(f.target).mtimeMs, modified);
    assert.throws(() => f.git(['config', '--get', 'core.hooksPath']));
    if (process.platform !== 'win32') assert.ok(statSync(f.target).mode & 0o111);
  } finally { f.close(); }
});

test('custom hooks and edited managed dispatchers are preserved byte for byte', () => {
  for (const contents of ['#!/bin/sh\nexit 7\n', managedDispatcher + '# local modification\n']) {
    const f = fixture();
    try {
      writeFileSync(f.target, contents);
      const result = f.install();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /custom or modified pre-push hook/);
      assert.equal(readFileSync(f.target, 'utf8'), contents);
    } finally { f.close(); }
  }
});

test('existing core.hooksPath values, including an empty configured value, are never replaced', () => {
  for (const value of ['custom-hooks', '']) {
    const f = fixture();
    try {
      f.git(['config', 'core.hooksPath', value]);
      const result = f.install();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /core.hooksPath is already configured/);
      assert.equal(f.git(['config', '--get', 'core.hooksPath']), value);
      assert.equal(existsSync(f.target), false);
    } finally { f.close(); }
  }
});

test('a non-file custom pre-push target is not followed or replaced', () => {
  const f = fixture();
  try {
    mkdirSync(f.target);
    const result = f.install();
    assert.notEqual(result.code, 0);
    assert.ok(statSync(f.target).isDirectory());
  } finally { f.close(); }
});

test('the shared dispatcher validates the active clean worktree and leaves old branches without a hook unchanged', () => {
  const f = fixture();
  try {
    const old = path.join(f.directory, 'old checkout'), remote = path.join(f.directory, 'remote.git');
    f.git(['worktree', 'add', '-q', '-b', 'legacy', old, f.base]);
    f.controls();
    const head = f.commit();
    assert.equal(f.install().code, 0);
    f.git(['init', '--bare', '-q', remote]);
    f.git(['remote', 'add', 'origin', remote]);
    f.git(['push', '-q', 'origin', 'HEAD:refs/heads/legacy'], old);
    assert.equal(f.git(['rev-parse', 'refs/heads/legacy'], remote), f.base);
    assert.equal(existsSync(path.join(old, '.checks/events')), false);
    const output = f.git(['push', 'origin', 'HEAD:refs/heads/checked']);
    assert.match(output, /checks passed/);
    assert.equal(f.git(['rev-parse', 'refs/heads/checked'], remote), head);
    assert.deepEqual(readFileSync(path.join(f.root, '.checks/events'), 'utf8').trim().split('\n'), ['tooling', 'types', 'types', 'types']);
    writeFileSync(path.join(f.root, '.checks/events'), '');
    f.git(['push', '-q', 'origin', ':refs/heads/checked']);
    assert.equal(readFileSync(path.join(f.root, '.checks/events'), 'utf8'), '');
    assert.equal(readFileSync(f.target, 'utf8'), managedDispatcher);
    assert.throws(() => f.git(['config', '--get', 'core.hooksPath']));
  } finally { f.close(); }
});
