import test from 'node:test';
import assert from 'node:assert/strict';
import { paramsBySegment, selectedLayoutSegments } from './app-segments.mjs';

test('segment parsing keeps ancestor scope, catchalls, groups and layout offsets', () => {
  const segments = ['', '(shop)', '[tenant]', '@slot', '[[...slug]]'].map(segment => ({ segment }));
  const values = { tenant: 'alice', slug: ['x', 'y'], other: 'hidden' };
  assert.deepEqual([...paramsBySegment(segments, values).values()], [{}, {}, { tenant: 'alice' }, { tenant: 'alice' }, { tenant: 'alice', slug: ['x', 'y'] }]);
  assert.deepEqual(selectedLayoutSegments(segments, values), ['(shop)', 'alice', 'x/y']);
  assert.deepEqual(selectedLayoutSegments(segments, values, 3), ['x/y']);
  assert.deepEqual(selectedLayoutSegments(segments, {}), ['(shop)']);
});

test('segment syntax cache observes mutations/getters and does not share request values', () => {
  let value = '[id]', reads = 0;
  const segment = { get segment() { reads++; return value; } };
  assert.deepEqual(selectedLayoutSegments([segment], { id: 'alice' }), ['alice']);
  assert.deepEqual(selectedLayoutSegments([segment], { id: 'bob' }), ['bob']);
  value = '[other]';
  assert.deepEqual(selectedLayoutSegments([segment], { other: 'changed' }), ['changed']);
  assert.equal(reads, 3);
  const first = paramsBySegment([segment], { other: 'first' }).get(segment);
  first.other = 'mutated';
  assert.deepEqual(paramsBySegment([segment], { other: 'first' }).get(segment), { other: 'first' });
  assert.deepEqual(selectedLayoutSegments([, { segment: 'last' }]), ['last']);
});

test('special dynamic parameter names stay own values without changing prototypes', () => {
  const segments = [{ segment: '[__proto__]' }, { segment: '[constructor]' }];
  const params = JSON.parse('{"__proto__":"safe","constructor":"own"}');
  const scoped = paramsBySegment(segments, params).get(segments[1]);
  assert.equal(Object.getPrototypeOf(scoped), Object.prototype);
  assert.equal(Object.hasOwn(scoped, '__proto__'), true);
  assert.deepEqual(selectedLayoutSegments(segments, params), ['safe', 'own']);
});
