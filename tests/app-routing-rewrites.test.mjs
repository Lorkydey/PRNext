import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { routingFixture } from './app-routing-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server;
before(async () => { fixture = await routingFixture({ configurationAliases: true }); await fixture.build(); server = await startServer(fixture.root); });
after(async () => { await server?.close(); await fixture?.remove(); });

function state(accessUrl, url = '/transform', branch = 'transform') {
  return encodeURIComponent(JSON.stringify({ source: '/photo/one', refresh: true, slots: {
    '::{}::children': { branch, url, accessUrl },
    '::{}::modal': { branch: '@modal/(.)photo/[id]', url: '/photo/one' },
  } }));
}
function restore(access, url, branch, headers = {}) {
  return fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': state(access, url, branch), ...headers } });
}

test('restoration uses native middleware then chained beforeFiles, afterFiles and fallback rewrites', async () => {
  for (const [access, query] of [['/config-before', '?origin=first&phase=before'], ['/config-after', '?phase=after'], ['/config-fallback', '?phase=fallback']]) {
    const ordinary = await fetch(`${server.url}/docs${access}`);
    assert.equal(ordinary.status, 200);
    assert.match(await ordinary.text(), /configuration-user/);
    if (access === '/config-before') assert.equal(ordinary.headers.get('x-configured-stage'), 'before-middleware');
    const response = await restore(access, '/transform' + query);
    assert.equal(response.status, 200, access);
    const body = await response.text();
    assert.match(body, /configuration-user:none:source/);
    assert.match(body, /destination-user:current:none/);
    assert.match(body, /Metadata configuration-user/);
    assert.match(response.headers.get('set-cookie'), /branch=source/);
  }
});

test('native restoration rejects config redirects, changed destinations, public files and external rewrites without forwarding', async () => {
  const count = fixture.counts.get('admin') || 0;
  for (const [access, url, branch, headers] of [
    ['/config-gated', '/admin', 'admin', {}],
    ['/config-switch', '/transform', 'transform', { cookie: 'version=next' }],
    ['/config-public', '/transform', 'transform', {}],
    ['/config-external', '/transform', 'transform', {}],
    ['/login', '/admin', 'admin', {}],
  ]) {
    const response = await restore(access, url, branch, headers);
    assert.equal(response.status, 400, access);
    const body = await response.text();
    assert.match(body, /routingInvalid/);
    assert.doesNotMatch(body, /Protected admin|configuration-user|PUBLIC_FILE_MUST_NOT/);
  }
  assert.equal(fixture.counts.get('admin') || 0, count);
  assert.equal(fixture.counts.get('external-proxy'), undefined);
  const allowed = await restore('/config-gated', '/admin', 'admin', { cookie: 'auth=yes' });
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /Protected admin/);
});

test('configuration-only aliases are authorized even when the app has no middleware', async () => {
  const other = await routingFixture({ configurationAliases: true, noMiddleware: true });
  let instance;
  try {
    await other.build(); instance = await startServer(other.root);
    for (const cookie of ['auth=yes', '']) {
      const response = await fetch(`${instance.url}/docs/photo/one`, { headers: { RSC: '1', cookie, 'x-rustyx-router-state': state('/config-gated', '/admin', 'admin') } });
      assert.equal(response.status, cookie ? 200 : 400);
      const body = await response.text();
      if (cookie) assert.match(body, /Protected admin/); else assert.doesNotMatch(body, /Protected admin/);
    }
  } finally { await instance?.close(); await other.remove(); }
});

test('a saved rewrite authorizes its access URL without separately probing the physical pathname', async () => {
  const direct = await fetch(`${server.url}/docs/restricted`, { redirect: 'manual' });
  assert.equal(direct.status, 307);
  const saved = { source: '/restricted', refresh: true, slots: {
    '::{}::children': { branch: 'restricted', url: '/restricted?phase=alias', source: '/restricted?phase=alias', accessUrl: '/config-restricted' },
    '::{}::modal': { branch: '@modal#default', url: '/restricted?phase=alias', source: '/restricted?phase=alias', accessUrl: '/config-restricted' },
  } };
  const response = await fetch(`${server.url}/docs/photo/one`, { headers: { RSC: '1', 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(saved)) } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /configuration-user:none:source/);
});
