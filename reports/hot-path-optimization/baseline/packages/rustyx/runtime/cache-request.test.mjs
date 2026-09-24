import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runApi } from './render.mjs';

test('failed Route Handler invalidation cancels an already-created body before reporting the error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rustyx-cache-cancel-'));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks)).op, 'invalidate');
    response.writeHead(500).end('cache unavailable');
  });
  const previous = { url: process.env.RUSTYX_CACHE_URL, token: process.env.RUSTYX_CACHE_TOKEN };
  const cancelled = [];
  const symbol = Symbol.for('rustyx.test.cache-invalidation-cancel');
  globalThis[symbol] = reason => { cancelled.push(reason); return new Promise(() => {}); };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.RUSTYX_CACHE_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.RUSTYX_CACHE_TOKEN = 'test';
    const filename = path.join(directory, 'route.mjs');
    await writeFile(filename, `import { revalidateTag } from ${JSON.stringify(new URL('../compat/cache.cjs', import.meta.url).href)};
      export function GET() {
        const body = new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('unreturned stream')); },
          cancel(reason) { return globalThis[Symbol.for('rustyx.test.cache-invalidation-cancel')](reason); },
        });
        revalidateTag('changed');
        return new Response(body);
      }
    `);
    for (const stream of [false, true]) {
      await assert.rejects(runApi({ modulePath: filename, url: 'http://app.test/data', method: 'GET', stream, timeoutMs: 1000 }), /cache invalidate failed/);
    }
    assert.equal(cancelled.length, 2);
    for (const reason of cancelled) assert.match(reason.message, /cache invalidate failed/);
  } finally {
    if (previous.url === undefined) delete process.env.RUSTYX_CACHE_URL;
    else process.env.RUSTYX_CACHE_URL = previous.url;
    if (previous.token === undefined) delete process.env.RUSTYX_CACHE_TOKEN;
    else process.env.RUSTYX_CACHE_TOKEN = previous.token;
    delete globalThis[symbol];
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
