import test from 'node:test';
import assert from 'node:assert/strict';
import { errorResponse } from './http.mjs';

test('bounded RSC admission reports HTTP 503 without exposing production details', t => {
  const logged = t.mock.method(console, 'error', () => {});
  const error = Object.assign(new Error('App Router RSC admission queue is full'), { statusCode: 503 });
  const response = errorResponse(error, true);
  assert.equal(response.status, 503);
  assert.equal(response.body.toString(), 'Service Unavailable');
  assert.equal(logged.mock.callCount(), 1, 'the overload remains observable');
});
