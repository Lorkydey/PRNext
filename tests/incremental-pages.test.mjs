import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { incrementalFixture } from './incremental-cache-fixture.mjs';
import { startServer } from './support.mjs';

test('legacy full route cache shares Pages, Flight and handler entries and respects remote invalidation', async () => {
  const fixture = await incrementalFixture();
  let first, second;
  try {
    first = await startServer(fixture.root);
    second = await startServer(fixture.root);
    const text = async (server, route, headers) => {
      const response = await fetch(server.url + route, { headers });
      assert.equal(response.status, 200, await response.clone().text());
      return response.text();
    };
    const invalidate = async input => {
      const response = await fetch(first.url + '/api/invalidate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 200, await response.text());
    };
    const events = async () => (await readFile(path.join(fixture.root, '.incremental-shared/events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const initial = new Map();
    for (const route of ['/legacy-pages', '/legacy-page', '/legacy-route']) {
      initial.set(route, await text(first, route));
      const count = fixture.counts.get(route.slice(1));
      assert.equal(await text(second, route), initial.get(route));
      assert.equal(fixture.counts.get(route.slice(1)), count, 'second server uses the shared response without executing the page');
    }
    const initialFlight = await text(first, '/legacy-page', { RSC: '1' });
    assert.equal(await text(second, '/legacy-page', { RSC: '1' }), initialFlight);
    const manifest = JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    const before = await events();
    for (const [route, kind] of [['legacy-pages', 'PAGES'], ['legacy-page', 'APP_PAGE'], ['legacy-route', 'APP_ROUTE']]) {
      const key = `rustyx:${manifest.cacheId}:/${route}`;
      assert.ok(before.some(event => event.method === 'set' && event.key === key && event.kind === kind), kind);
      assert.ok(before.filter(event => event.method === 'get' && event.key === key).length >= 2);
    }
    fixture.values.set('legacy-page', 42);
    await invalidate({ tag: 'legacy-page' });
    assert.match(await text(second, '/legacy-page'), />42(?:<|:)/);
    assert.match(await text(first, '/legacy-page', { RSC: '1' }), /42/);
    fixture.values.set('legacy-route', 73);
    await invalidate({ path: '/legacy-route' });
    assert.equal(JSON.parse(await text(second, '/legacy-route')).value, 73);
    fixture.values.set('legacy-pages', 91);
    assert.equal((await fetch(first.url + '/api/legacy-revalidate')).status, 200);
    assert.match(await text(second, '/legacy-pages'), />91(?:<|:)/);
    await second.close(); second = await startServer(fixture.root);
    assert.match(await text(second, '/legacy-pages'), />91(?:<|:)/);
    const count = fixture.counts.get('legacy-pages');
    await text(second, '/legacy-pages');
    assert.equal(fixture.counts.get('legacy-pages'), count);
    const after = await events();
    assert.ok(after.filter(event => event.method === 'get' && event.kind === 'PAGES').length >= 5, 'persisted native rows never bypass external get');
  } finally { await first?.close(); await second?.close(); await fixture.remove(); }
});
