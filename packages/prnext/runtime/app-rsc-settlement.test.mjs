import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderFlight, closeAppRuntime, drainAppRuntime } from './app-render.mjs';
import { requestWork } from './request-work.mjs';

async function fixture(suspend) {
  const root = await mkdtemp(fileURLToPath(new URL('./.rsc-settlement-test-', import.meta.url)));
  const modulePath = path.join(root, 'page.mjs');
  await writeFile(modulePath, `
    import React from 'react';
    import {existsSync} from 'node:fs';
    import {writeFile} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    import {cacheState} from '../../compat/data-cache.cjs';
    const file = name => new URL('./'+name,import.meta.url);
    async function Slow(){while(!existsSync(file('body-release')))await delay(5);return React.createElement('p',null,'late body');}
    export const page={default:()=>{
      const state=cacheState();
      const work=(async()=>{
        await writeFile(file('cache-started'),'started');
        while(!existsSync(file('cache-release'))){
          if(existsSync(file('cache-block')))while(true){}
          await delay(5);
        }
        await writeFile(file('cache-completed'),'completed');
      })();
      state.pending.add(work);
      void work.finally(()=>state.pending.delete(work));
      return ${suspend ? "React.createElement(React.Suspense,{fallback:React.createElement('p',null,'pending body')},React.createElement(Slow))" : "React.createElement('p',null,'body completed')"};
    }};
  `);
  return { root, request: { modulePath, distDir: root, url: 'http://localhost/settlement', stream: true } };
}

