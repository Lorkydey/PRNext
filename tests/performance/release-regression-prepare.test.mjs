import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepareReleaseComparison } from './release-regression-prepare.mjs';

async function fixture(t, { alias = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-performance-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'checkout'), target = path.join(root, 'prepared');
  await mkdir(workspace); await mkdir(target);
  const prepared = alias ? path.join(root, 'prepared-alias') : target;
  if (alias) await symlink(target, prepared, process.platform === 'win32' ? 'junction' : 'dir');
  const configuration = path.join(prepared, 'comparison.json'), output = path.join(workspace, 'receipt');
  const baselineSource = 'a'.repeat(40), candidateSource = 'b'.repeat(40);
  const source = JSON.stringify({ baseline: { directory: './baseline', archives: ['./baseline.tgz', './native18.tgz'], source: baselineSource }, candidate: { directory: './candidate', archives: ['./candidate.tgz', './native19.tgz'], source: candidateSource } });
  await writeFile(configuration, source);
  return { root, prepared, source, options: { configuration, output, workspace, baselineSource, candidateSource, expectedSha256: createHash('sha256').update(source).digest('hex') } };
}

test('reviewed config snapshot preserves canonical relative targets through aliases and records declared source labels', async t => {
  const { options, prepared, source } = await fixture(t, { alias: true }), file = await prepareReleaseComparison(options);
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  const canonicalPrepared = await realpath(prepared);
  assert.equal(snapshot.baseline.directory, path.join(canonicalPrepared, 'baseline'));
  assert.equal(snapshot.candidate.archives[0], path.join(canonicalPrepared, 'candidate.tgz'));
  assert.equal(await readFile(path.join(options.output, 'configuration-original.json'), 'utf8'), source);
  const receipt = JSON.parse(await readFile(path.join(options.output, 'preparation.json'), 'utf8'));
  assert.equal(receipt.sourceAssociationVerified, false);
  assert.equal(receipt.originalSha256, options.expectedSha256);
  await writeFile(options.configuration, '{}');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), snapshot);
  await assert.rejects(prepareReleaseComparison({ ...options, configuration: path.join(options.output, 'configuration-original.json') }), /outside the checkout/);
});

test('hash drift, label mismatch, shell text and reused output cannot launch a comparison', async t => {
  const { options } = await fixture(t);
  await assert.rejects(prepareReleaseComparison({ ...options, expectedSha256: '0'.repeat(64) }), /reviewed SHA/);
  await assert.rejects(prepareReleaseComparison({ ...options, candidateSource: 'c'.repeat(40) }), /labels/);
  await assert.rejects(prepareReleaseComparison({ ...options, baselineSource: '$(echo unsafe)' }), /explicit/);
  await prepareReleaseComparison(options);
  await assert.rejects(prepareReleaseComparison(options), { code: 'EEXIST' });
});

test('a configuration reached through an external link still cannot resolve inside checkout', async t => {
  const { options, prepared } = await fixture(t), inside = path.join(options.workspace, 'input');
  await mkdir(inside); await writeFile(path.join(inside, 'comparison.json'), '{}');
  const link = path.join(prepared, 'linked');
  await symlink(inside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareReleaseComparison({ ...options, configuration: path.join(link, 'comparison.json') }), /outside the checkout/);
});
