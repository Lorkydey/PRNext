import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectConfig } from './config.mjs';
import { validateServerActions } from './server-actions-config.mjs';

test('Server Action options validate body budgets and host-only allowlists', () => {
  assert.equal(validateServerActions().bodySizeLimit, 1024 * 1024);
  assert.equal(validateServerActions({ bodySizeLimit: '2mb' }).bodySizeLimit, 2 * 1024 * 1024);
  assert.equal(validateServerActions({ bodySizeLimit: '1.5 kb' }).bodySizeLimit, 1536);
  assert.equal(validateServerActions({ bodySizeLimit: 1025 }).bodySizeLimit, 1025);
  for (const value of [0, -1, Infinity, 'no', '9mb', {}, 1.5]) assert.throws(() => validateServerActions({ bodySizeLimit: value }), /bodySizeLimit/);
  for (const origin of ['https://example.test', '*', '**', 'user@example.test', 'app-*.example.test', 'app.**.test', 'x.test:*', 'x.test:99999', 'x..test']) assert.throws(() => validateServerActions({ allowedOrigins: [origin] }), /allowedOrigins/);
  const config = validateProjectConfig({ experimental: { serverActions: { bodySizeLimit: '2mb', allowedOrigins: ['*.EXAMPLE.test', '**.example.test:8443', '[::1]:3000'] } } });
  assert.equal(config.experimental.serverActions.bodySizeLimit, 2097152);
  assert.equal(config.experimental.serverActions.allowedOrigins[0], '*.example.test');
  assert.throws(() => validateServerActions({ unknown: true }), /not implemented/);
});
