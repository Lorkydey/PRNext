import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  cacheHit,
  metricRecord,
  recordMetric,
  validateMetric,
} from './ci-metrics.mjs';

test('exact cache output preserves blank/absent as unknown instead of a miss', () => {
  for (const value of [true, 'true']) assert.equal(cacheHit(value), true);
  for (const value of [false, 'false']) assert.equal(cacheHit(value), false);
  for (const value of ['', undefined, null, 'unknown'])
    assert.equal(cacheHit(value), 'unknown');
  for (const value of ['TRUE', 'hit', 1, {}])
    assert.throws(() => cacheHit(value), /Cache hits/);
});

test('metric identity contains only selected safe environment fields', () => {
  const record = metricRecord(
    {
      suite: 'native',
      runner: 'ubuntu-24.04',
      shard: '1/2',
      caches: { npm: 'true', rust: '' },
    },
    {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'native',
      GITHUB_TOKEN: 'DO_NOT_PERSIST',
      UNRELATED_SECRET: 'DO_NOT_PERSIST',
    },
  );
  assert.deepEqual(record.caches, { npm: true, rust: 'unknown' });
  assert.equal(record.runId, '42');
  assert.equal(record.runAttempt, 2);
  assert.doesNotMatch(
    JSON.stringify(record),
    /DO_NOT_PERSIST|GITHUB_TOKEN|UNRELATED/,
  );
  assert.deepEqual(validateMetric(record), record);
  assert.throws(() => metricRecord({ suite: 'bad\nname' }), /identifier/);
  assert.throws(() => validateMetric({ ...record, caches: [] }), /Unsupported/);
});

test('metric CLI accepts suite/shard/cache flags, creates one immutable JSON and rejects duplicate options', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prnext-ci-metrics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'nested', 'linux-unit-1.json');
  const args = [
    'record',
    '--suite',
    'unit-and-types',
    '--runner',
    'Linux',
    '--shard',
    '1/3',
    '--cache',
    'npm=',
    '--output',
    output,
  ];
  await recordMetric(args, { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' });
  const record = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(record.suite, 'unit-and-types');
  assert.equal(record.shard, '1/3');
  assert.equal(record.caches.npm, 'unknown');
  await assert.rejects(
    recordMetric(args, {}),
    (error) => error.code === 'EEXIST',
  );
  await assert.rejects(
    recordMetric([
      '--suite',
      'unit',
      '--cache',
      'npm=true',
      '--cache',
      'npm=false',
    ]),
    /Duplicate/,
  );
  await assert.rejects(
    recordMetric(['--suite', 'unit', '--output']),
    /Use record/,
  );
});

test('metrics CLI entry runs through a directory symlink or junction and reports invalid arguments', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'prnext-ci-metrics-alias-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'scripts alias');
  await symlink(
    fileURLToPath(new URL('.', import.meta.url)),
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const env = { ...process.env, GITHUB_TOKEN: '' };
  delete env.NODE_TEST_CONTEXT;
  const script = path.join(alias, 'ci-metrics.mjs');
  const invalid = spawnSync(process.execPath, [script, 'record', '--suite'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /Use record --suite/);
  const output = path.join(directory, 'record.json');
  const valid = spawnSync(
    process.execPath,
    [
      script,
      'record',
      '--suite',
      'native',
      '--cache',
      'rust=true',
      '--output',
      output,
    ],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /CI cache metric recorded/);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).caches.rust, true);
});