for (const cancelled of [false, true]) {
  test(`${cancelled ? 'cancelled' : 'completed'} RSC streams keep cache flush work tracked until actual settlement`, async () => {
    const { root, request } = await fixture(cancelled);
    const abort = new AbortController(), tracked = [];
    let settled = 0, workDeadline, supervised;
    abort.signal[requestWork] = (promise, options) => {
      tracked.push(promise);
      workDeadline = options?.deadline;
      supervised = options?.supervised;
      promise.then(() => settled++, () => settled++);
    };
    try {
      const before = performance.now();
      const rendering = renderFlight(request, { signal: abort.signal, hardTimeoutMs: 5000 });
      const after = performance.now();
      const response = await rendering;
      const reader = response.body.getReader();
      let body = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        body += Buffer.from(value).toString();
        if (cancelled && body.includes('pending body')) {
          abort.abort(new Error('client disconnected while cache work continued'));
          await reader.cancel().catch(() => {});
          break;
        }
      }
      assert.match(body, cancelled ? /pending body/ : /body completed/);
      assert.equal(tracked.length, 1, 'the actual RSC operation is registered with the HTTP work scope');
      assert.ok(Number.isFinite(workDeadline));
      assert.equal(supervised, true, 'RSC supplies its own request and responsiveness supervision');
      assert.ok(workDeadline >= before + 5000 && workDeadline <= after + 5000,
        'tracked work keeps the original request deadline');
      await delay(20);
      assert.equal(settled, 0, 'body end/cancellation must not release the cache work scope');
      await assert.rejects(readFile(path.join(root, 'cache-completed')), error => error.code === 'ENOENT');
      await writeFile(path.join(root, 'cache-release'), 'go');
      await Promise.all(tracked);
      assert.equal(settled, 1);
      assert.equal(await readFile(path.join(root, 'cache-completed'), 'utf8'), 'completed');
    } finally {
      await writeFile(path.join(root, 'cache-release'), 'cleanup');
      await writeFile(path.join(root, 'body-release'), 'cleanup');
      await closeAppRuntime();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test('normal body completion does not apply the response deadline to slow cache work', async () => {
  const { root, request } = await fixture(false);
  const abort = new AbortController(), tracked = [];
  let settled = false;
  abort.signal[requestWork] = promise => { tracked.push(promise); promise.then(() => { settled = true; }); };
  try {
    const response = await renderFlight(request, { signal: abort.signal, hardTimeoutMs: 700 });
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
    // The body was successful; its cache write can remain responsive past the
    // original request deadline without losing admission or its work scope.
    await delay(850);
    assert.equal(settled, false, 'cache work must survive the expired response deadline');
    await writeFile(path.join(root, 'cache-release'), 'go');
    await Promise.all(tracked);
    assert.equal(await readFile(path.join(root, 'cache-completed'), 'utf8'), 'completed');
  } finally {
    await writeFile(path.join(root, 'cache-release'), 'cleanup');
    await closeAppRuntime();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('late RSC settlement cannot unref a retiring worker before build continuation', async () => {
  const { root, request } = await fixture(false);
  try {
    await writeFile(path.join(root, 'cache-release'), 'go');
    const runtime = new URL('./app-render.mjs', import.meta.url).href;
    const source = `
      import {renderFlight,closeAppRuntime} from ${JSON.stringify(runtime)};
      // Match the CLI's detached async main: a pending Promise alone must not
      // allow exit 0 before the continuation that publishes build artefacts.
      (async()=>{
        for(let i=0;i<10;i++){
          await renderFlight(${JSON.stringify({ ...request, stream: false })});
          await closeAppRuntime();
          process.stdout.write('closed:'+i+'\\n');
        }
      })().catch(error=>{console.error(error);process.exitCode=1});
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source],
      { timeout: 20000, windowsHide: true });
    assert.equal(result.stdout, Array.from({ length: 10 }, (_, i) => `closed:${i}\n`).join(''),
      'successful process exit must include every post-termination continuation');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('real RSC probes preserve responsive cache work and retire a blocked post-response isolate', async () => {
  const { root, request } = await fixture(false);
  const abort = new AbortController(), tracked = [];
  let settled = 0;
  abort.signal[requestWork] = promise => {
    tracked.push(promise);
    promise.then(() => settled++, () => settled++);
  };
  // Only the parent watchdog defaults change. The real RSC thread retains its
  // own timers and executes the same work-probe/work-responsive wire protocol.
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => originalTimeout(callback,
    milliseconds === 5000 ? 30 : milliseconds === 30000 ? 150 : milliseconds, ...args);
  let guard;
  try {
    const response = await renderFlight(request, { signal: abort.signal, hardTimeoutMs: 2000 });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString();
    assert.match(body, /body completed/);
    assert.equal(tracked.length, 1);
    await delay(350);
    assert.equal(settled, 0, 'real probes acknowledge cache work lasting beyond their response deadline');
    await writeFile(path.join(root, 'cache-block'), 'block the RSC thread');
    await Promise.race([
      Promise.all(tracked),
      new Promise((_, reject) => { guard = originalTimeout(() => reject(new Error('blocked RSC isolate did not retire')), 2500); }),
    ]);
    assert.equal(settled, 1, 'tracked work is released when the blocked isolate exits');
    await writeFile(path.join(root, 'cache-release'), 'go');
    const healthy = await renderFlight({ ...request, stream: false }, { hardTimeoutMs: 2000 });
    assert.match(healthy.body.toString(), /body completed/);
  } finally {
    globalThis.setTimeout = originalTimeout;
    clearTimeout(guard);
    await writeFile(path.join(root, 'cache-release'), 'cleanup');
    await closeAppRuntime();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test('graceful RSC drain waits for cache settlement before closing worker ports', { timeout: 10000 }, async () => {
  const { root, request } = await fixture(false);
  let drained = false;
  let draining;
  try {
    const response = await renderFlight(request, { hardTimeoutMs: 5000 });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString();
    assert.match(body, /body completed/);
    draining = drainAppRuntime().then(() => { drained = true; });
    await delay(100);
    assert.equal(drained, false, 'drain must not terminate the still-running cache write');
    await writeFile(path.join(root, 'cache-release'), 'go');
    await draining;
    assert.equal(await readFile(path.join(root, 'cache-completed'), 'utf8'), 'completed');
  } finally {
    await writeFile(path.join(root, 'cache-release'), 'cleanup');
    await closeAppRuntime();
    await draining;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
