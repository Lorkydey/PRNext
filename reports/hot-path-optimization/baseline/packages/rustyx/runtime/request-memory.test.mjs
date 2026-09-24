import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const moduleUrl = name => JSON.stringify(new URL(name, import.meta.url).href);
const collection = `
  import { setImmediate as immediate } from 'node:timers/promises';
  async function collect() {
    for (let i = 0; i < 8; i++) { await immediate(); global.gc(); }
    await immediate();
  }
`;

test('expired middleware observers release request bodies and stores while observing late rejection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-middleware-memory-'));
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
    process.env.RUSTYX_CACHE_URL = 'http://127.0.0.1:' + server.address().port;
    process.env.RUSTYX_CACHE_TOKEN = 'test';
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
