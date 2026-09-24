import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { routingFixture } from './app-routing-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await routingFixture(); await fixture.build(); server = await startServer(fixture.root); });
after(async () => { await server?.close(); await fixture?.remove(); });

test('hard App requests select canonical pages, parallel slots and default fallbacks', async () => {
  const canonical = await fetch(`${server.url}/docs/photo/one`);
  assert.equal(canonical.status, 200);
  const photo = await canonical.text();
  assert.match(photo, /Canonical photo/);
  assert.doesNotMatch(photo, /role="dialog"/);
  const dashboard = await fetch(`${server.url}/docs/dashboard/settings`);
  const html = await dashboard.text();
  assert.equal(dashboard.status, 200);
  assert.match(html, /Settings main/);
  assert.match(html, /Team settings/);
  assert.match(html, /Default analytics/);
});

test('unmatched hard slots without default return 404 while slot-only URLs use children defaults', async () => {
  const missing = await fetch(`${server.url}/docs/missing/deeper`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Routing missing/);
  const team = await fetch(`${server.url}/docs/dashboard/team`);
  assert.equal(team.status, 200);
  const html = await team.text();
  assert.match(html, /Team only/);
  assert.match(html, /Default main/);
});

const state = { source: '/', slots: { '::{}::children': { branch: '', url: '/' }, '::{}::modal': { branch: '@modal#default', url: '/' } } };
test('Flight router state selects interception; malformed state and document requests remain canonical', async () => {
  const soft = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(state)) } });
  assert.equal(soft.status, 200);
  assert.match(soft.headers.get('content-type'), /text\/x-component/);
  assert.match(await soft.text(), /Modal photo/);
  for (const headers of [{ 'x-rustyx-router-state': JSON.stringify(state) }, { RSC: '1', 'x-rustyx-router-state': 'invalid' }]) {
    const response = await fetch(`${server.url}/docs/photo/one`, { headers });
    assert.match(await response.text(), /Canonical photo/);
  }
});

test('explicit refresh reconstructs retained background branches and rejects unknown saved branches', async () => {
  const modalState = { source: '/photo/one', refresh: true, slots: {
    ...state.slots, '::{}::children': { ...state.slots['::{}::children'] }, '::{}::modal': { branch: '@modal/(.)photo/[id]', url: '/photo/one' },
  } };
  const response = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(modalState)) } });
  assert.equal(response.status, 200);
  const flight = await response.text();
  assert.match(flight, /Feed version/);
  assert.match(flight, /Modal photo/);
  assert.doesNotMatch(flight, /Canonical photo/);
  modalState.slots['::{}::children'].branch = 'does-not-exist';
  const invalid = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(modalState)) } });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /routingInvalid/);
});

test('restored branches cannot bypass their middleware under changed credentials', async () => {
  for (const branch of ['admin']) {
    const saved = { source: '/photo/one', refresh: true, slots: {
      '::{}::children': { branch, url: `/${branch}` },
      '::{}::modal': { branch: '@modal/(.)photo/[id]', url: '/photo/one' },
    } };
    const header = encodeURIComponent(JSON.stringify(saved));
    const denied = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': header } });
    assert.equal(denied.status, 400);
    const flight = await denied.text();
    assert.match(flight, /routingInvalid/);
    assert.doesNotMatch(flight, /Protected admin|branch-user/);
    if (branch === 'admin') {
      const allowed = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', cookie: 'auth=yes', 'x-rustyx-router-state': header } });
      assert.equal(allowed.status, 200);
      assert.match(await allowed.text(), /Protected admin/);
      const count = fixture.counts.get('admin');
      const loggedOut = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': header } });
      assert.equal(loggedOut.status, 400);
      await loggedOut.arrayBuffer();
      assert.equal(fixture.counts.get('admin'), count, 'a rejected source branch is not executed');
      saved.slots['::{}::children'].url = '/%61dmin';
      const encoded = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(saved)) } });
      assert.equal(encoded.status, 400);
      assert.doesNotMatch(await encoded.text(), /Protected admin/);
    }
  }
});

test('restored branches isolate middleware transformations and validate rewrite access URLs', async () => {
  for (const accessUrl of ['/transform', '/transform-alias']) {
    const saved = { source: '/photo/one', refresh: true, slots: {
      '::{}::children': { branch: 'transform', url: '/transform', accessUrl },
      '::{}::modal': { branch: '@modal/(.)photo/[id]', url: '/photo/one' },
    } };
    const response = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(saved)) } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /branch=source/);
    const flight = await response.text();
    assert.match(flight, /branch-user:none:source/);
    assert.match(flight, /destination-user:current:none/);
    assert.match(flight, /Metadata branch-user/);
    assert.doesNotMatch(flight, /routingInvalid/);
  }
  const forged = { source: '/photo/one', refresh: true, slots: {
    '::{}::children': { branch: 'admin', url: '/admin', accessUrl: '/login' },
    '::{}::modal': { branch: '@modal/(.)photo/[id]', url: '/photo/one' },
  } };
  const response = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(forged)) } });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /Protected admin/);
});

test('intercepted Flight bypasses canonical Full Route Cache without changing cached HTML', async () => {
  const cached = await routingFixture({ staticOnly: true });
  let instance;
  try {
    await cached.build(); instance = await startServer(cached.root);
    await (await fetch(`${instance.url}/docs/photo/one`)).arrayBuffer();
    const hit = await fetch(`${instance.url}/docs/photo/one`);
    assert.equal(hit.headers.get('x-nextjs-cache'), 'HIT');
    assert.match(await hit.text(), /Canonical photo/);
    const soft = await fetch(`${instance.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(state)) } });
    assert.equal(soft.headers.get('x-nextjs-cache'), null);
    assert.match(soft.headers.get('cache-control'), /private/);
    assert.match(soft.headers.get('vary'), /x-rustyx-router-state/i);
    assert.match(await soft.text(), /Modal photo/);
    const after = await fetch(`${instance.url}/docs/photo/one`);
    assert.equal(after.headers.get('x-nextjs-cache'), 'HIT');
    assert.match(await after.text(), /Canonical photo/);
  } finally { await instance?.close(); await cached.remove(); }
});
