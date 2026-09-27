import test from 'node:test';
import assert from 'node:assert/strict';
import { PartialArtifactCache, partialIdentity } from './partial-artifact-cache.mjs';

test('memoized artifact parsing observes changed bytes and owns its buffer', () => {
  const cache = new PartialArtifactCache();
  const bytes = Buffer.from('{"flight":"old","postponed":{"slots":[1]}}');
  const first = cache.parse('route', bytes);
  assert.equal(cache.parse('route', Buffer.from(bytes)), first);
  bytes.fill(0); // RPC buffers must not be retained as mutable backing storage.
  assert.equal(cache.parse('route', Buffer.from('{"flight":"old","postponed":{"slots":[1]}}')), first);
  const next = cache.parse('route', Buffer.from('{"flight":"new"}'));
  assert.notEqual(next, first); assert.equal(next.flight, 'new');
  assert.notEqual(partialIdentity(first), partialIdentity(next));
  assert.throws(() => cache.parse('route', Buffer.from('invalid')), SyntaxError);
});

test('artifact parsing evicts by bytes and recency and bypasses oversized entries', () => {
  const cache = new PartialArtifactCache({ maxEntries: 2, maxBytes: 20, maxEntryBytes: 12 });
  const bytes = Buffer.from('{"a":1}');
  const a = cache.parse('a', bytes), b = cache.parse('b', bytes);
  assert.equal(cache.parse('a', bytes), a);
  cache.parse('c', bytes);
  assert.notEqual(cache.parse('b', bytes), b);
  assert.ok(cache.bytes <= 20); assert.ok(cache.entries.size <= 2);
  const large = Buffer.from('{"large":"value"}');
  assert.notEqual(cache.parse('large', large), cache.parse('large', large));
  assert.ok(!cache.entries.has('large'));
});
