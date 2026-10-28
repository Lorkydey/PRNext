import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityCache } from '../compat/activity-cache.cjs';

test('inactive layouts share a bounded eviction budget and active branches leave it', () => {
  const removed = [], cache = createActivityCache({ limit: 2 });
  cache.retain('a', () => removed.push('a')); cache.retain('b', () => removed.push('b'));
  cache.release('a'); cache.retain('c', () => removed.push('c')); cache.retain('d', () => removed.push('d'));
  assert.deepEqual(removed, ['b']); assert.equal(cache.size, 2);
  cache.clear(); assert.deepEqual(removed, ['b', 'c', 'd']); assert.equal(cache.size, 0);
});

test('expired inactive branches are removed without another navigation', () => {
  let time = 0, callback, removed = 0;
  const cache = createActivityCache({ ttl: 20, now: () => time, schedule: fn => { callback = fn; return 1; }, cancel() {} });
  cache.retain('page', () => removed++); time = 21; callback();
  assert.equal(cache.size, 0); assert.equal(removed, 1);
});
