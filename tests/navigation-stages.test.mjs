import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationStagesFixture } from './navigation-stages-fixture.mjs';
import { startServer } from './support.mjs';

test('real App shell and per-link prefetch defer distinct runtime work and preserve static prerenders', { timeout: 90000 }, async t => {
  const fixture = await navigationStagesFixture(); let server;
  t.after(async () => { await server?.close(); await fixture.remove(); });
  await fixture.build(); server = await startServer(fixture.root); fixture.reset();
  const request = async (stage, tenant = 'one', route = '/stages') => {
    const response = await fetch(server.url + route, { headers: { RSC: '1', Accept: 'application/x-prnext-ppr+json', 'x-prnext-prefetch': '1', 'x-prnext-prefetch-stage': stage, cookie: 'tenant=' + tenant } });
    const body = await response.text(); assert.equal(response.status, 200, body);
    assert.match(response.headers.get('cache-control'), /private/);
    return JSON.parse(body);
  };
  const shell = await request('shell');
  assert.deepEqual(Object.fromEntries(fixture.counts), { shell: 1 });
  const full = await request('prefetch');
  assert.deepEqual(Object.fromEntries(fixture.counts), { shell: 2, prefetch: 1 });
  assert.equal(shell.id, full.id);
  const other = await request('shell', 'two'); assert.notEqual(other.id, shell.id);
  const nav = await fetch(server.url + '/stages', { headers: { RSC: '1', cookie: 'tenant=one' } });
  assert.equal(nav.headers.get('x-prnext-ppr-id'), shell.id); assert.equal(nav.status, 200); await nav.text();
  assert.equal(fixture.counts.get('navigation'), 1);
  const staticPage = await fetch(server.url + '/static'); assert.match(await staticPage.text(), /Fully static gates/);
  fixture.reset(); await request('shell', 'one', '/ensure-shell');
  assert.equal(fixture.counts.size, 0, 'a constrained shell executes no runtime data');
  await request('prefetch', 'one', '/ensure-prefetch');
  assert.equal(fixture.counts.size, 0, 'a constrained per-link prefetch remains static');
});

test('ensureStatic navigation rejects request data and incomplete dynamic parameters during a real build', { timeout: 90000 }, async t => {
  const fixture = await navigationStagesFixture(); t.after(() => fixture.remove());
  await fixture.write('app/static/page.jsx', `import{cookies}from'next/headers';export const ensureStatic='navigation';export default async()=> <h1>{(await cookies()).get('private')?.value}</h1>`);
  await assert.rejects(fixture.build(), /ensureStatic='navigation'.*cookies/s);
  await fixture.write('app/static/page.jsx', `import{cacheLife}from'next/cache';export const ensureStatic='navigation';export default async function Page(){'use cache';cacheLife({stale:0,revalidate:60,expire:600});return <h1>Short cache</h1>}`);
  await assert.rejects(fixture.build(), /ensureStatic='navigation'.*stale below 30/s);
  await fixture.write('app/static/page.jsx', `export const ensureStatic='navigation';export default()=> <h1>Static</h1>`);
  await fixture.write('app/item/[id]/page.jsx', `export const ensureStatic='navigation';export default()=> <h1>Item</h1>`);
  await assert.rejects(fixture.build(), /complete, nonempty parameter sets/);
});
