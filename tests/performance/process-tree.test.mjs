import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_PROCESS_PIDS, MAX_PROCESS_SAMPLES, parseLinuxProcessStat, parseMacProcessTable, selectProcessTree, processTreeObservation, linuxInspectionLimitations, observeProcessTree, summarizeProcessSamples, startProcessTreeSampling } from './process-tree.mjs';

const row = (pid, parent, overrides = {}) => ({ pid, parent, startId: String(pid * 100), cpuSeconds: 1, rssBytes: 1024, ...overrides });
const table = () => [row(20, 10), row(21, 20), row(22, 21), row(30, 10), { pid: 4, parent: 0, startId: null }];
const snapshot = (rows = table()) => processTreeObservation(20, rows, rows);

test('Linux stat parses CPU ticks, start identity and pages without retaining a process name', () => {
  const fields = Array(22).fill('0');
  Object.assign(fields, { 0: 'S', 1: '9', 11: '150', 12: '50', 19: '123456', 21: '3' });
  assert.deepEqual(parseLinuxProcessStat(`123 (private ) process name) ${fields.join(' ')}`, { clockTicks: 100, pageSize: 4096 }), { pid: 123, parent: 9, startId: '123456', cpuSeconds: 2, rssBytes: 12288 });
  assert.throws(() => parseLinuxProcessStat('123 malformed', { clockTicks: 100, pageSize: 4096 }));
  assert.throws(() => parseLinuxProcessStat(`123 (x) ${fields.join(' ')}`, { clockTicks: 0, pageSize: 4096 }));
});

test('macOS metadata parses day and minute CPU forms and rejects incomplete tables', () => {
  assert.deepEqual(parseMacProcessTable(' 0 0 Sat Oct 31 12:00:00 2026 00:00.00 10\n 123 9 Sat Oct 31 12:34:56 2026 2-01:02:03.50 20\n 124 123 Sat Oct 31 12:34:57 2026 01:02.50 10\n'), [
    { pid: 123, parent: 9, startId: 'Sat Oct 31 12:34:56 2026', cpuSeconds: 176523.5, rssBytes: 20480 },
    { pid: 124, parent: 123, startId: 'Sat Oct 31 12:34:57 2026', cpuSeconds: 62.5, rssBytes: 10240 },
  ]);
  assert.throws(() => parseMacProcessTable('123 9 invalid'));
  assert.throws(() => parseMacProcessTable(''));
});

test('owned ancestry excludes siblings and tolerates unavailable start metadata only outside the owned tree', () => {
  assert.deepEqual(selectProcessTree(table(), 20).map(value => value.pid), [20, 21, 22]);
  assert.throws(() => selectProcessTree([...table(), row(21, 20)], 20), /identity/);
  assert.throws(() => selectProcessTree(table(), 99), /not present/);
  assert.throws(() => selectProcessTree([row(20, 21), row(21, 20)], 20), /Cyclic/);
  assert.throws(() => selectProcessTree([row(20, 0, { startId: null })], 20), /Incomplete owned/);
  assert.throws(() => selectProcessTree([row(20, 0), row(21, 20, { startId: '100' })], 20), /reused/);
  assert.throws(() => selectProcessTree(Array.from({ length: MAX_PROCESS_PIDS + 1 }, (_, i) => row(i + 1, 0)), 20), /Incomplete/);
});

test('complete observations expose only owned counters and sum RSS without arguments or environments', () => {
  const observed = snapshot();
  assert.equal(observed.state, 'verified');
  assert.equal(observed.rssSumBytes, 3072);
  assert.equal(observed.cpuSeconds, 3);
  assert.deepEqual(Object.keys(observed.processes[0]).sort(), ['cpuSeconds', 'parent', 'pid', 'rssBytes', 'startId']);
  assert.ok(observed.limitations.some(value => value.includes('shared resident pages')));
});

test('exit, PID reuse, missing counters and incomplete reads never certify a complete observation', () => {
  const before = table();
  for (const after of [before.filter(value => value.pid !== 22), before.map(value => value.pid === 21 ? { ...value, startId: 'reused' } : value)]) {
    const observed = processTreeObservation(20, before, after);
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.rssSumBytes, null);
    assert.equal(observed.cpuSeconds, null);
  }
  assert.equal(processTreeObservation(20, before, before, [before[0]]).state, 'unknown');
  assert.equal(processTreeObservation(20, before, before, before, ['A metadata read failed.']).state, 'unknown');
  assert.equal(processTreeObservation(20, before, [], before).state, 'unknown');
});

test('Linux ignores only a later missing PID whose earlier parent proved it outside the owned tree', () => {
  const before = { rows: table(), failures: [] };
  const outsideExit = { rows: table().filter(value => value.pid !== 30), failures: [{ pid: 30, code: 'ENOENT' }] };
  assert.deepEqual(linuxInspectionLimitations(20, before, outsideExit), []);
  assert.equal(processTreeObservation(20, before.rows, outsideExit.rows, before.rows, linuxInspectionLimitations(20, before, outsideExit)).state, 'verified');
  for (const [first, after] of [
    [{ ...before, failures: [{ pid: 99, code: 'ENOENT' }] }, outsideExit],
    [before, { ...outsideExit, failures: [{ pid: 21, code: 'ESRCH' }] }],
    [before, { ...outsideExit, failures: [{ pid: 99, code: 'ENOENT' }] }],
    [before, { ...outsideExit, failures: [{ pid: 30, code: 'EACCES' }] }],
  ]) {
    const reasons = linuxInspectionLimitations(20, first, after);
    assert.ok(reasons.length > 0);
    assert.equal(processTreeObservation(20, first.rows, after.rows, first.rows, reasons).state, 'unknown');
  }
});

