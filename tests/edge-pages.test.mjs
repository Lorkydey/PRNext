import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { edgePagesFixture } from './edge-pages-fixture.mjs';
import { startServer } from './support.mjs';

let fixture, server, manifest;
before(async () => { fixture = await edgePagesFixture(); manifest = await fixture.build(); server = await startServer(fixture.root); });
after(async () => { await server?.close(); await fixture?.remove(); });

test('Edge pages inherit runtime through layouts and render server and client code under Web globals', async () => {
  assert.equal(manifest.routes.find(route => route.pattern === '/edge/[id]').cacheConfig.runtime, 'edge');
  assert.equal(manifest.routes.find(route => route.pattern === '/node').cacheConfig.runtime, undefined);
  await Promise.all(['alice', 'bob', ...Array.from({length:30}, (_,index)=>`visitor-${index}`)].map(async name => {
    const response = await fetch(`${server.url}/docs/edge/${name}`, { headers: { 'x-user': name, cookie: `visitor=${name}` } });
    assert.equal(response.status, 200, await response.clone().text());
    const html = (await response.text()).replaceAll('<!-- -->', '');
    assert.match(html, new RegExp(`edge-runtime:undefined:${name}:${name}:32:true`));
    assert.match(html, new RegExp(`2026:${name}:web:web-form:255:error`));
    assert.match(html, /<button>page 0<\/button>/);
    assert.match(html, new RegExp(`<title>Edge ${name} ${name}</title>`));
  }));
});

test('Edge Flight and not-found controls coexist with unchanged Node SSR for shared clients', async () => {
  const flight = await fetch(`${server.url}/docs/edge/one`, { headers: { RSC: '1', 'x-user': 'flight' } });
  assert.equal(flight.status, 200); assert.match(await flight.text(), /edge-runtime:undefined:flight/);
  const other = await fetch(`${server.url}/docs/edge/other`);
  assert.equal(other.status, 200, await other.clone().text()); assert.match(await other.text(), /Shared Edge realm/);
  const previous = await fetch(`${server.url}/docs/edge/one`);
  assert.equal(previous.status, 200, 'the previous factory keeps its lexical bindings');
  const missing = await fetch(`${server.url}/docs/edge/missing`);
  assert.equal(missing.status, 404); assert.match(await missing.text(), /Edge missing/);
  const node = await fetch(`${server.url}/docs/node`);
  assert.equal(node.status, 200); assert.match((await node.text()).replaceAll('<!-- -->', ''), /Node page function/);
});
