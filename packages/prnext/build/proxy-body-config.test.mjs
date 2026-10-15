import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectConfig } from './config.mjs';

test('Proxy body clone size supports Next byte and unit values with an explicit transport ceiling', () => {
  const normalize = value => validateProjectConfig({ experimental: { proxyClientMaxBodySize: value } }).experimental.proxyClientMaxBodySize;
  assert.equal(normalize(undefined), 10 * 1024 * 1024);
  assert.equal(normalize('25mb'), 25 * 1024 * 1024);
  assert.equal(normalize('1.5 KB'), 1536);
  assert.equal(normalize(32 * 1024 * 1024), 32 * 1024 * 1024);
  for (const value of [null, 0, -1, Infinity, 1.5, '0.5b', '1gb', 'unlimited', '25MiB', {}, true]) assert.throws(() => normalize(value), /proxyClientMaxBodySize/);
});
