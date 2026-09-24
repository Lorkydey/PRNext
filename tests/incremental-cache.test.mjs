import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { incrementalFixture } from './incremental-cache-fixture.mjs';
import { startServer } from './support.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('incremental cacheHandler shares function and fetch data across servers, restart and invalidations', async () => {
  const fixture = await incrementalFixture(); let first, second;
  try {
    const manifest = JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    assert.equal(manifest.config.cacheMaxMemorySize, 0);
    assert.match(manifest.config.cacheHandler, /^server\//);
    await writeFile(path.join(fixture.root, 'legacy-handler.ts'), 'throw new Error("source must not execute")');
    first = await startServer(fixture.root, ['--workers', '2']); second = await startServer(fixture.root);
    const get = async (server, route, headers) => { const response = await fetch(server.url + route, { headers }); assert.equal(response.status, 200, await response.clone().text()); const { worker, ...data } = await response.json(); return data; };
    const invalidate = async payload => { const response = await fetch(first.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); assert.equal(response.status, 200, await response.text()); };
    const release = fixture.hold('legacy-parallel');
    const parallel = Promise.all(Array.from({ length: 6 }, () => get(first, '/api/data?key=legacy-parallel')));
    void parallel.catch(() => {});
    try {
      const deadline = Date.now() + 5000;
      while (!fixture.counts.get('legacy-parallel') && Date.now() < deadline) await delay(10);
      await delay(70);
      assert.equal(fixture.counts.get('legacy-parallel'), 1, 'Rust coordinates one external-cache producer across local Node workers');
    } finally { release(); }
    const values = await parallel;
    assert.equal(new Set(values.map(value => value.producer)).size, 1);
    const original = await get(first, '/api/data?key=legacy');
    assert.deepEqual(await get(second, '/api/data?key=legacy'), original);
    assert.equal(fixture.counts.get('legacy'), 1);
    const fetched = await get(first, '/api/fetch?key=legacy-fetch', { authorization: 'Bearer a' });
    assert.deepEqual(await get(second, '/api/fetch?key=legacy-fetch', { authorization: 'Bearer a' }), fetched);
    assert.equal((await get(second, '/api/fetch?key=legacy-fetch', { authorization: 'Bearer b' })).authorization, 'Bearer b');
    fixture.values.set('legacy', 42); await invalidate({ tag: 'functions' });
    assert.equal((await get(second, '/api/data?key=legacy')).value, 42);
    fixture.values.set('legacy-fetch', 73); await invalidate({ tag: 'fetch:legacy-fetch' });
    assert.equal((await get(second, '/api/fetch?key=legacy-fetch', { authorization: 'Bearer a' })).value, 73);
    fixture.values.set('legacy', 74); await invalidate({ path: '/api/data' });
    assert.equal((await get(second, '/api/data?key=legacy')).value, 74);
    await second.close(); second = await startServer(fixture.root);
    assert.equal((await get(second, '/api/data?key=legacy')).value, 74);
    assert.equal(fixture.counts.get('legacy'), 3);
  } finally { await first?.close(); await second?.close(); await fixture.remove(); }
});
