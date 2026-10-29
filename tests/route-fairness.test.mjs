import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fairnessFixture } from './route-fairness-fixture.mjs';

async function until(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

test('hot route flood leaves admission for a cold route in render and API pools', { timeout: 90000 }, async t => {
  const f = await fairnessFixture();
  const outstanding = [];
  try {
    // Render keeps all 28 live admissions: 8 executing, 20 awaiting headers,
    // plus 128 hot-pattern waiters. API keeps 64 active plus 128 waiters.
    for (const [kind, active, flood, turns] of [['render', 8, 160, 4], ['api', 64, 140, 2]]) {
      f.holdAgain();
      let rejected = 0, completed = 0;
      const prefix = kind === 'render' ? '/slow/' : '/api/slow/';
      const issueHot = id => {
        const promise = fetch(f.url + prefix + id, { signal: AbortSignal.timeout(25000) }).then(async response => {
          const text = await response.text();
          if (response.status === 503) {
            rejected++;
            assert.equal(response.headers.get('retry-after'), '1');
            assert.match(response.headers.get('cache-control'), /no-store/);
          } else {
            assert.equal(response.status, 200, text);
            completed++;
          }
        });
        outstanding.push(promise);
        // Surface errors through the awaited batch, including while its peers
        // are intentionally held at the coordinator.
        promise.catch(() => {});
      };
      for (let i = 0; i < active; i++) issueHot(`${kind}-active-${i}`);
      await until(() => f.held(kind) === active, `${kind} uses every execution slot`);
      for (let i = 0; i < flood; i++) issueHot(`${kind}-queued-${i}`);
      await until(() => rejected === 12, `${kind} hot-pattern overload is bounded`);
      // Flood requests have varying params, but share one route-pattern budget.
      assert.equal(completed, 0);
      let coldDone = false;
      const cold = fetch(f.url + (kind === 'render' ? '/fast' : '/api/fast'), { signal: AbortSignal.timeout(10000) }).then(async response => {
        assert.equal(response.status, 200, await response.text()); coldDone = true;
      });
      outstanding.push(cold);
      // Let the cold request reach the native queue before releasing a permit.
      await delay(100);
      // Render must earn a turn at each of two bounded stages (live and start);
      // API has just one. Each stage allows one older hot turn before cold.
      for (let turn = 0; turn < turns && !coldDone; turn++) {
        const started = f.events.filter(event => event.operation === 'hold' && event.kind === kind).length;
        f.releaseOne(kind);
        await until(() => coldDone || f.events.filter(event => event.operation === 'hold' && event.kind === kind).length > started,
          `${kind} next scheduled request starts`);
        // Let the newly admitted request enroll at the second scheduling stage.
        await delay(25);
      }
      await until(() => coldDone, `${kind} cold request progresses ahead of hot backlog`);
      assert.ok(completed <= turns, `${kind} drained ${completed} hot requests before cold`);
      assert.ok(f.held(kind) >= active - turns);
      t.diagnostic(`${kind}: ${active} active hot requests, ${flood} more submitted, ${rejected} bounded rejections; cold200 after ${completed} hot completions`);
      f.releaseAll();
      await Promise.all(outstanding);
      outstanding.length = 0;
    }
  } finally { f.releaseAll(); await Promise.allSettled(outstanding); await f.close(); }
});
