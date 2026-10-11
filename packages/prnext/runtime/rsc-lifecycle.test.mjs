import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRscLifecycle } from './rsc-lifecycle.mjs';

test('cooperative cancellation bursts pause admission and preserve unrelated leases', async () => {
  let retired = 0;
  const gate = createRscLifecycle(() => { retired++; }, { cancellationLimit: 2 });
  const survivor = await gate.acquire();
  const cancelled = await Promise.all(Array.from({ length: 32 }, () => gate.acquire()));
  for (const token of cancelled) { token.cancel(); token.cancel(); }
  assert.equal(gate.stats.cancelled, 32);
  let admitted = false;
  const pending = gate.acquire().then(token => { admitted = true; return token; });
  await delay(10);
  assert.equal(admitted, false);
  for (const token of cancelled) { token.release(); token.release(); }
  const next = await pending;
  assert.equal(retired, 0);
  assert.deepEqual(gate.stats, { active: 2, cancelled: 0, waiting: 0, closed: false });
  survivor.release(); next.release(); gate.close();
});

test('queue and active counts are bounded and aborted/timed-out waiters release listeners', async () => {
  const gate = createRscLifecycle(() => {}, { maxActive: 1, maxWaiters: 2 });
  const active = await gate.acquire();
  const controller = new AbortController(), reason = new Error('HTTP caller left');
  const before = getEventListeners(controller.signal, 'abort').length;
  const aborted = gate.acquire({ signal: controller.signal, timeoutMs: 1000 });
  const timedOut = gate.acquire({ timeoutMs: 25 });
  const checks = [assert.rejects(aborted, error => error === reason), assert.rejects(timedOut, error => error.statusCode === 504)];
  assert.deepEqual(gate.stats, { active: 1, cancelled: 0, waiting: 2, closed: false });
  await assert.rejects(gate.acquire(), error => error.statusCode === 503);
  controller.abort(reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
  await Promise.all(checks);
  assert.equal(gate.stats.waiting, 0);
  active.release();
  await assert.rejects(gate.acquire({ signal: controller.signal }), error => error === reason);
  assert.equal(gate.stats.active, 0);
  gate.close();
});

test('an explicit hard-deadline retirement runs once and rejects queued admissions', async () => {
  let retired = 0;
  const gate = createRscLifecycle(async () => { retired++; await delay(10); }, { cancellationLimit: 1 });
  assert.equal(gate.retiring, null);
  assert.equal(gate.closed, false);
  const active = await gate.acquire(); active.cancel();
  const waiting = gate.acquire();
  const reason = new Error('request hard deadline reached');
  const rejected = assert.rejects(waiting, error => error === reason);
  const first = gate.terminate(reason), second = gate.terminate();
  assert.equal(first, second);
  assert.equal(first, gate.retiring);
  assert.equal(gate.closed, true);
  await Promise.all([first, second]);
  await rejected;
  assert.equal(retired, 1);
  await assert.rejects(gate.acquire(), error => error === reason);
  active.release();
  assert.deepEqual(gate.stats, { active: 0, cancelled: 0, waiting: 0, closed: true });
});

test('closing cancels queued listeners without requesting another retirement', async () => {
  let retired = 0;
  const gate = createRscLifecycle(() => { retired++; }, { cancellationLimit: 1 });
  const active = await gate.acquire(); active.cancel();
  const controller = new AbortController();
  const waiting = gate.acquire({ signal: controller.signal });
  const reason = new Error('worker exited');
  const checked = assert.rejects(waiting, error => error === reason);
  gate.close(reason);
  await checked;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(retired, 0);
  active.release();
});

test('cancellation pressure lets legitimate work outlive a short settlement grace', async () => {
  let retired = 0;
  const gate = createRscLifecycle(() => { retired++; });
  const survivor = await gate.acquire();
  const cancelled = await Promise.all(Array.from({ length: 16 }, () => gate.acquire()));
  for (const token of cancelled) token.cancel();
  let admitted = false;
  const waiting = gate.acquire({ timeoutMs: 3000 }).then(token => { admitted = true; return token; });
  // Slow actions/cache writes are still legitimate after a disconnected caller.
  await delay(1100);
  assert.equal(retired, 0);
  assert.equal(gate.closed, false);
  assert.equal(admitted, false);
  assert.deepEqual(gate.stats, { active: 17, cancelled: 16, waiting: 1, closed: false });
  for (const token of cancelled) token.release();
  const next = await waiting;
  survivor.release(); next.release(); gate.close();
  assert.equal(retired, 0);
});

test('late timer delivery cannot admit a request after its original queue deadline', async () => {
  const gate = createRscLifecycle(() => {}, { maxActive: 1 });
  const active = await gate.acquire();
  const waiting = gate.acquire({ timeoutMs: 10 });
  const rejected = assert.rejects(waiting, error => error.statusCode === 504);
  // Delay timers on purpose: release must check the monotonic deadline itself.
  const resumeAt = performance.now() + 20;
  while (performance.now() < resumeAt) {}
  active.release();
  await rejected;
  assert.deepEqual(gate.stats, { active: 0, cancelled: 0, waiting: 0, closed: false });
  gate.close();
});

test('retirement waiting stays bounded and releases aborted and expired caller resources', async () => {
  let finish;
  const gate = createRscLifecycle(() => new Promise(resolve => { finish = resolve; }), { maxWaiters: 2 });
  const retired = gate.terminate();
  const controller = new AbortController(), reason = new Error('left during retirement');
  const aborted = assert.rejects(gate.waitForRetirement({ signal: controller.signal }), error => error === reason);
  const expired = assert.rejects(gate.waitForRetirement({ timeoutMs: 15 }), error => error.statusCode === 504);
  assert.equal(gate.stats.waiting, 2);
  await assert.rejects(gate.waitForRetirement(), error => error.statusCode === 503);
  controller.abort(reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await Promise.all([aborted, expired]);
  assert.equal(gate.stats.waiting, 0);
  const waiting = gate.waitForRetirement();
  finish();
  await Promise.all([retired, waiting]);
  assert.equal(gate.stats.waiting, 0);
  await gate.waitForRetirement();
});

test('retirement failures propagate to current and subsequent replacement waiters', async () => {
  const reason = new Error('isolate termination failed');
  const gate = createRscLifecycle(() => { throw reason; });
  const retired = assert.rejects(gate.terminate(), error => error === reason);
  const waiting = assert.rejects(gate.waitForRetirement(), error => error === reason);
  await Promise.all([retired, waiting]);
  assert.equal(gate.stats.waiting, 0);
  await assert.rejects(gate.waitForRetirement(), error => error === reason);
});
