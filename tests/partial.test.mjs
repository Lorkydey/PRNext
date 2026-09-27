import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { partialFixture } from './partial-fixture.mjs';
import { startServer } from './support.mjs';

test('PPR resumes request promises inside Map and Set client props without sharing visitor data', async () => {
  const fixture=await partialFixture();let server;
  try {
    const files={
      'app/collections/page.jsx':`import{Suspense}from'react';import{cookies}from'next/headers';import Collections from'./client';async function visitor(){return (await cookies()).get('name')?.value||'guest'}export default function Page(){const value=visitor();return <><h1>Collection shell</h1><Suspense fallback={<p>Waiting collections</p>}><Collections map={new Map([['visitor',value],['date',new Date('2020-01-01')]])} set={new Set([value])}/></Suspense></>}`,
      'app/collections/client.jsx':`'use client';import{use}from'react';export default function Collections({map,set}){return <p data-testid="collections">{use(map.get('visitor'))+'|'+use([...set][0])+'|'+map.get('date').getUTCFullYear()}</p>}`,
    };
    for(const [name,source] of Object.entries(files)){const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    const manifest=await fixture.build();
    assert.ok(manifest.routes.find(route=>route.pattern==='/collections').ppr['/collections']);
    server=await startServer(fixture.root);
    for(const visitor of ['Ada','Lin']) {
      const response=await fetch(server.url+'/collections',{headers:{cookie:'name='+visitor}});
      assert.equal(response.headers.get('x-prnext-prerender'),'partial');
      assert.match(await response.text(),new RegExp(`data-testid="collections">${visitor}\\|${visitor}\\|2020<`));
      const flight=await fetch(server.url+'/collections',{headers:{cookie:'name='+visitor,RSC:'1'}}).then(r=>r.text());
      assert.match(flight,new RegExp(visitor));assert.doesNotMatch(flight,/PRNEXT_PPR_DYNAMIC/);
    }
  } finally {await server?.close();await fixture.remove();}
});

test('native PPR sends a build-time shell before request work and isolates HTML/Flight visitors', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    const manifest = await fixture.build();
    const route = manifest.routes.find(route => route.pattern === '/');
    const artifact = JSON.parse(await readFile(path.join(fixture.root, '.prnext', route.ppr['/']), 'utf8'));
    const stamp = /Built [a-f\d-]+/.exec(artifact.shell)[0];
    server = await startServer(fixture.root);
    const start = performance.now();
    const response = await fetch(server.url, { headers: { cookie: 'name=Ada', 'x-test-delay': '800' } });
    assert.equal(response.headers.get('x-prnext-prerender'), 'partial');
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(performance.now() - start < 650, 'The shell must not await the 800 ms personal component');
    let html = Buffer.from(first.value).toString();
    assert.ok(html.includes(stamp));
    assert.match(html, /Waiting for request/);
    assert.doesNotMatch(html, /data-testid="personal"/);
    for (;;) { const next = await reader.read(); if (next.done) break; html += Buffer.from(next.value).toString(); }
    assert.match(html, /data-testid="personal">Ada</);
    assert.match(html, /\$RC\("B:0"/);
    const other = await fetch(server.url, { headers: { cookie: 'name=Lin' } }).then(response => response.text());
    assert.ok(other.includes(stamp));
    assert.match(other, /data-testid="personal">Lin</);
    assert.doesNotMatch(other, />Ada</);
    const flight = await fetch(server.url, { headers: { RSC: '1', cookie: 'name=Flight' } }).then(response => response.text());
    assert.ok(flight.includes(stamp));
    assert.match(flight, /Flight/);
    assert.doesNotMatch(flight, /PRNEXT_PPR_DYNAMIC/);
    assert.equal((await fetch(server.url + '/' + route.ppr['/'])).status, 404);
  } finally { await server?.close(); await fixture.remove(); }
});

test('partial artifacts survive restart, invalidate through native generations and resume searchParams', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    await fixture.build();
    server = await startServer(fixture.root);
    const html = () => fetch(server.url).then(response => response.text());
    const stamp = source => /Built [a-f\d-]+/.exec(source)[0];
    const before = stamp(await html());
    await server.close();
    server = await startServer(fixture.root);
    assert.equal(stamp(await html()), before);
    assert.equal((await fetch(server.url + '/invalidate', { method: 'POST' })).status, 200);
    const changed = stamp(await html());
    assert.notEqual(changed, before);
    assert.equal(stamp(await html()), changed);
    const query = await fetch(server.url + '/query?q=dynamic-value');
    assert.equal(query.headers.get('x-prnext-prerender'), 'partial');
    assert.match(await query.text(), /data-testid="query">dynamic-value</);
    const clientQuery = await fetch(server.url + '/client-query?q=client-dynamic');
    assert.equal(clientQuery.headers.get('x-prnext-prerender'), 'partial');
    assert.match(await clientQuery.text(), /data-testid="client-query">client-dynamic</);
  } finally { await server?.close(); await fixture.remove(); }
});

