import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePushUpdates } from './pre-push.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const zeros = '0'.repeat(40);
const record = (local, remote, name = 'topic') => `refs/heads/${name} ${local} refs/heads/${name} ${remote}\n`;

function fixture({ compiler = false, legacy = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'prnext-pre-push-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config'), GIT_AUTHOR_NAME: 'Pre-push fixture', GIT_COMMITTER_NAME: 'Pre-push fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of ['NODE_TEST_CONTEXT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT']) delete env[key];
  const put = (name, contents) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), contents); };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  put('empty-config', '');
  put('.gitignore', 'node_modules/\n.checks/\nempty-config\n');
  put('.gitattributes', '* text=auto eol=lf\n');
  put('package.json', '{"type":"module"}\n');
  put('README.md', 'Original documentation.\n');
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, '.githooks'));
  for (const name of ['scripts/pre-push.mjs', 'scripts/ci-scope.mjs', '.githooks/pre-push']) copyFileSync(path.join(source, name), path.join(root, name));
  for (const name of ['ci-scope', 'ci-extra', 'pre-push', 'install-hooks']) put(`scripts/${name}.test.mjs`, `import test from 'node:test';import {appendFileSync} from 'node:fs';test('fixture ${name}',()=>appendFileSync('.checks/events',${JSON.stringify(name + '\n')}));\n`);
  for (const project of ['tests/types', 'examples/basic', 'examples/app']) put(project + '/tsconfig.json', '{}\n');
  mkdirSync(path.join(root, '.checks'));
  if (legacy) put('legacy.txt', 'Historical trailing whitespace. \n');
  if (compiler) {
    put('node_modules/typescript/package.json', '{"type":"commonjs"}\n');
    put('node_modules/typescript/bin/tsc', "require('node:fs').appendFileSync('.checks/events','types:'+process.argv.at(-1)+'\\n');if(process.env.FIXTURE_TYPES_FAIL)process.exit(17);\n");
  }
  const commit = () => { git('add', '-A'); git('-c', 'commit.gpgSign=false', 'commit', '-qm', 'synthetic fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit();
  const run = (input, extraEnv = {}) => {
    try {
      const output = execFileSync(process.execPath, [path.join(root, 'scripts/pre-push.mjs'), 'origin', 'fixture-remote'], { cwd: root, env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 ** 2, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0, output };
    } catch (error) { return { code: error.status, output: String(error.stdout || '') + String(error.stderr || '') }; }
  };
  const events = () => existsSync(path.join(root, '.checks/events')) ? readFileSync(path.join(root, '.checks/events'), 'utf8').trim().split('\n') : [];
  return { root, put, git, commit, base, run, events, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test('push records preserve SHA-1/SHA-256 updates, deletions and Unicode refs; malformed input fails closed', () => {
  assert.equal(parsePushUpdates('')[0], undefined);
  assert.equal(parsePushUpdates(record('a'.repeat(40), zeros))[0].creation, true);
  assert.equal(parsePushUpdates(record(zeros, 'a'.repeat(40)))[0].deletion, true);
  assert.equal(parsePushUpdates(`HEAD ${'a'.repeat(64)} refs/heads/été ${'b'.repeat(64)}\r\n`)[0].remoteRef, 'refs/heads/été');
  for (const input of ['\n', 'missing fields', record(zeros, zeros), record('a'.repeat(41), zeros), 'x'.repeat(65537)]) assert.throws(() => parsePushUpdates(input));
});

test('documentation-only updates run all lightweight tooling tests without installed TypeScript', () => {
  const f = fixture();
  try {
    f.put('README.md', 'Updated documentation.\n');
    const head = f.commit(), result = f.run(record(head, f.base));
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /documentation checks passed/);
    assert.deepEqual(f.events().sort(), ['ci-extra', 'ci-scope', 'install-hooks', 'pre-push']);
  } finally { f.close(); }
});

test('executable changes run the local compiler for all three TypeScript projects', () => {
  const f = fixture({ compiler: true });
  try {
    f.put('runtime.mjs', 'export const value = 1;\n');
    const head = f.commit(), result = f.run(record(head, f.base));
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(f.events().filter(value => value.startsWith('types:')), ['types:tests/types/tsconfig.json', 'types:examples/basic/tsconfig.json', 'types:examples/app/tsconfig.json']);
  } finally { f.close(); }
});

test('new branches use a known remote merge-base for whitespace but still require TypeScript', () => {
  const f = fixture({ compiler: true, legacy: true });
  try {
    f.git('update-ref', 'refs/remotes/origin/main', f.base);
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    f.put('README.md', 'New branch documentation.\n');
    const result = f.run(record(f.commit(), zeros));
    assert.equal(result.code, 0, result.output);
    assert.equal(f.events().filter(value => value.startsWith('types:')).length, 3);
  } finally { f.close(); }
});

test('an initial push without a remote anchor inspects the complete tree instead of an empty diff', () => {
  const f = fixture({ compiler: true });
  try {
    const result = f.run(record(f.base, zeros));
    assert.equal(result.code, 0, result.output);
    assert.equal(f.events().filter(value => value.startsWith('types:')).length, 3);
  } finally { f.close(); }
});

test('multiple refs at HEAD include earlier executable changes and run checks once', () => {
  const f = fixture({ compiler: true });
  try {
    f.put('runtime.mjs', 'export const value = 1;\n');
    const code = f.commit();
    f.put('README.md', 'Later documentation.\n');
    const head = f.commit(), result = f.run(record(head, code, 'one') + record(head, f.base, 'two'));
    assert.equal(result.code, 0, result.output);
    assert.equal(f.events().filter(value => value === 'ci-scope').length, 1);
    assert.equal(f.events().filter(value => value.startsWith('types:')).length, 3);
  } finally { f.close(); }
});

test('deletions and no-update pushes do not validate unrelated dirty source', () => {
  const f = fixture();
  try {
    f.put('README.md', 'Uncommitted work stays here.\n');
    assert.equal(f.run(record(zeros, f.base)).code, 0);
    assert.equal(f.run('').code, 0);
    assert.deepEqual(f.events(), []);
    assert.equal(readFileSync(path.join(f.root, 'README.md'), 'utf8'), 'Uncommitted work stays here.\n');
  } finally { f.close(); }
});

test('pushing a different commit, including multi-ref updates, is refused before checks', () => {
  const f = fixture();
  try {
    f.put('README.md', 'Current checkout.\n');
    const head = f.commit();
    for (const input of [record(f.base, f.base), record(head, f.base, 'one') + record(f.base, f.base, 'two')]) {
      const result = f.run(input);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /does not point to this worktree/);
    }
    assert.deepEqual(f.events(), []);
  } finally { f.close(); }
});

test('staged, unstaged, untracked and assume-unchanged source cannot stand in for the pushed tree', () => {
  for (const state of ['unstaged', 'staged', 'untracked', 'assume-unchanged']) {
    const f = fixture();
    try {
      if (state === 'assume-unchanged') f.git('update-index', '--assume-unchanged', 'README.md');
      f.put(state === 'untracked' ? 'untracked.mjs' : 'README.md', 'Local source differs.\n');
      if (state === 'staged') f.git('add', 'README.md');
      const result = f.run(record(f.base, f.base));
      assert.notEqual(result.code, 0, state);
      assert.match(result.output, /clean worktree|assume-unchanged/);
      assert.deepEqual(f.events(), []);
    } finally { f.close(); }
  }
});

test('a missing remote object and an unknown empty diff never produce a docs-only pass', () => {
  const f = fixture();
  try {
    const missing = f.run(record(f.base, 'a'.repeat(40)));
    assert.notEqual(missing.code, 0);
    assert.match(missing.output, /Fetch the remote ref/);
    const unchanged = f.run(record(f.base, f.base));
    assert.notEqual(unchanged.code, 0);
    assert.match(unchanged.output, /local TypeScript compiler is missing/);
  } finally { f.close(); }
});

test('whitespace, failed tooling tests and failed TypeScript each block the push', () => {
  for (const failure of ['whitespace', 'tooling', 'types']) {
    const f = fixture({ compiler: true });
    try {
      f.put('runtime.mjs', failure === 'whitespace' ? 'export const value = 1; \n' : 'export const value = 1;\n');
      if (failure === 'tooling') f.put('scripts/ci-extra.test.mjs', "import test from 'node:test';test('genuine failure',()=>{throw new Error('tooling fixture failed')});\n");
      const head = f.commit(), result = f.run(record(head, f.base), failure === 'types' ? { FIXTURE_TYPES_FAIL: '1' } : {});
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, failure === 'whitespace' ? /whitespace check/ : failure === 'tooling' ? /Lightweight tooling tests failed/ : /TypeScript: tests\/types\/tsconfig.json failed/);
      if (failure === 'tooling') assert.equal(f.events().some(value => value.startsWith('types:')), false);
    } finally { f.close(); }
  }
});
