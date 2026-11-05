import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServerConfig } from './server-config.mjs';

test('public server origins normalize while proxy trust stays explicit', () => {
  assert.deepEqual(validateServerConfig(), { trustedProxies: [] });
  assert.deepEqual(validateServerConfig({ publicOrigin: 'https://EXAMPLE.com:443/', trustedProxies: ['127.0.0.1', '::1/128', '10.0.0.0/8', '127.0.0.1'] }), { publicOrigin: 'https://example.com', trustedProxies: ['127.0.0.1', '::1/128', '10.0.0.0/8'] });
  for (const publicOrigin of ['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?', 'https://example.com#', 'https://example.com/?x=1', 'ftp://example.com', ' https://example.com', 'https:\\example.com', '', null, 123]) assert.throws(() => validateServerConfig({publicOrigin}));
  for (const trustedProxies of [true, '*', ['*'], ['localhost'], ['127.0.0.1/33'], ['::1/129'], ['::1/-1'], ['127.0.0.1/01'], ['127.0.0.1/8/2'], Array(33).fill('::1')]) assert.throws(() => validateServerConfig({trustedProxies}));
  assert.throws(() => validateServerConfig({trustProxy:true}));
  assert.deepEqual(validateServerConfig({trustedProxies:['::ffff:127.0.0.1/128', '::ffff:192.0.2.1/120']}), {trustedProxies:['127.0.0.1/32', '192.0.2.1/24']});
  assert.throws(() => validateServerConfig({trustedProxies:['::ffff:127.0.0.1/95']}));
});