test('partial cached siblings expire and invalidate while private cache, connection, fetch and metadata stay request-bound', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    await fixture.build();
    assert.equal(fixture.fetches(), 0);
    server = await startServer(fixture.root);
    const mixed = () => fetch(server.url + '/mixed', { headers: { cookie: 'name=Private visitor' } }).then(response => response.text());
    const value = html => /Cached [a-f\d-]+/.exec(html)?.[0];
    const first = await mixed();
    assert.match(first, /data-testid="private">Private visitor</);
    assert.match(first, /data-testid="connection">Request connected</);
    assert.match(first, /data-testid="network">Network response</);
    assert.equal(fixture.fetches(), 1);
    assert.equal(value(await mixed()), value(first));
    await new Promise(resolve => setTimeout(resolve, 1100));
    const expired = await mixed();
    assert.notEqual(value(expired), value(first));
    await fetch(server.url + '/tag', { method: 'POST' });
    assert.notEqual(value(await mixed()), value(expired));
    const metadata = await fetch(server.url + '/metadata', { headers: { cookie: 'name=Metadata visitor' } });
    assert.equal(metadata.headers.get('x-prnext-prerender'), 'partial');
    assert.match(await metadata.text(), /<title>Hello Metadata visitor<\/title>/);
    const redirected = await fetch(server.url + '/redirect');
    assert.equal(redirected.headers.get('x-prnext-prerender'), 'partial');
    assert.match(await redirected.text(), /http-equiv="refresh"[^>]*\/query\?q=redirected/);
  } finally { await server?.close(); await fixture.remove(); }
});

test('a new build with the same public build ID cannot reuse a previous partial shell', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    await writeFile(path.join(fixture.root, 'prnext.config.mjs'), `export default {cacheComponents:true,generateBuildId:async()=> 'constant-public-id'}`);
    const first = await fixture.build();
    server = await startServer(fixture.root);
    const old = /Built [a-f\d-]+/.exec(await fetch(server.url).then(response => response.text()))[0];
    await server.close();
    const second = await fixture.build();
    assert.equal(first.buildId, second.buildId);
    assert.notEqual(first.cacheId, second.cacheId);
    const route = second.routes.find(route => route.pattern === '/');
    const artifact = JSON.parse(await readFile(path.join(fixture.root, '.prnext', route.ppr['/']), 'utf8'));
    const expected = /Built [a-f\d-]+/.exec(artifact.shell)[0];
    assert.notEqual(expected, old);
    server = await startServer(fixture.root);
    assert.equal(/Built [a-f\d-]+/.exec(await fetch(server.url).then(response => response.text()))[0], expected);
  } finally { await server?.close(); await fixture.remove(); }
});

test('unlisted params and rewrites produce isolated persistent shells and complete routes skip repeat rendering', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    const manifest = await fixture.build();
    assert.equal(manifest.routes.find(route => route.pattern === '/product/[id]').pprFallback, true);
    server = await startServer(fixture.root);
    const stamp = html => /Built [a-f\d-]+/.exec(html)[0];
    const first = await fetch(server.url + '/product/new', { headers: { cookie: 'name=First' } });
    assert.equal(first.headers.get('x-prnext-prerender'), 'partial');
    const html = await first.text();
    assert.match(html, /data-testid="product">new</);
    assert.match(html, /data-testid="product-visitor">First</);
    const second = await fetch(server.url + '/product/new', { headers: { cookie: 'name=Second', RSC: '1', 'x-prnext-router-state': '{}' } });
    assert.equal(second.headers.get('x-prnext-prerender'), 'partial');
    const flight = await second.text();
    assert.equal(stamp(flight), stamp(html));
    assert.match(flight, /Second/); assert.doesNotMatch(flight, /First|__prnext_unbound__/);
    for (const id of ['seed', 'unlisted']) {
      const generated = await fetch(server.url + '/generated/' + id);
      assert.equal(generated.headers.get('x-prnext-prerender'), 'partial');
      assert.match(await generated.text(), new RegExp(`data-testid="generated">${id}<`));
    }
    const rewrite = await fetch(server.url + '/visible/new', { headers: { cookie: 'name=Rewritten' } });
    assert.equal(rewrite.headers.get('x-prnext-prerender'), 'partial');
    const visible = await rewrite.text();
    assert.match(visible, /data-testid="pathname">\/visible\/new</);
    assert.match(visible, /data-testid="product-visitor">Rewritten</);
    assert.equal(stamp(visible), stamp(html), 'A generic shell is reused while visible pathname resolves inside its hole');
    const complete = await fetch(server.url + '/complete/new');
    assert.equal(complete.headers.get('x-prnext-prerender'), 'partial');
    const full = await complete.text();
    assert.match(full, /data-testid="complete">new:/);
    assert.equal(await fetch(server.url + '/complete/new').then(r => r.text()), full);
    await server.close(); server = await startServer(fixture.root);
    assert.equal(await fetch(server.url + '/complete/new').then(r => r.text()), full);
    assert.equal(stamp(await fetch(server.url + '/product/new').then(r => r.text())), stamp(html));
    await fetch(server.url + '/invalidate', { method: 'POST' });
    assert.notEqual(await fetch(server.url + '/complete/new').then(r => r.text()), full);
  } finally { await server?.close(); await fixture.remove(); }
});

