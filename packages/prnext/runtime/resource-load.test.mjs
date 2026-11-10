import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { createResourceMonitor, registerResourceWorker, recordResourceWorker, aggregateResourceLoad } from './resource-load.mjs';

test('load sampling observes both isolates without double-counting process RSS or retaining exited workers', () => {
  const worker = new EventEmitter(), messages = [];
  worker.postMessage = value => messages.push(value);
  registerResourceWorker(worker, () => true);
  recordResourceWorker(worker, { rss: 9999999, busy: .9, delayMs: 50, gc: .2 });
  const host = { rss: 123, busy: .1, delayMs: 2, gc: .01 };
  assert.deepEqual(aggregateResourceLoad(host), { rss: 123, busy: .9, delayMs: 50, gc: .2 });
  assert.deepEqual(messages, [{ type: 'resource-probe' }]);
  worker.emit('exit');
  assert.deepEqual(aggregateResourceLoad(host), host);
});

test('unresponsive active RSC is pressure, stale idle data expires, invalid values cannot enter the native frame', () => {
  const worker = new EventEmitter(); worker.postMessage = () => {};
  let active = true;
  registerResourceWorker(worker, () => active);
  const host = { rss: 100, busy: 0, delayMs: 0, gc: 0 }, now = performance.now();
  aggregateResourceLoad(host, now);
  assert.equal(aggregateResourceLoad(host, now + 2000).busy, 1);
  active = false;
  assert.deepEqual(aggregateResourceLoad(host, now + 4000), host);
  recordResourceWorker(worker, { busy: NaN, delayMs: 2, gc: 0 });
  assert.deepEqual(aggregateResourceLoad(host, now + 4000), host);
  worker.emit('exit');
});

test('monitor is bounded, reports real RSS only for the host, and disposes its observer and delay histogram', async () => {
  const host = createResourceMonitor({ memory: true }), isolate = createResourceMonitor();
  try {
    await delay(30);
    for (const monitor of [host, isolate]) {
      const sample = monitor.sample();
      assert.deepEqual(Object.keys(sample), ['rss', 'busy', 'delayMs', 'gc']);
      for (const value of Object.values(sample)) assert.ok(Number.isFinite(value) && value >= 0);
      assert.ok(sample.busy <= 1 && sample.gc <= 1 && sample.delayMs <= 60000);
      assert.ok(Buffer.byteLength(JSON.stringify({ type: 'load', busy: true, sample })) < 512);
    }
    assert.ok(host.sample().rss > 0);
    assert.equal(isolate.sample().rss, 0);
  } finally { host.close(); isolate.close(); }
});

test('production RSC responds to resource probes without treating them as application requests', async () => {
  const worker = new Worker(new URL('./rsc-worker.mjs', import.meta.url), {
    execArgv: ['--conditions=react-server'], env: { ...process.env, NODE_ENV: 'production', PRNEXT_WORKER_LOAD: '1' },
  });
  try {
    const sample = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RSC resource probe timed out')), 5000);
      const message = value => { if (value.type === 'resource-load') { clearTimeout(timer); worker.off('message', message); resolve(value.value); } };
      worker.on('message', message); worker.once('error', reject);
      worker.postMessage({ type: 'resource-probe' });
    });
    assert.equal(sample.rss, 0);
    assert.ok(Number.isFinite(sample.busy) && sample.busy >= 0 && sample.busy <= 1);
    await delay(25);
    assert.ok(worker.threadId > 0, 'the regular request listener must ignore the probe');
  } finally { await worker.terminate(); }
});
