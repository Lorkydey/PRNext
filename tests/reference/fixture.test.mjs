import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { referenceFixture, closeReferenceFixtureServices } from './fixture.mjs';

test('a pending standalone copy cannot retain owned services during cleanup', async () => {
  let finishCopy;
  const copying = new Promise(resolve => { finishCopy = resolve; });
  const closed = [];
  const closing = closeReferenceFixtureServices(['proxy', 'server', 'postgres'].map(name => ({
    close: async () => { closed.push(name); },
  })), copying);
  let settled = false;
  void closing.then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(closed, ['proxy', 'server', 'postgres']);
    assert.equal(settled, false, 'Directory removal still has to wait for the copy.');
  } finally { finishCopy(); await closing; }
});

test('one service cleanup failure does not skip the remaining owned services', async () => {
  let stopped = false;
  await assert.rejects(closeReferenceFixtureServices([
    { close: async () => { throw new Error('injected proxy close failure'); } },
    { close: async () => { stopped = true; } },
  ]), error => error instanceof AggregateError && error.errors.length === 1);
  assert.equal(stopped, true);
});

test('diagnostic reuse refuses unrelated directories and nested consumers before installing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reference-unrelated-'));
  try {
    await assert.rejects(referenceFixture({ preparedRoot: root }), /Unexpected prepared reference consumer/);
    const nested = path.join(root, 'prnext-saas-consumer-nested');
    await mkdir(nested);
    await assert.rejects(referenceFixture({ preparedRoot: nested }), /Unexpected prepared reference consumer/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('diagnostic reuse never follows a consumer directory link', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-saas-consumer-owned-test-'));
  const alias = root + '-link';
  try {
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(referenceFixture({ preparedRoot: alias }), /Unexpected prepared reference consumer/);
  } finally { await rm(alias, { force: true }); await rm(root, { recursive: true, force: true }); }
});
