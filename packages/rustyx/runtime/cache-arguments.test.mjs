import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCacheArguments } from './cache-arguments.mjs';

test('cache argument framing distinguishes fields and enforces budgets before copying blobs', async () => {
  let copies = 0;
  const blob = { size: 1024 * 1024, type: 'image/png', name: 'large', async arrayBuffer() { copies++; throw new Error('must not copy'); } };
  await assert.rejects(encodeCacheArguments([['a', blob], ['b', blob]]), /2 MiB/);
  assert.equal(copies, 0);
  await assert.rejects(encodeCacheArguments('é'.repeat(1024 * 1024 + 1)), /2 MiB/);
  const first = new FormData(); first.append('one', 'value'); first.append('binary', new Blob(['bytes']), 'file');
  const second = new FormData(); second.append('one', 'value'); second.append('binary', new Blob(['bytes']), 'other-file');
  assert.notDeepEqual(await encodeCacheArguments(first), await encodeCacheArguments(second));
  assert.deepEqual(await encodeCacheArguments(first), await encodeCacheArguments(first));
});
