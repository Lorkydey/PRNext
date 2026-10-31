import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { referenceFixture } from './fixture.mjs';

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
