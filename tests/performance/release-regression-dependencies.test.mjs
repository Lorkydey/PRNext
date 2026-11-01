import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRuntimeDependencies, assertMatchingRuntimeDependencies, validateRuntimeDependencies } from './release-regression-dependencies.mjs';

async function install(directory, name, source = 'throw new Error("Dependency code must not run during inventory");') {
  const root = path.join(directory, 'node_modules', name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version: name === 'scheduler' ? '0.28.0' : '19.3.1', main: 'index.cjs' }));
  await writeFile(path.join(root, 'index.cjs'), source);
  return root;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-perf-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = [path.join(root, 'baseline'), path.join(root, 'candidate')];
  for (const directory of directories) {
    await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), '{"private":true}');
    for (const name of ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler']) await install(directory, name);
  }
  return { root, directories };
}

test('runtime identity is independent of install path and does not execute dependency modules', async t => {
  const { directories } = await fixture(t);
  const [baseline, candidate] = await Promise.all(directories.map(verifyRuntimeDependencies));
  assert.equal(baseline.sha256, candidate.sha256);
  assertMatchingRuntimeDependencies(baseline, candidate);
  assert.equal(baseline.packages.length, 4);
  assert.ok(baseline.packages.every(value => value.files === 2 && value.bytes > 0));
  assert.match(baseline.scope, /other build and transitive dependencies are not certified/);
});

test('same-version runtime byte changes and missing dependency evidence cannot pass the comparison', async t => {
  const { directories } = await fixture(t), baseline = await verifyRuntimeDependencies(directories[0]);
  await writeFile(path.join(directories[1], 'node_modules/react/index.cjs'), 'module.exports = {different:true};');
  const candidate = await verifyRuntimeDependencies(directories[1]);
  assert.equal(baseline.packages[0].version, candidate.packages[0].version);
  assert.throws(() => assertMatchingRuntimeDependencies(baseline, candidate), /different installed/);
  assert.throws(() => validateRuntimeDependencies(undefined), /identities/);
  const altered = structuredClone(baseline); altered.packages[0].version = '19.3.2';
  assert.throws(() => validateRuntimeDependencies(altered), /identities/);
});

test('scheduler identity follows react-dom resolution rather than a shadowed project copy', async t => {
  const { directories } = await fixture(t);
  await install(path.join(directories[1], 'node_modules/react-dom'), 'scheduler', 'module.exports = "nested";');
  const [baseline, candidate] = await Promise.all(directories.map(verifyRuntimeDependencies));
  assert.notEqual(baseline.packages[3].sha256, candidate.packages[3].sha256);
  assert.throws(() => assertMatchingRuntimeDependencies(baseline, candidate), /different installed/);
});

test('inventory rejects runtime file links and oversized files before reading them', async t => {
  const { root, directories } = await fixture(t), react = path.join(directories[0], 'node_modules/react');
  const target = path.join(root, 'outside'); await mkdir(target);
  await symlink(target, path.join(react, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyRuntimeDependencies(directories[0]), /must not be linked/);
  await rm(path.join(react, 'linked'), { recursive: true });
  const large = path.join(react, 'oversized.cjs'); await writeFile(large, ''); await truncate(large, 64 * 1024 ** 2 + 1);
  await assert.rejects(verifyRuntimeDependencies(directories[0]), /bounded file or byte budget/);
});
