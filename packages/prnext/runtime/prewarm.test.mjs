import test from 'node:test';
import assert from 'node:assert/strict';
import {prewarmFramework} from './prewarm.mjs';

const options = {timeoutMs: 100, maxRssMb: 64};
const app = {router: 'app', kind: 'page', module: 'private-application.mjs'};
test('framework preparation visits framework modules once without importing application routes', async () => {
  const loaded = [], prepared = [];
  const result = await prewarmFramework({routes: [app, app, {kind: 'page'}, {kind: 'api'},
    {router: 'app', kind: 'page', cacheConfig: {runtime: 'edge'}}], options,
  load: async name => {loaded.push(name); return {prewarmAppRenderer: async value => prepared.push(value)};}
  }, {now: () => 0, rss: () => 0});
  assert.deepEqual(loaded, ['app-render', 'render', 'api']);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].timeoutMs, 100);
  assert.equal(result.ready, true);
  assert.deepEqual(result.loaded, loaded);
});
test('edge-only and worker-free manifests do not prepare Node renderers', async () => {
  for (const routes of [[], [{...app, cacheConfig: {runtime: 'edge'}}, {kind: 'api', handlerConfig: {runtime: 'edge'}}]]) {
    const result = await prewarmFramework({routes, options, load: () => assert.fail('unexpected framework import')}, {now: () => 0, rss: () => 0});
    assert.equal(result.ready, true);
    assert.deepEqual(result.loaded, []);
  }
});
test('RSS and cancellation budgets refuse work before the first import', async () => {
  for (const [rss, signal, reason] of [[64 * 1024 ** 2, undefined, 'rss'], [0, AbortSignal.abort(), 'cancelled']]) {
    const result = await prewarmFramework({routes: [app], options, signal, load: () => assert.fail('budget exceeded')}, {now: () => 0, rss: () => rss});
    assert.equal(result.ready, false);
    assert.equal(result.reason, reason);
  }
});
test('one absolute time/RSS budget covers module imports and renderer preparation', async () => {
  let time = 0, prepared = false;
  const result = await prewarmFramework({routes: [app, {kind: 'api'}], options,
    load: async name => {
      assert.equal(name, 'app-render'); time = 40;
      return {prewarmAppRenderer: async value => {assert.equal(value.timeoutMs, 60); prepared = true; time = 100;}};
    }}, {now: () => time, rss: () => 0});
  assert.equal(prepared, true);
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.durationMs, 100);
});
test('an over-budget import or a cancelled import cannot report renderer readiness', async () => {
  for (const cause of ['timeout', 'rss', 'cancelled']) {
    let time = 0, bytes = 0; const controller = new AbortController();
    const result = await prewarmFramework({routes: [app], options, signal: controller.signal,
      load: async () => {
        if (cause === 'timeout') time = 101;
        if (cause === 'rss') bytes = 65 * 1024 ** 2;
        if (cause === 'cancelled') controller.abort();
        return {prewarmAppRenderer: () => assert.fail('preparation admitted after budget')};
      }}, {now: () => time, rss: () => bytes});
    assert.equal(result.ready, false);
    assert.equal(result.reason, cause);
  }
});
test('imports fail visibly and invalid budgets never disable bounds', async () => {
  const failure = new Error('framework unavailable');
  await assert.rejects(prewarmFramework({routes: [app], options, load: async () => {throw failure;}}, {now: () => 0, rss: () => 0}), failure);
  for (const invalid of [{timeoutMs: NaN, maxRssMb: 64}, {timeoutMs: 100, maxRssMb: Infinity}, {timeoutMs: 0, maxRssMb: 64}]) {
    await assert.rejects(prewarmFramework({routes: [app], options: invalid, load: () => assert.fail('invalid budget')}), TypeError);
  }
});
