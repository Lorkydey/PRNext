import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeCache, cacheLife, cacheTag } from '../compat/use-cache.cjs';
import { profiles, validateLife } from '../compat/cache-life.cjs';
import { runRequestContext, cookies, headers } from '../compat/headers.cjs';
import { currentCacheScope } from '../compat/data-cache.cjs';

test('cache lifetime profiles validate values and cache scopes reject accidental use outside cached functions', () => {
  const configuration = profiles({ small: { stale: 0, revalidate: 1, expire: 2 } });
  assert.deepEqual(configuration.small, { stale: 0, revalidate: 1, expire: 2 });
  assert.equal(configuration.max.expire, 31536000);
  for (const value of [null, {}, { expire: -1 }, { revalidate: Infinity }, { revalidate: 2, expire: 1 }, { typo: 1 }]) assert.throws(() => validateLife(value));
  assert.throws(() => cacheTag('outside'), /inside a 'use cache'/);
  assert.throws(() => cacheLife('minutes'), /inside a 'use cache'/);
});

test('private cache coalesces inside one request, isolates requests and validates scope and serializable data', async () => {
  let calls = 0;
  for (const tenant of ['one', 'two']) await runRequestContext({ url: 'http://test/', headers: { cookie: `tenant=${tenant}` }, cacheLife: profiles() }, async () => {
    const callback = async () => {
      calls++;
      cacheLife({ revalidate: 10, expire: 20 });
      cacheLife({ revalidate: 5 });
      cacheTag('private');
      assert.equal(currentCacheScope().life.revalidate, 5);
      return { tenant: (await cookies()).get('tenant').value, date: new Date(0), map: new Map([['answer', 42n]]) };
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => invokeCache('one', 'private', [], [], callback)));
    assert.equal(results[0].tenant, tenant);
    assert.equal(results[0].map.get('answer'), 42n);
    assert.equal(results[0].date.getTime(), 0);
    await assert.rejects(invokeCache('class', 'private', [], [new URL('http://test')], callback), /class instances/);
    await assert.rejects(invokeCache('headers', 'default', [], [], async () => (await headers()).get('authorization')), /inside/);
    await assert.rejects(invokeCache('public-parent', 'default', [], [], () => invokeCache('private-child', 'private', [], [], callback)), /cannot be nested inside a shared cache/);
    await assert.rejects(invokeCache('taglimit', 'default', [], [], async () => { cacheTag(...Array.from({ length: 129 }, (_, i) => String(i))); }), /128/);
    await invokeCache('tag-dedup', 'private', [], [], async () => {
      cacheTag(...Array.from({ length: 128 }, (_, i) => String(i)));
      cacheTag('0');
      assert.equal(currentCacheScope().tags.size, 128);
      return true;
    });
  });
  assert.equal(calls, 2);
});