test('CPU summaries require stable identities and monotonic counters across every observation', () => {
  const before = snapshot(), after = snapshot(table().map(value => ({ ...value, cpuSeconds: 2, rssBytes: 2048 })));
  const good = summarizeProcessSamples([before, after]);
  assert.equal(good.state, 'verified');
  assert.equal(good.cpuSeconds, 3);
  assert.equal(good.peakRssBytes, 6144);
  assert.equal(good.stableProcessSet, true);
  for (const bad of [snapshot(table().map(value => value.pid === 21 ? { ...value, startId: 'new' } : value)), snapshot(table().filter(value => value.pid !== 22)), snapshot(table().map(value => ({ ...value, cpuSeconds: 0 }))), processTreeObservation(20, table(), [])]) {
    const summary = summarizeProcessSamples([before, bad, after]);
    assert.equal(summary.state, 'unknown');
    assert.equal(summary.cpuSeconds, null);
    assert.equal(summary.peakRssBytes, null);
  }
  assert.equal(summarizeProcessSamples([before]).state, 'unknown');
  assert.equal(summarizeProcessSamples([before, after], { limitReached: true }).state, 'unknown');
  assert.throws(() => summarizeProcessSamples(Array(MAX_PROCESS_SAMPLES + 1).fill(before)), /sample count/);
});

test('retained observations cannot certify forged sums, duplicate identities or disconnected ancestry', () => {
  const good = snapshot();
  for (const mutate of [
    value => { value.cpuSeconds += 1; },
    value => { value.rssSumBytes += 1; },
    value => { value.processes[0].cpuSeconds = -1; },
    value => { value.processes[0].rssBytes = 1.5; },
    value => { value.processes[0].startId = ''; },
    value => { value.processes.push({ ...value.processes[0] }); },
    value => { value.processes[1].parent = 99; },
    value => { value.processes[1].parent = 22; value.processes[2].parent = 21; },
    value => { value.processes[1].startId = '1'; },
    value => { value.at = 'invalid'; },
    value => { value.state = 'unknown'; },
  ]) {
    const corrupt = structuredClone(good); mutate(corrupt);
    assert.throws(() => summarizeProcessSamples([good, corrupt]));
  }
  const incomplete = processTreeObservation(20, table(), []);
  assert.equal(summarizeProcessSamples([good, incomplete]).state, 'unknown');
});

test('sampling is serial, stop is idempotent and observer errors remain explicit unknown data', async () => {
  let active = 0, maximum = 0, calls = 0;
  const sampler = startProcessTreeSampling(20, { intervalMs: 1, observe: async () => {
    active++; maximum = Math.max(maximum, active); calls++;
    try { await delay(5); if (calls === 2) throw Error('private diagnostic must not escape'); return snapshot(); }
    finally { active--; }
  } });
  assert.equal((await sampler.ready).state, 'verified');
  assert.equal(calls, 1, 'ready resolves after the first completed snapshot');
  await delay(20);
  const stopping = sampler.stop();
  assert.equal(sampler.stop(), stopping);
  const summary = await stopping;
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(summary.state, 'unknown');
  assert.equal(summary.stableProcessSet, false);
  assert.equal(JSON.stringify(summary).includes('private diagnostic'), false);
  const count = calls; await delay(10); assert.equal(calls, count);
  assert.throws(() => startProcessTreeSampling(0));
  assert.throws(() => startProcessTreeSampling(20, { intervalMs: 0 }));
});

test('sampling storage stops at the hard cap and reports the unobserved remainder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const sampler = startProcessTreeSampling(20, { intervalMs: 1, observe: async () => { calls++; return snapshot(); } });
  for (let i = 0; i < MAX_PROCESS_SAMPLES + 2; i++) {
    for (let j = 0; j < 4; j++) await Promise.resolve();
    t.mock.timers.tick(1);
  }
  const summary = await sampler.stop();
  assert.equal(calls, MAX_PROCESS_SAMPLES);
  assert.equal(summary.samples.length, MAX_PROCESS_SAMPLES);
  assert.equal(summary.limitReached, true);
  assert.equal(summary.state, 'unknown');
  assert.ok(summary.limitations.some(value => value.includes('limit was reached')));
});

test('actual owned parent and child counters are observed without signalling them', { timeout: 30000 }, async () => {
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});let stopping=false;function stop(){if(stopping)return;stopping=true;child.once('close',()=>process.exit(0));child.kill('SIGTERM');}process.on('message',stop);process.on('disconnect',stop);process.send({root:process.pid,child:child.pid});`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const closed = once(child, 'close');
  try {
    const [owned] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    const observed = await observeProcessTree(owned.root);
    const pids = new Set(observed.processes.map(value => value.pid));
    assert.ok(pids.has(owned.root)); assert.ok(pids.has(owned.child));
    assert.equal(pids.has(process.pid), false);
    // Windows may create an owned console host in addition to our two Node
    // processes. Every additional process must still have a proved owned parent.
    assert.ok(observed.processes.every(value => value.pid === owned.root || pids.has(value.parent)));
    assert.equal(observed.processes.find(value => value.pid === owned.child).parent, owned.root);
    for (const value of observed.processes) {
      assert.ok(value.startId.length > 0);
      assert.ok(value.cpuSeconds >= 0);
      assert.ok(value.rssBytes > 0);
    }
    assert.equal(child.exitCode, null, 'the sampler must not stop its target');
    if (process.platform === 'darwin') {
      assert.equal(observed.state, 'unknown');
      assert.ok(observed.limitations.some(value => value.includes('one-second')));
    }
  } finally {
    if (child.connected) child.send('stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  const missing = await observeProcessTree(child.pid);
  assert.equal(missing.state, 'unknown');
  assert.equal(missing.cpuSeconds, null);
});
