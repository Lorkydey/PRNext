import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCacheHandler, validateCacheHandlers } from './cache-handlers.mjs';
import { validateProjectConfig } from './config.mjs';
import { transformCacheComponents } from './cache-components.mjs';

test('cache handler names and paths are validated, and only configured custom directives compile', () => {
  const handlers = validateCacheHandlers({ remote: './redis.ts', analytics: './analytics.mjs', default: undefined });
  assert.equal(handlers.analytics, './analytics.mjs');
  assert.equal(Object.hasOwn(handlers, 'default'), false);
  for (const input of [null, [], { private: './x.js' }, { 'bad:name': './x.js' }, { remote: '' }, { remote: false }]) assert.throws(() => validateCacheHandlers(input));
  const options = { enabled: true, projectRoot: '/project', buildId: 'build', handlers };
  const source = `export async function data(){'use cache: analytics';return 42}`;
  assert.match(transformCacheComponents(source, '/project/data.js', options), /analytics/);
  assert.throws(() => transformCacheComponents(source, '/project/data.js', { ...options, handlers: {} }), /cacheHandlers.analytics/);
});

test('incremental cache options validate real module paths and bounded memory budgets', () => {
  assert.equal(validateCacheHandler('./legacy.ts'), './legacy.ts');
  assert.equal(validateCacheHandler(undefined), undefined);
  for (const value of [null, false, {}, '', 'x\0y']) assert.throws(() => validateCacheHandler(value));
  assert.equal(validateProjectConfig({ cacheHandler: './legacy.ts', cacheMaxMemorySize: 0 }).cacheMaxMemorySize, 0);
  for (const value of [-1, 0.5, Infinity, 1024 ** 3 + 1, '0']) assert.throws(() => validateProjectConfig({ cacheMaxMemorySize: value }));
});