test('CSP nonces and Draft Mode retain per-request rendering', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    await fixture.build(); server = await startServer(fixture.root);
    const normal = await fetch(server.url).then(r => r.text());
    const nonce = await fetch(server.url, { headers: { 'content-security-policy': "script-src 'nonce-unique-request-value'", cookie: 'name=Nonce' } });
    assert.equal(nonce.headers.get('x-prnext-prerender'), null);
    const html = await nonce.text();
    assert.match(html, /nonce="unique-request-value"/); assert.match(html, /data-testid="personal">Nonce</);
    assert.notEqual(/Built [a-f\d-]+/.exec(html)[0], /Built [a-f\d-]+/.exec(normal)[0]);
    const draft = await fetch(server.url + '/draft');
    const cookie = draft.headers.getSetCookie().find(value => value.startsWith('__prerender_bypass=')).split(';')[0];
    const preview = await fetch(server.url, { headers: { cookie: cookie + '; name=Preview' } });
    assert.equal(preview.headers.get('x-prnext-prerender'), null);
    assert.match(await preview.text(), /data-testid="personal">Preview</);
    const after = await fetch(server.url).then(r => r.text());
    assert.equal(/Built [a-f\d-]+/.exec(after)[0], /Built [a-f\d-]+/.exec(normal)[0]);
  } finally { await server?.close(); await fixture.remove(); }
});


test('PPR prefetch shares generic static segments without executing private work', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    const manifest = await fixture.build(); server = await startServer(fixture.root);
    const generic = manifest.routes.find(route => route.pattern === '/product/[id]').pprGeneric[0];
    const artifact = JSON.parse(await readFile(path.join(fixture.root, '.prnext', generic.file), 'utf8'));
    const headers = { RSC: '1', 'x-prnext-prefetch': '1', cookie: 'name=NeverPrefetched' };
    const response = await fetch(server.url + '/product/first', { headers });
    assert.match(response.headers.get('content-type'), /application\/x-prnext-ppr/);
    const first = await response.json();
    assert.equal(first.flight, artifact.flight, 'The build artifact is used before any concrete URL was visited');
    assert.doesNotMatch(Buffer.from(first.flight, 'base64').toString(), /NeverPrefetched/);
    assert.ok(first.keys.some(([, value]) => value.includes('first')));
    const second = await fetch(server.url + '/product/second', { headers: { ...headers, 'x-prnext-prefetch-known': first.id } }).then(r => r.json());
    assert.equal(second.id, first.id); assert.equal(second.flight, undefined);
    assert.ok(second.keys.some(([, value]) => value.includes('second')));
    const mixed = await fetch(server.url + '/mixed', { headers }).then(r => r.json());
    assert.doesNotMatch(Buffer.from(mixed.flight, 'base64').toString(), /NeverPrefetched|Network response/);
    assert.equal(fixture.fetches(), 0);
    const navigation = await fetch(server.url + '/product/second', { headers: { RSC: '1', cookie: 'name=CurrentVisitor' } });
    assert.equal(navigation.headers.get('x-prnext-ppr-id'), first.id);
    assert.match(await navigation.text(), /CurrentVisitor/);
    assert.equal((await fetch(server.url + '/blocking', { headers })).status, 204);
    const invalidated = await fetch(server.url + '/invalidate', { method: 'POST' }); assert.equal(invalidated.status, 200);
    const next = await fetch(server.url + '/product/second', { headers }).then(r => r.json());
    assert.notEqual(next.id, first.id);
  } finally { await server?.close(); await fixture.remove(); }
});


