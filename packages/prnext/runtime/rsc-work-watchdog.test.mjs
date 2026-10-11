import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createRscWorkWatchdog } from './rsc-work-watchdog.mjs';

test('one watchdog preserves long responsive work and has no timer at true idle', async () => {
  let probes = 0, retired = 0;
  const watchdog = createRscWorkWatchdog({ intervalMs: 5, timeoutMs: 30,
    probe(token) { probes++; watchdog.ack(token); }, retire() { retired++; } });
  assert.deepEqual(watchdog.stats, { work: 0, scheduled: false, awaitingAck: false, closed: false });
  await delay(15);
  assert.equal(probes, 0);
  const first = watchdog.add(), second = watchdog.add();
  await delay(90);
  assert.ok(probes >= 2);
  assert.equal(retired, 0, 'responsive cache work may outlive multiple probe deadlines');
  first(); first();
  assert.equal(watchdog.stats.work, 1);
  second(); second();
  assert.deepEqual(watchdog.stats, { work: 0, scheduled: false, awaitingAck: false, closed: false });
  const completedProbes = probes;
  await delay(40);
  assert.equal(probes, completedProbes);
  watchdog.close();
});

test('an unresponsive isolate is retired once and all watchdog timers are cleared', async () => {
  let probes = 0;
  const failures = [];
  const watchdog = createRscWorkWatchdog({ intervalMs: 5, timeoutMs: 15,
    probe() { probes++; }, retire(error) { failures.push(error); } });
  const first = watchdog.add(), second = watchdog.add();
  await delay(60);
  assert.equal(probes, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /did not acknowledge/);
  assert.deepEqual(watchdog.stats, { work: 0, scheduled: false, awaitingAck: false, closed: true });
  first(); second(); watchdog.add()(); watchdog.close();
  await delay(25);
  assert.equal(failures.length, 1);
});

test('a stale acknowledgement cannot release a newer probe deadline', async () => {
  const tokens = [];
  let retired = 0;
  const watchdog = createRscWorkWatchdog({ intervalMs: 5, timeoutMs: 25,
    probe(token) { tokens.push(token); }, retire() { retired++; } });
  const first = watchdog.add();
  await delay(10);
  assert.equal(tokens.length, 1);
  first();
  const second = watchdog.add();
  await delay(10);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  watchdog.ack(tokens[0]);
  assert.equal(watchdog.stats.awaitingAck, true);
  await delay(40);
  assert.equal(retired, 1);
  second();
});

test('closing or releasing the last work item cancels an outstanding probe', async () => {
  let retired = 0;
  const watchdog = createRscWorkWatchdog({ intervalMs: 5, timeoutMs: 15, probe() {}, retire() { retired++; } });
  const release = watchdog.add();
  await delay(10);
  assert.equal(watchdog.stats.awaitingAck, true);
  watchdog.close(); release();
  assert.deepEqual(watchdog.stats, { work: 0, scheduled: false, awaitingAck: false, closed: true });
  await delay(30);
  assert.equal(retired, 0);
});

test('a failed probe retires once with its original error', async () => {
  for (const asynchronous of [false, true]) {
    const failure = new Error('probe transport failed');
    const failures = [];
    const watchdog = createRscWorkWatchdog({ intervalMs: 5, timeoutMs: 20,
      probe() { if (asynchronous) return Promise.reject(failure); throw failure; },
      retire(error) { failures.push(error); } });
    const release = watchdog.add();
    await delay(40);
    assert.deepEqual(failures, [failure]);
    assert.equal(watchdog.stats.scheduled, false);
    release(); watchdog.close();
  }
});

test('a real isolate survives short synchronous work and terminates after a blocked probe', async () => {
  const worker = new Worker(`
    const {parentPort}=require('node:worker_threads');
    const pause=new Int32Array(new SharedArrayBuffer(4));
    parentPort.on('message',message=>{
      if(message.type==='block'){parentPort.postMessage({type:'blocked'});while(true){}}
      if(message.type==='probe'){
        Atomics.wait(pause,0,0,30);
        parentPort.postMessage({type:'ack',token:message.token});
      }
    });
    parentPort.postMessage({type:'ready'});
  `, { eval: true });
  let retired = 0, acknowledgements = 0, finishResponsive, finishRetired;
  const responsive = new Promise(resolve => { finishResponsive = resolve; });
  const terminated = new Promise(resolve => { finishRetired = resolve; });
  const watchdog = createRscWorkWatchdog({ intervalMs: 10, timeoutMs: 100,
    probe: token => worker.postMessage({ type: 'probe', token }),
    retire: async () => { retired++; await worker.terminate(); finishRetired(); },
  });
  let release, guard;
  try {
    assert.equal((await once(worker, 'message'))[0].type, 'ready');
    worker.on('message', message => {
      if (message.type !== 'ack') return;
      watchdog.ack(message.token);
      if (++acknowledgements >= 3) finishResponsive();
    });
    release = watchdog.add();
    const timeout = new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('real isolate watchdog test exceeded its budget')), 3000); });
    await Promise.race([responsive, timeout]);
    assert.equal(retired, 0, 'short synchronous foreground work retains its response budget');
    worker.postMessage({ type: 'block' });
    await Promise.race([terminated, timeout]);
    assert.equal(retired, 1);
    assert.equal(worker.threadId, -1, 'retirement resolves only after the real isolate exits');
    assert.deepEqual(watchdog.stats, { work: 0, scheduled: false, awaitingAck: false, closed: true });
  } finally {
    clearTimeout(guard);
    release?.(); watchdog.close();
    await worker.terminate();
  }
});
