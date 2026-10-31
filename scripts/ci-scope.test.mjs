import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentationOnly, readChanges, requiresFullTests } from './ci-scope.mjs';

const change = (name, oldMode = '100644', newMode = '100644') => ({ name, oldMode, newMode });

test('only explicitly listed documentation can skip the platform matrix', () => {
  assert.equal(documentationOnly([change('README.md'), change('packages/prnext/README.md')]), true);
  assert.equal(documentationOnly(['CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/assets/prnext-logo.svg', '.github/FUNDING.yml'].map(name => change(name))), true);
  assert.equal(documentationOnly([change('CHANGELOG.md', '000000'), change('RELEASE.md', '100644', '000000')]), true);
  for (const name of ['package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/assets/runtime.js', '.github/assets/other.svg', 'src/server.rs', 'examples/app/README.md', 'tests/fixture.md', 'README.mdx', 'docs/new.md']) {
    assert.equal(documentationOnly([change('README.md'), change(name)]), false, name);
  }
  assert.equal(documentationOnly([]), false);
  assert.equal(documentationOnly([change('README.md', '100644', '120000')]), false);
  assert.equal(documentationOnly([change('README.md', '100644', '100755')]), false);
});

test('PNG and GIF documentation images use lightweight checks without hiding code changes', () => {
  for (const name of ['.github/assets/prnext-logo-metallic.gif', '.github/assets/prnext-logo-metallic-static.png', '.github/assets/logo@2x.png']) {
    for (const [oldMode, newMode] of [['000000', '100644'], ['100644', '100644'], ['100644', '000000']]) {
      assert.equal(documentationOnly([change('README.md'), change(name, oldMode, newMode)]), true);
    }
    for (const mode of ['100755', '120000', '160000']) {
      assert.equal(documentationOnly([change(name, mode, '100644')]), false);
      assert.equal(documentationOnly([change(name, '100644', mode)]), false);
    }
    for (const code of ['src/server.rs', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/ci-scope.mjs', 'scripts/ci-scope.test.mjs']) {
      assert.equal(documentationOnly([change(name), change(code)]), false, code);
    }
  }
  for (const name of ['logo.png', 'tests/logo.gif', 'examples/app/logo.png', '.github/assets/nested/logo.png', '.github/assets/logo.PNG', '.github/assets/logo.png.js', '.github/assets/other.svg', '.github/assets/logo.png\n', '.github/assets/logo.gif\r\n', '.github/assets/../runtime.png']) {
    assert.equal(documentationOnly([change(name)]), false, JSON.stringify(name));
  }
});

test('manual runs and initial pushes always run tests; invalid revisions fail closed', () => {
  assert.equal(requiresFullTests('workflow_dispatch'), true);
  assert.equal(requiresFullTests('push', '0'.repeat(40)), true);
  assert.equal(requiresFullTests('unknown'), true);
  assert.throws(() => requiresFullTests('pull_request', 'main', 'HEAD'), /full commit SHAs/);
});

// This entire function runs in an isolated child: the imported scope helpers
// spawn Git too, so sanitizing only this function's git() calls is insufficient.
function exerciseGitDiff(directory) {
  const change = (name, oldMode = '100644', newMode = '100644') => ({ name, oldMode, newMode });
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // These synthetic local commits never leave the temporary test repository.
  const commit = () => { git('add', '-A'); git('-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
    git('init', '-q');
    writeFileSync(path.join(directory, 'README.md'), 'original\n');
    const base = commit();
    writeFileSync(path.join(directory, 'README.md'), 'updated\n');
    const docs = commit();
    assert.equal(requiresFullTests('pull_request', base, docs, directory), false);
    assert.deepEqual(readChanges(base, docs, directory), [change('README.md')]);
    writeFileSync(path.join(directory, 'runtime.mjs'), 'export const code = true;\n');
    commit();
    writeFileSync(path.join(directory, 'README.md'), 'another doc edit\n');
    assert.equal(requiresFullTests('pull_request', base, commit(), directory), true);
    git('reset', '--hard', docs);
    git('mv', 'README.md', 'runtime.mjs');
    const rename = commit();
    assert.equal(readChanges(docs, rename, directory).length, 2);
    assert.equal(requiresFullTests('pull_request', docs, rename, directory), true);
    git('reset', '--hard', docs);
    git('rm', 'README.md');
    assert.equal(requiresFullTests('push', docs, commit(), directory), false);
    assert.throws(() => readChanges('a'.repeat(40), docs, directory));
    git('reset', '--hard', docs);
    mkdirSync(path.join(directory, '.github', 'assets'), { recursive: true });
    writeFileSync(path.join(directory, '.github', 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = commit();
    assert.equal(requiresFullTests('pull_request', docs, image, directory), false);
    git('mv', '.github/assets/logo.png', '.github/assets/logo.gif');
    const renamedImage = commit();
    assert.equal(readChanges(image, renamedImage, directory).length, 2);
    assert.equal(requiresFullTests('push', image, renamedImage, directory), false);
    git('mv', '.github/assets/logo.gif', '.github/assets/runtime.mjs');
    const renamedCode = commit();
    assert.equal(requiresFullTests('pull_request', renamedImage, renamedCode, directory), true);
    git('mv', '.github/assets/runtime.mjs', '.github/assets/logo.png');
    assert.equal(requiresFullTests('pull_request', renamedCode, commit(), directory), true);
    const normalize = value => {
      const canonical = realpathSync.native(value);
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    };
    assert.equal(normalize(git('rev-parse', '--show-toplevel')), normalize(directory));
    assert.equal(git('show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD'), 'CI fixture\nci-fixture@example.invalid\nCI fixture\nci-fixture@example.invalid');
}

function fixtureEnvironment(directory, inherited) {
  const env = { ...inherited };
  // No Git configuration, repository path, index, template, hook or identity
  // from a caller is relevant to these synthetic, network-free repositories.
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(directory, 'empty-global-config'),
    GIT_AUTHOR_NAME: 'CI fixture',
    GIT_COMMITTER_NAME: 'CI fixture',
    GIT_AUTHOR_EMAIL: 'ci-fixture@example.invalid',
    GIT_COMMITTER_EMAIL: 'ci-fixture@example.invalid',
  };
}

function runIsolatedGitFixture({ poison = false } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prnext-ci-scope-'));
  try {
    const directory = path.join(scratch, 'repository');
    mkdirSync(directory);
    writeFileSync(path.join(scratch, 'empty-global-config'), '');
    const inherited = { ...process.env };
    if (poison) Object.assign(inherited, {
      GIT_DIR: path.join(scratch, 'wrong-git-dir'),
      GIT_WORK_TREE: path.join(scratch, 'wrong-worktree'),
      GIT_COMMON_DIR: path.join(scratch, 'wrong-common-dir'),
      GIT_INDEX_FILE: path.join(scratch, 'wrong-index'),
      GIT_OBJECT_DIRECTORY: path.join(scratch, 'wrong-objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_PARAMETERS: 'invalid inherited configuration',
      GIT_AUTHOR_NAME: 'Wrong inherited author',
      GIT_COMMITTER_NAME: 'Wrong inherited committer',
      GIT_AUTHOR_EMAIL: 'wrong-author@example.invalid',
      GIT_COMMITTER_EMAIL: 'wrong-committer@example.invalid',
    });
    const env = fixtureEnvironment(scratch, inherited);
    const runner = path.join(scratch, 'fixture-runner.mjs');
    writeFileSync(runner, [
      "import assert from 'node:assert/strict';",
      "import {execFileSync} from 'node:child_process';",
      "import {mkdirSync,realpathSync,writeFileSync} from 'node:fs';",
      "import path from 'node:path';",
      `import {readChanges,requiresFullTests} from ${JSON.stringify(new URL('./ci-scope.mjs', import.meta.url).href)};`,
      `(${exerciseGitDiff.toString()})(${JSON.stringify(directory)});`,
    ].join('\n'));
    execFileSync(process.execPath, [runner], {
      cwd: directory, env, encoding: 'utf8', timeout: 30000,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

test('the complete Git diff includes earlier code changes, deletions and renamed files', () => {
  runIsolatedGitFixture();
});

test('Git fixtures ignore caller repository, config, index and commit identities', () => {
  runIsolatedGitFixture({ poison: true });
});

test('the scope CLI executes through a directory alias and preserves failures', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'prnext-ci-scope-alias-'));
  try {
    const actual = path.join(scratch, 'actual');
    const alias = path.join(scratch, 'alias');
    mkdirSync(actual);
    copyFileSync(new URL('./ci-scope.mjs', import.meta.url), path.join(actual, 'ci-scope.mjs'));
    symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const output = path.join(actual, 'scope-output');
    const options = {
      cwd: alias,
      env: { ...fixtureEnvironment(scratch, process.env), CI_EVENT: 'workflow_dispatch', GITHUB_OUTPUT: output },
      encoding: 'utf8', timeout: 10000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const stdout = execFileSync(process.execPath, [path.join(alias, 'ci-scope.mjs')], options);
    assert.match(stdout, /run the full platform matrix/);
    assert.equal(readFileSync(output, 'utf8'), 'full=true\n');
    assert.throws(() => execFileSync(process.execPath, [path.join(alias, 'ci-scope.mjs')], {
      ...options,
      env: { ...options.env, CI_EVENT: 'pull_request', CI_BASE_SHA: 'invalid', CI_HEAD_SHA: 'invalid' },
    }), error => error.status === 1 && /Expected full commit SHAs/.test(String(error.stderr)));
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
});