test('generic parallel shells bind aliased slot params and selected segment keys per URL', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    const files = {
      'app/parallel/layout.jsx': `export default({children,detail})=><section>{children}{detail}</section>`,
      'app/parallel/[id]/page.jsx': `import{Suspense}from'react';async function Main({params}){return <p data-testid="parallel-main">{(await params).id}</p>}export default({params})=><Suspense fallback={<p>Main pending</p>}><Main params={params}/></Suspense>`,
      'app/parallel/@detail/[alias]/page.jsx': `import{Suspense}from'react';async function Detail({params}){return <p data-testid="parallel-detail">{(await params).alias}</p>}export default({params})=><Suspense fallback={<p>Detail pending</p>}><Detail params={params}/></Suspense>`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    const manifest = await fixture.build(); server = await startServer(fixture.root);
    const route = manifest.routes.find(route => route.pattern === '/parallel/[id]');
    const generic = JSON.parse(await readFile(path.join(fixture.root, '.prnext', route.pprGeneric[0].file), 'utf8'));
    const stamp = /Built [a-f\d-]+/.exec(generic.shell)[0];
    for (const id of ['alpha', 'beta']) {
      const html = await fetch(server.url + '/parallel/' + id).then(r => r.text());
      assert.ok(html.includes(stamp));
      assert.match(html, new RegExp(`data-testid="parallel-main">${id}<`));
      assert.match(html, new RegExp(`data-testid="parallel-detail">${id}<`));
      const flight = await fetch(server.url + '/parallel/' + id, { headers: { RSC: '1' } }).then(r => r.text());
      assert.doesNotMatch(flight, /__prnext_unbound__/);
    }
  } finally { await server?.close(); await fixture.remove(); }
});

test('partly generated generic shells remain isolated by known parent parameters', async () => {
  const fixture = await partialFixture();
  let server;
  try {
    const files = {
      'app/scoped/[locale]/layout.jsx': `export function generateStaticParams(){return[{locale:'fr'},{locale:'en'}]}export default async({params,children})=><section lang={(await params).locale}>{children}</section>`,
      'app/scoped/[locale]/[item]/page.jsx': `import{Suspense}from'react';async function Item({params}){const p=await params;return <p data-testid="item">{p.locale+':'+p.item}</p>}export default({params})=><Suspense fallback={<p>Waiting item</p>}><Item params={params}/></Suspense>`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    const manifest = await fixture.build(); server = await startServer(fixture.root);
    const route = manifest.routes.find(route => route.pattern === '/scoped/[locale]/[item]');
    assert.equal(route.pprGeneric.length, 2);
    for (const generic of route.pprGeneric) {
      const artifact = JSON.parse(await readFile(path.join(fixture.root, '.prnext', generic.file), 'utf8'));
      const stamp = /Built [a-f\d-]+/.exec(artifact.shell)[0];
      for (const item of ['first', 'second']) {
        const html = await fetch(server.url + '/scoped/' + generic.params.locale + '/' + item).then(r => r.text());
        assert.ok(html.includes(stamp));
        assert.match(html, new RegExp(`lang="${generic.params.locale}"`));
        assert.match(html, new RegExp(`data-testid="item">${generic.params.locale}:${item}<`));
      }
    }
  } finally { await server?.close(); await fixture.remove(); }
});

test('complete generated PPR paths use the native cache while unknown paths resume and invalidations regenerate', async () => {
  const fixture=await partialFixture();let server;
  try {
    const file=path.join(fixture.root,'app/complete/[id]/page.jsx');
    await writeFile(file,"export function generateStaticParams(){return[{id:'seed'}]}\n"+await readFile(file,'utf8'));
    const manifest=await fixture.build(),route=manifest.routes.find(r=>r.pattern==='/complete/[id]');
    assert.equal(route.ssg,true);assert.equal(route.fallback,'ppr');
    server=await startServer(fixture.root);
    const get=async id=>{const r=await fetch(server.url+'/complete/'+id);assert.equal(r.status,200);return {r,html:await r.text()}};
    const first=await get('seed');assert.equal(first.r.headers.get('x-nextjs-cache'),'HIT');
    const stamp=html=>/seed:[a-f\d-]+/.exec(html)?.[0];assert.ok(stamp(first.html));assert.equal(stamp((await get('seed')).html),stamp(first.html));
    const flight=await fetch(server.url+'/complete/seed',{headers:{RSC:'1'}});assert.equal(flight.status,200);assert.ok((await flight.text()).includes(stamp(first.html)));
    assert.ok((await get('other')).html.includes('other:'));
    assert.equal((await fetch(server.url+'/invalidate',{method:'POST'})).status,200);
    assert.notEqual(stamp((await get('seed')).html),stamp(first.html));
  } finally {await server?.close();await fixture.remove()}
});
