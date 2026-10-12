import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const moduleUrl = name => JSON.stringify(new URL(name, import.meta.url).href);
const collection = `
  import { setImmediate as immediate } from 'node:timers/promises';
  async function collect() {
    for (let i = 0; i < 8; i++) { await immediate(); global.gc(); }
    await immediate();
  }
`;

for (const cancelled of [false, true]) {
test(`${cancelled ? 'cancelled' : 'completed'} RSC responses release streams and request signals before cache work settles`, async t => {
  const root = await mkdtemp(fileURLToPath(new URL('./.rsc-memory-test-', import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const modulePath = path.join(root, 'page.mjs');
  await writeFile(modulePath, `
    import React from 'react';
    import { existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { cacheState } from '../../compat/data-cache.cjs';
    async function Slow() {
      while (!existsSync(new URL('./release-cache', import.meta.url))) await delay(5);
      return React.createElement('p', null, 'late body');
    }
    export const page = { default: () => {
      const state = cacheState();
      const work = (async () => {
        while (!existsSync(new URL('./release-cache', import.meta.url))) await delay(5);
      })();
      state.pending.add(work);
      void work.finally(() => state.pending.delete(work));
      return ${cancelled ? "React.createElement(React.Suspense, { fallback: React.createElement('p', null, 'pending body') }, React.createElement(Slow))" : "React.createElement('p', null, 'completed body')"};
    }};
  `);
  const { stdout } = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
    import { writeFile } from 'node:fs/promises';
    import { renderFlight, closeAppRuntime } from ${moduleUrl('./app-render.mjs')};
    import { requestWork } from ${moduleUrl('./request-work.mjs')};
    ${collection}
    const tracked = [], responses = [], streams = [], signals = [], contexts = [];
    const storage = new AsyncLocalStorage();
    // Match worker.mjs: framework settlement observers do not themselves
    // introduce a reaction inside the caller's AsyncLocalStorage context.
    const observer = new AsyncResource('PRNextMemoryTestObserver', { triggerAsyncId: 0 });
    let settled = 0;
    async function invoke() {
      const abort = new AbortController();
      // Applications may attach request data to their signal. Completed HTTP
      // work must not be retained by an obsolete listener-removal closure.
      abort.signal.requestPayload = Buffer.alloc(256 * 1024);
      abort.signal[requestWork] = promise => {
        tracked.push(promise);
        observer.runInAsyncScope(() => promise.then(() => settled++));
      };
      signals.push(new WeakRef(abort.signal));
      const response = await renderFlight({ modulePath: ${JSON.stringify(modulePath)},
        distDir: ${JSON.stringify(root)}, url: 'http://app.test/memory', stream: true },
        { signal: abort.signal });
      responses.push(new WeakRef(response));
      streams.push(new WeakRef(response.body));
      const reader = response.body.getReader();
      ${cancelled ? `await reader.read();
      abort.abort(new Error('client disconnected'));
      await reader.cancel().catch(() => {});` : `while (!(await reader.read()).done) {}`}
    }
    try {
      ${cancelled ? `for (let i = 0; i < 12; i++) await invoke();` : `
      // Initialize Node's module/worker internals outside a request. The test
      // isolates per-response bookkeeping rather than module import lifetime.
      await invoke();
      responses.length = streams.length = signals.length = 0;
      for (let i = 0; i < 12; i++) {
        await storage.run({ payload: Buffer.alloc(256 * 1024) }, async () => {
          contexts.push(new WeakRef(storage.getStore()));
          await invoke();
        });
      }`}
      await collect();
      assert.equal(settled, 0, 'legitimate cache work must remain tracked');
      for (const [name, refs] of [['responses', responses], ['streams', streams], ['signals', signals]]) {
        assert.equal(refs.filter(ref => ref.deref()).length, 0, 'pending cache work retained obsolete ' + name);
      }
      // Node 22 attaches the ALS store to a Promise itself; Node 24 uses
      // reaction frames. A still-tracked native promise may therefore remain
      // a legitimate owner even after the destroyed response timer is gone.
      // Identify that actual ownership instead of assuming a Node version.
      const promiseOwnsContext = contexts.some(ref => {
        const context = ref.deref();
        return context && tracked.some(promise => Object.getOwnPropertySymbols(promise).some(key => promise[key] === context));
      });
      if (promiseOwnsContext) console.log('native tracked promises own ALS contexts until settlement; checking release afterwards');
      else assert.equal(contexts.filter(ref => ref.deref()).length, 0, 'destroyed response timers retained request contexts');
      await writeFile(${JSON.stringify(path.join(root, 'release-cache'))}, 'go');
      await Promise.all(tracked);
      assert.equal(settled, tracked.length, 'all cache work must still complete normally');
      tracked.length = 0;
      await collect();
      assert.equal(contexts.filter(ref => ref.deref()).length, 0, 'settled cache work retained request contexts');
      console.log('RSC response references released before cache settlement');
    } finally {
      await writeFile(${JSON.stringify(path.join(root, 'release-cache'))}, 'cleanup');
      await closeAppRuntime();
    }
  `], { timeout: 15_000 });
  assert.match(stdout, /RSC response references released before cache settlement/);
});
}

test('lazy App API primitives do not retain the first caller through a cached promise', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-route-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'route.mjs');
  await writeFile(modulePath, 'export function GET() { return Response.json({ ok: true }); }');
  const { stdout } = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { AsyncLocalStorage } from 'node:async_hooks';
    import { runApi } from ${moduleUrl('./api.mjs')};
    import ${moduleUrl('../compat/server.cjs')};
    import ${moduleUrl('../compat/route-request.cjs')};
    ${collection}
    // Load application code outside a request to isolate the framework's
    // primitive index from Node's own module loading lifetime.
    await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    Response.json({ warm: true });
    const storage = new AsyncLocalStorage(), refs = [];
    async function invoke() {
      await storage.run({ payload: Buffer.alloc(256 * 1024) }, async () => {
        refs.push(new WeakRef(storage.getStore()));
        const response = await runApi({ modulePath: ${JSON.stringify(modulePath)}, route: { router: 'app' }, url: 'http://app.test/api' });
        assert.equal(response.status, 200);
        await response.finalizeCache();
      });
    }
    for (let i = 0; i < 4; i++) await invoke();
    await collect();
    assert.equal(refs.filter(ref => ref.deref()).length, 0, 'primitive loading retained a caller context');
    console.log('App API caller contexts released');
  `], { timeout: 15000 });
  assert.match(stdout, /App API caller contexts released/);
});

test('expired middleware observers release request bodies and stores while observing late rejection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-middleware-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'middleware.mjs');
  await writeFile(modulePath, `
    import { NextResponse } from ${moduleUrl('../compat/server.cjs')};
    import { currentRequest } from ${moduleUrl('../compat/headers.cjs')};
    export function middleware(request, event) {
      const context = currentRequest();
      context.cacheState.fixturePayload = Buffer.alloc(256 * 1024);
      globalThis.__contexts.push(new WeakRef(context));
      event.waitUntil(globalThis.__pending);
      return NextResponse.next();
    }
  `);
  const { stdout } = await run(process.execPath, ['--expose-gc', '--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { runMiddleware, drainMiddlewareWork, middlewareBackgroundState } from ${moduleUrl('./middleware.mjs')};
    ${collection}
    // The application owns this unresolved promise, but it has never seen a
    // request or body. Only framework observers can link it to those objects.
    globalThis.__contexts = [];
    globalThis.__pending = Promise.resolve();
    await runMiddleware({ modulePath: ${JSON.stringify(modulePath)}, url: 'http://app.test/warm' });
    await drainMiddlewareWork();
    class ApplicationPromise extends Promise {}
    for (const Constructor of [Promise, ApplicationPromise]) {
      let reject;
      globalThis.__pending = new Constructor((_, failed) => { reject = failed; });
      globalThis.__contexts = [];
      const bodies = [], errors = [];
      async function invoke() {
        const body = Buffer.alloc(256 * 1024);
        bodies.push(new WeakRef(body));
        const response = await runMiddleware({ modulePath: ${JSON.stringify(modulePath)},
          url: 'http://app.test/', method: 'POST', body, waitUntilTimeoutMs: 5,
          onBackgroundError(error) { errors.push(error.message); } });
        await response.finalizeCache();
        await drainMiddlewareWork();
      }
      for (let i = 0; i < 8; i++) await invoke();
      await collect();
      assert.deepEqual(middlewareBackgroundState(), { scopes: 0, promises: 0 });
      assert.equal(bodies.filter(ref => ref.deref()).length, 0, 'expired work retained request bodies');
      assert.equal(__contexts.filter(ref => ref.deref()).length, 0, 'observer promises retained request stores');
      assert.equal(errors.length, 8);
      reject(new Error('late application rejection'));
      await immediate(); await immediate();
      assert.equal(errors.length, 8, 'expired work must not report a second failure');
    }
    console.log('released bodies and contexts; late rejection observed');
  `], { timeout: 15_000 });
  assert.match(stdout, /released bodies and contexts/);
});

test('completed cache RPCs release previous request stores before their deadline', async () => {
  const { stdout } = await run(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { runRequestContext, currentRequest } from ${moduleUrl('../compat/headers.cjs')};
    import { cachedValue } from ${moduleUrl('../compat/data-cache.cjs')};
    ${collection}
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end('{"state":"fresh","value":"YQ=="}'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PRNEXT_CACHE_URL = 'http://127.0.0.1:' + server.address().port;
    process.env.PRNEXT_CACHE_TOKEN = 'test';
    const refs = [];
    try {
      await cachedValue('a'.repeat(64), () => assert.fail('unexpected cache miss'));
      for (let i = 0; i < 12; i++) {
        await runRequestContext({ phase: 'render', url: 'http://app.test/' }, async () => {
          const value = Buffer.alloc(256 * 1024);
          refs.push(new WeakRef(value));
          currentRequest().cacheState.fetchMemo = { entries: new Map([['completed', { value }]]), bytes: value.length };
          assert.equal((await cachedValue('a'.repeat(64), () => assert.fail('unexpected cache miss'),
            { signal: new AbortController().signal })).toString(), 'a');
        });
      }
      // The reusable cache connection must not retain a previous request store,
      // even while the keep-alive pool stays open for the next request.
      await collect();
      const retained = refs.filter(ref => ref.deref()).length;
      assert.equal(retained, 0, retained + ' completed request stores retained');
      console.log('previous RPC request stores released');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `], { timeout: 15_000 });
  assert.match(stdout, /previous RPC request stores released/);
});
