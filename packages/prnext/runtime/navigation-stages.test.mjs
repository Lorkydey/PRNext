import test from 'node:test';
import assert from 'node:assert/strict';
import { navigation, prefetch } from '../compat/navigation-stages.cjs';
import { runRequestContext } from '../compat/headers.cjs';
import { runCacheScope } from '../compat/data-cache.cjs';
import { dynamicUsage } from '../compat/static-generation.cjs';

test('navigation stages preserve static work and defer only the selected runtime subtree', async () => {
  for (const name of ['shell', 'prefetch', undefined]) {
    await runRequestContext({ cacheComponents: true, partialPrefetching: true, navigationStage: name }, async () => {
      if (name) await assert.rejects(navigation(), { code: 'PRNEXT_PPR_DYNAMIC' }); else await navigation();
      if (name === 'shell') await assert.rejects(prefetch(), { code: 'PRNEXT_PPR_DYNAMIC' }); else await prefetch();
    });
  }
  await runRequestContext({ cacheComponents: true, navigationStage: 'shell', staticGeneration: { mode: 'auto', partial: true } }, async () => {
    await navigation(); await prefetch();
  });
  await runRequestContext({ cacheComponents: true, partialPrefetching: false, navigationStage: 'shell' }, prefetch);
});

test('stage APIs reject disabled Cache Components and cached scopes with actionable errors', async () => {
  await assert.rejects(navigation(), /cacheComponents/);
  await runRequestContext({ cacheComponents: true }, () => runCacheScope(async () => {
    await assert.rejects(navigation(), /before invoking/); await assert.rejects(prefetch(), /before invoking/);
  }));
});

test('static stage requirements postpone request work only at their constrained stage', async () => {
  for (const level of ['shell', 'prefetch', 'navigation']) for (const stage of ['shell', 'prefetch', undefined]) {
    await runRequestContext({ navigationStage: stage, cacheConfig: { ensureStatic: level } }, () => {
      if (stage === 'shell' || stage === 'prefetch' && level !== 'shell') assert.throws(() => dynamicUsage('cookies()'), { code: 'PRNEXT_PPR_DYNAMIC' });
      else assert.equal(dynamicUsage('cookies()'), true);
    });
  }
});

test('speculation postpones uncached I/O but a cached scope may populate reusable data', async () => {
  await runRequestContext({ navigationStage: 'prefetch' }, async () => {
    assert.throws(() => dynamicUsage('an uncached fetch'), { code: 'PRNEXT_PPR_DYNAMIC' });
    assert.throws(() => dynamicUsage('connection()'), { code: 'PRNEXT_PPR_DYNAMIC' });
    await runCacheScope(() => assert.equal(dynamicUsage('an uncached fetch'), true));
    assert.equal(dynamicUsage('cookies()'), true);
  });
});
