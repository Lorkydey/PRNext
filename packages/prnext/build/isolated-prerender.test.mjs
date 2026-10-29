import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedPrerender } from './production-builder.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture(source, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-isolated-prerender-'));
  try {
    const script = path.join(root, 'coordinator.mjs');
    await writeFile(script, source);
    await run(root, script);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('isolated prerender escalates a blocked coordinator to SIGKILL and rejects only after close without retry', { timeout: 5000 }, async () => fixture(`
  import {appendFileSync} from 'node:fs';
  process.on('SIGTERM',()=>{});
  process.once('message',()=>{appendFileSync('calls.txt','once\\n');for(;;){}});
`, async (root, script) => {
  let child, closed = false, calls = 0;
  const signals = [];
  await assert.rejects(isolatedPrerender(root, root, {}, {}, {
    timeoutMs: 500, abortGraceMs: 20, killGraceMs: 50,
    fork: (_, args, options) => {
      calls++; child = fork(script, args, options);
      const kill = child.kill.bind(child);
      child.kill = signal => { signals.push(signal); return signal === 'SIGTERM' ? true : kill(signal); };
      child.once('close', () => { closed = true; });
      return child;
    },
  }), /exceeded ten minutes/);
  assert.equal(calls, 1); assert.ok(closed); assert.ok(!alive(child.pid));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(await readFile(path.join(root, 'calls.txt'), 'utf8'), 'once\n');
}));

test('isolated prerender settles a failed spawn with no exit event and no surviving timers', { timeout: 3000 }, async () => fixture('', async (root, script) => {
  let closed = false;
  await assert.rejects(isolatedPrerender(root, root, {}, {}, {
    timeoutMs: 1000, killGraceMs: 20,
    fork: (_, args, options) => {
      const child = fork(script, args, { ...options, execPath: path.join(root, 'missing-node') });
      child.once('close', () => { closed = true; });
      return child;
    },
  }), /ENOENT|IPC disconnected/);
  assert.ok(closed);
}));

test('an unexpected coordinator IPC disconnect is terminated and reaped before returning an error', { timeout: 3000 }, async () => fixture(`
  process.once('message',()=>{process.disconnect();setInterval(()=>{},1000)});
`, async (root, script) => {
  let child, closed = false;
  await assert.rejects(isolatedPrerender(root, root, {}, {}, {
    timeoutMs: 2000, killGraceMs: 30,
    fork: (_, args, options) => { child = fork(script, args, options); child.once('close', () => { closed = true; }); return child; },
  }), /IPC disconnected/);
  assert.ok(closed); assert.ok(!alive(child.pid));
}));
