import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

test('after runs beyond HTTP completion/error/disconnect without losing its worker or request context', { timeout: 90000 }, async () => {
  const fixture = await appFixture(); let server;
  try {
    const dir = path.join(fixture.root, 'app', 'after'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'route.js'), `
      import { after } from 'next/server';
      import { cookies } from 'next/headers';
      const records = new Map();
      export const maxDuration = 15;
      export async function GET(req) {
        const q = req.nextUrl.searchParams;
        if (q.has('read')) return Response.json({pid:process.pid, records:Object.fromEntries(records)});
        const id = q.get('id');
        after(async () => {
          await new Promise(resolve => setTimeout(resolve, q.has('disconnect') ? 6200 : 1500));
          records.set(id, { user:(await cookies()).get('user')?.value, pid:process.pid });
          after(() => records.set(id+'-nested', true));
        });
        if (q.has('error')) throw new Error('expected fixture failure');
        if (q.has('disconnect')) return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('started'));}}));
        return Response.json({pid:process.pid});
      }
    `);
    await build(fixture.root);
    server = await startServer(fixture.root, ['--workers', '1', '--worker-idle-seconds', '1', '--lane-idle-seconds', '1']);
    const first = await fetch(server.url + '/after?id=ok', { headers: { cookie: 'user=alice' } });
    assert.equal(first.status, 200); const { pid } = await first.json();
    const read = async () => (await fetch(server.url + '/after?read', { signal: AbortSignal.timeout(5000) })).json();
    assert.equal((await read()).records.ok, undefined, 'response must precede deferred work');
    const failed = await fetch(server.url + '/after?id=error&error', { headers: { cookie: 'user=bob' } });
    assert.equal(failed.status, 500); await failed.text();
    assert.equal((await read()).records.error, undefined, 'error response must precede deferred work');
    const abort = new AbortController();
    const abandoned = await fetch(server.url + '/after?id=abort&disconnect', { headers: { cookie: 'user=carol' }, signal: abort.signal });
    const reader = abandoned.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'started'); abort.abort();
    await reader.cancel().catch(() => {});
    // No keepalive traffic: exceed both the configured idle retirement and the
    // five-second cancellation watchdog while legitimate after work continues.
    await delay(5500);
    assert.equal((await read()).pid, pid);
    let result;
    for (let i = 0; i < 100; i++) { result = await read(); if (result.records['abort-nested']) break; await delay(100); }
    assert.equal(result.pid, pid, 'legitimate after work must not trigger the five-second orphan watchdog');
    for (const [id, user] of [['ok', 'alice'], ['error', 'bob'], ['abort', 'carol']]) {
      assert.deepEqual(result.records[id], { user, pid });
      assert.equal(result.records[id+'-nested'], true);
    }
    assert.doesNotMatch(server.output(), /restarting render worker|EPIPE/);
  } finally { await server?.close(); await fixture.remove(); }
});
