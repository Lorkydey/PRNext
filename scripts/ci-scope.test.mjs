import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentationOnly, readChanges, requiresFullTests } from './ci-scope.mjs';

const change = (name, oldMode = '100644', newMode = '100644') => ({ name, oldMode, newMode });

test('only explicitly listed documentation can skip the platform matrix', () => {
  assert.equal(documentationOnly([change('README.md'), change('packages/prnext/README.md')]), true);
  assert.equal(documentationOnly(['CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/assets/prnext-logo.svg'].map(name => change(name))), true);
  assert.equal(documentationOnly([change('CHANGELOG.md', '000000'), change('RELEASE.md', '100644', '000000')]), true);
  for (const name of ['package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/assets/runtime.js', '.github/assets/other.svg', 'src/server.rs', 'examples/app/README.md', 'tests/fixture.md', 'README.mdx', 'docs/new.md']) {
    assert.equal(documentationOnly([change('README.md'), change(name)]), false, name);
  }
  assert.equal(documentationOnly([]), false);
  assert.equal(documentationOnly([change('README.md', '100644', '120000')]), false);
  assert.equal(documentationOnly([change('README.md', '100644', '100755')]), false);
});

test('manual runs and initial pushes always run tests; invalid revisions fail closed', () => {
  assert.equal(requiresFullTests('workflow_dispatch'), true);
  assert.equal(requiresFullTests('push', '0'.repeat(40)), true);
  assert.equal(requiresFullTests('unknown'), true);
  assert.throws(() => requiresFullTests('pull_request', 'main', 'HEAD'), /full commit SHAs/);
});

test('the complete Git diff includes earlier code changes, deletions and renamed files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'prnext-ci-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // These synthetic local commits never leave the temporary test repository.
  const commit = () => { git('add', '-A'); git('-c', 'user.name=CI fixture', '-c', 'user.email=ci-fixture@example.invalid', 'commit', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
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
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
