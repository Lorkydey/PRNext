import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyNodeRuntime, validateNodeRuntime, validateRuntimeComparisonArtifacts, validateSampleNodeRuntime, nodeDependencyGraph } from './node-runtime.mjs';

const descriptor = (name = 'node24', version = 'v24.22.1') => ({ executable: path.resolve(name), version, sha256: '1'.repeat(64) });
const artifacts = () => {
  const original = { source: { declaredCommit: 'a'.repeat(40) }, binarySha256: 'b'.repeat(64), archives: [{ name: 'framework', sha256: 'c'.repeat(64) }], nodeDependencyGraphSha256: 'd'.repeat(64) };
  return { baseline: { ...structuredClone(original), nodeRuntime: descriptor() }, candidate: { ...structuredClone(original), nodeRuntime: descriptor('node26', 'v26.13.0') } };
};

test('runtime declarations require an exact absolute executable/version/digest without unknown options', () => {
  assert.equal(validateNodeRuntime(descriptor()).version, 'v24.22.1');
  for (const change of [{ executable: 'node' }, { version: '26' }, { sha256: 'bad' }, { options: '--inspect' }]) assert.throws(() => validateNodeRuntime({ ...descriptor(), ...change }));
});

test('runtime bytes are bound before any version command and the command receives no Node preloads', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-node-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requestedFile = path.join(directory, 'node'), bytes = Buffer.from('private non-executable fixture');
  await writeFile(requestedFile, bytes);
  const file = await realpath(requestedFile);
  const spec = { executable: file, version: 'v26.13.0', sha256: createHash('sha256').update(bytes).digest('hex') };
  let calls = 0;
  const run = async (command, args, options) => { calls++; assert.equal(command, file); assert.deepEqual(args, ['--version']); assert.equal(options.timeout, 10000); assert.equal(options.env.NODE_OPTIONS, undefined); return { stdout: 'v26.13.0\n' }; };
  assert.deepEqual(await verifyNodeRuntime(spec, { run }), spec); assert.equal(calls, 1);
  await assert.rejects(verifyNodeRuntime({ ...spec, sha256: '0'.repeat(64) }, { run }), /SHA-256/); assert.equal(calls, 1);
  await assert.rejects(verifyNodeRuntime(spec, { run: async () => ({ stdout: 'v24.22.1\n' }) }), /version differs/);
});

test('runtime comparisons keep source, framework/native bytes and the complete lock graph equal', () => {
  assert.equal(validateRuntimeComparisonArtifacts({ baseline: {}, candidate: {} }), false);
  assert.equal(validateRuntimeComparisonArtifacts(artifacts()), true);
  for (const field of ['binarySha256', 'nodeDependencyGraphSha256', 'source', 'archives']) {
    const value = artifacts(); value.candidate[field] = field === 'source' ? { declaredCommit: 'f'.repeat(40) } : field === 'archives' ? [] : 'f'.repeat(64);
    assert.throws(() => validateRuntimeComparisonArtifacts(value));
  }
  const half = artifacts(); delete half.candidate.nodeRuntime;
  assert.throws(() => validateRuntimeComparisonArtifacts(half), /both variants/);
});

test('the gate binds every server window to its variant and refuses undeclared Node substitutions', () => {
  const value = artifacts();
  assert.doesNotThrow(() => validateSampleNodeRuntime(value, 'candidate', { serverNodeRuntime: value.candidate.nodeRuntime }));
  assert.throws(() => validateSampleNodeRuntime(value, 'candidate', { serverNodeRuntime: value.baseline.nodeRuntime }));
  assert.throws(() => validateSampleNodeRuntime({ baseline: {} }, 'baseline', { serverNodeRuntime: descriptor() }));
});

test('lock comparison normalizes only the two bound local archives and consumer-root metadata', () => {
  const root = path.resolve('owned-fixture'), file = path.join(root, 'framework.tgz');
  const lock = { lockfileVersion: 3, packages: { '': { name: 'baseline' }, 'node_modules/framework': { version: '0.1.21-alpha', resolved: 'file:framework.tgz', integrity: 'sha512-a' }, 'node_modules/dependency': { version: '1.2.3', resolved: 'https://registry.npmjs.org/dependency/-/dependency-1.2.3.tgz', integrity: 'sha512-b' } } };
  const archives = [{ file, sha256: 'a'.repeat(64) }];
  const before = nodeDependencyGraph(lock, root, archives), same = structuredClone(lock); same.packages[''].name = 'candidate';
  assert.equal(nodeDependencyGraph(same, root, archives), before);
  same.packages[''].dependencies = { extra: '1.0.0' };
  assert.notEqual(nodeDependencyGraph(same, root, archives), before);
  delete same.packages[''].dependencies;
  same.packages['node_modules/dependency'].integrity = 'sha512-other';
  assert.notEqual(nodeDependencyGraph(same, root, archives), before);
  assert.throws(() => nodeDependencyGraph(lock, root, []), /Unbound local/);
  assert.throws(() => nodeDependencyGraph({ lockfileVersion: 3, packages: {} }, root, archives), /Empty/);
});
