import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeSvgBackend } from './og-backend.mjs';

test('OG rendering falls back when optional native librsvg is unpatched or unknown', () => {
  for (const rsvg of [undefined, '', '2.63.1', '2.62.9', '2.63.2-beta.1', 'unknown']) {
    assert.equal(safeSvgBackend({ versions: { rsvg } }), false, String(rsvg));
  }
  assert.equal(safeSvgBackend(undefined), false);
  for (const rsvg of ['2.63.2', '2.63.3', '2.64.0', '3.0.0']) {
    assert.equal(safeSvgBackend({ versions: { rsvg } }), true, rsvg);
  }
});
