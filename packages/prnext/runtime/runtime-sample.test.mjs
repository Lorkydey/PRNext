import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createRuntimeSampler } from '../compat/runtime-sample.cjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const samplerPath = require.resolve('../compat/runtime-sample.cjs');

test('runtime samples report interval counters without retaining allocation history', async () => {
  const source = `
    const assert = require('node:assert/strict');
    const sampler = require(${JSON.stringify(samplerPath)}).createRuntimeSampler();
    (async () => {
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 30));
      const first = sampler.sample();
      assert.ok(first.gc.count > 0);
      assert.ok(first.gc.durationMs > 0);
      assert.ok(first.gc.maxPauseMs <= first.gc.durationMs);
      assert.ok(first.intervalMs > 0);
      assert.ok(first.heapUsedBytes > 0 && first.heapTotalBytes >= first.heapUsedBytes);
      assert.ok(first.rssBytes > 0 && first.youngSpaceBytes > 0);
      assert.equal(first.cpu.scope, 'process');
      assert.ok(first.cpu.userMicros >= 0 && first.cpu.systemMicros >= 0);
      assert.ok(first.eventLoop.utilization >= 0 && first.eventLoop.utilization <= 1);
      const second = sampler.sample();
      assert.equal(second.gc.count, 0);
      assert.equal(second.gc.durationMs, 0);
      assert.equal(second.gc.maxPauseMs, 0);
      sampler.close();
      console.log(JSON.stringify({ node: first.node, gc: first.gc, threadId: first.threadId }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await execute(process.execPath, ['--expose-gc', '-e', source],
    { timeout: 10000, windowsHide: true, maxBuffer: 65536 });
  assert.equal(JSON.parse(stdout).threadId, 0);
});

test('worker samples expose isolate limits without duplicating process CPU counters', async () => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const sampler = require(${JSON.stringify(samplerPath)}).createRuntimeSampler();
    parentPort.postMessage(sampler.sample());
    sampler.close();
  `, { eval: true, resourceLimits: { maxYoungGenerationSizeMb: 8 } });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', code => { if (code) reject(new Error('Worker exited: ' + code)); });
    });
    assert.ok(result.threadId > 0);
    assert.equal(result.workerLimits.maxYoungGenerationSizeMb, 8);
    assert.equal(Object.hasOwn(result, 'cpu'), false);
    assert.ok(Number.isFinite(result.gc.durationMs));
  } finally { await worker.terminate(); }
});

test('disabled diagnostics do not load the sampler or create periodic resources', async () => {
  const source = `
    const assert = require('node:assert/strict');
    const before = process.getActiveResourcesInfo();
    const diagnostics = require(${JSON.stringify(require.resolve('../compat/diagnostics.cjs'))});
    assert.equal(diagnostics.enabled, false);
    assert.equal(require.cache[${JSON.stringify(samplerPath)}], undefined);
    assert.deepEqual(process.getActiveResourcesInfo(), before);
  `;
  await execute(process.execPath, ['-e', source], { timeout: 10000, windowsHide: true,
    maxBuffer: 65536, env: { ...process.env, PRNEXT_INSPECT_DIR: '' } });
});
