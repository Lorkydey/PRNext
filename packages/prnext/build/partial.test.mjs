import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { partialFixture } from '../../../tests/partial-fixture.mjs';

test('Cache Components creates resumable shells and merges live Flight holes without replacing static siblings', async () => {
  const fixture = await partialFixture();
  let runtime;
  try {
    const manifest = await fixture.build();
    assert.equal(fixture.fetches(), 0, 'Uncached network data must not be read during partial prerender');
    const route = manifest.routes.find(route => route.pattern === '/');
    assert.ok(route.ppr?.['/']);
    assert.ok(!manifest.prerendered.some(page => page.path === '/'), 'A partial document must never seed the complete-page cache');
    const distDir = path.join(fixture.root, '.prnext');
    const artifact = JSON.parse(await readFile(path.join(distDir, route.ppr['/']), 'utf8'));
    assert.match(artifact.shell, /Shared catalogue/);
    assert.match(artifact.shell, /Waiting for request/);
    assert.doesNotMatch(artifact.shell, />guest</);
    assert.ok(artifact.postponed.replayNodes.length > 0);
    assert.match(Buffer.from(artifact.flight, 'base64').toString(), /PRNEXT_PPR_DYNAMIC/);
    assert.ok(manifest.routes.find(route => route.pattern === '/query').ppr?.['/query']);
    assert.equal(manifest.routes.find(route => route.pattern === '/product/[id]').pprFallback, true);
    for (const pathname of ['/mixed', '/metadata', '/client-query']) assert.ok(manifest.routes.find(route => route.pattern === pathname).ppr?.[pathname], pathname);
    runtime = await import(pathToFileURL(path.join(distDir, 'runtime/app-render.mjs')).href);
    const result = await runtime.renderFlight({ modulePath: path.join(distDir, route.module), distDir, routePattern: '/', cacheComponents: true,
      production: true, params: {}, url: 'http://test/', method: 'GET', headers: { cookie: 'name=Ada' },
      clientModules: manifest.app.clientModules, actions: manifest.app.actions, actionKey: manifest.app.actionKey,
      partialFlight: artifact.flight });
    const wire = result.body.toString();
    assert.match(wire, /Ada/);
    assert.doesNotMatch(wire, /PRNEXT_PPR_DYNAMIC/);
    const stamp = /Built ([a-f\d-]+)/.exec(artifact.shell)[0];
    assert.match(wire, new RegExp(stamp), 'The final Flight tree must hydrate the original static shell');
    const rendered = await runtime.renderAppPage({ modulePath: path.join(distDir, route.module), distDir, manifest, route,
      url: 'http://test/', headers: { cookie: 'name=Grace' }, production: true, stream: false });
    assert.equal(rendered.headers['x-prnext-prerender'], 'partial');
    assert.match(rendered.body.toString(), /Grace/);
    assert.match(rendered.body.toString(), /\$RC/);
  } finally { await runtime?.closeAppRuntime(); await fixture.remove(); }
});


test('Cache Components rejects missing Suspense, unknown params and empty generateStaticParams', async () => {
  const fixture = await partialFixture();
  const page = path.join(fixture.root, 'app/invalid/page.jsx');
  try {
    await mkdir(path.dirname(page), { recursive: true });
    await writeFile(page, `import{cookies}from'next/headers';export default async()=> <p>{(await cookies()).get('name')?.value}</p>`);
    await assert.rejects(fixture.build(), /uncached data was accessed outside of <Suspense>/);
    await writeFile(page, `import{cookies}from'next/headers';export async function generateMetadata(){return{title:(await cookies()).get('name')?.value||'guest'}}export default()=> <p>Static content</p>`);
    await assert.rejects(fixture.build(), /generateMetadata\(\) accesses uncached or request data while the page content is static/);
    await writeFile(page, `import{cookies}from'next/headers';export const instant=false;export default async()=> <p>{(await cookies()).get('name')?.value}</p>`);
    const blocking = await fixture.build();
    assert.equal(blocking.routes.find(route => route.pattern === '/invalid').pprFallback, undefined);
    await rm(path.dirname(page), { recursive: true });
    const dynamic = path.join(fixture.root, 'app/product/[id]/page.jsx');
    await writeFile(dynamic, `export default async({params})=> <p>{(await params).id}</p>`);
    await assert.rejects(fixture.build(), /uncached data was accessed outside of <Suspense>/);
    await writeFile(dynamic, `export function generateStaticParams(){return []}export default async({params})=> <p>{(await params).id}</p>`);
    await assert.rejects(fixture.build(), /must return at least one parameter object/);
    await writeFile(dynamic, `import{cookies}from'next/headers';export async function generateMetadata(){return{title:(await cookies()).get('name')?.value||'guest'}}export default()=> <p>Static content</p>`);
    await assert.rejects(fixture.build(), /generateMetadata\(\) accesses uncached or request data while the page content is static/);
  } finally { await fixture.remove(); }
});


test('development reports Cache Components data outside Suspense before SSR', async () => {
  const fixture = await partialFixture();
  let runtime;
  try {
    const page = path.join(fixture.root, 'app/invalid/page.jsx');
    await mkdir(path.dirname(page), { recursive: true });
    await writeFile(page, `import{cookies}from'next/headers';export default async()=> <p>{(await cookies()).get('name')?.value}</p>`);
    const { build } = await import('./index.mjs');
    const manifest = await build(fixture.root, { dev: true });
    const distDir = manifest.outputDirectory;
    runtime = await import(pathToFileURL(path.join(distDir, 'runtime/app-render.mjs')).href);
    const route = manifest.routes.find(route => route.pattern === '/invalid');
    await assert.rejects(runtime.renderAppPage({ manifest, distDir, route, modulePath: path.join(distDir, route.module), url: 'http://test/invalid', production: false }), /uncached data was accessed outside of <Suspense>/);
  } finally { await runtime?.closeAppRuntime(); await fixture.remove(); }
});

test('partial parameter generators retain known layout params and optional catchalls remain dynamic', async () => {
  const fixture = await partialFixture();
  try {
    const files = {
      'app/scoped/[locale]/layout.jsx': `export function generateStaticParams(){return[{locale:'fr'}]}export default async({params,children})=> <section lang={(await params).locale}>{children}</section>`,
      'app/scoped/[locale]/[item]/page.jsx': `import{Suspense}from'react';async function Item({params}){return <p>{(await params).item}</p>}export default({params})=> <Suspense fallback={<p>Waiting item</p>}><Item params={params}/></Suspense>`,
      'app/optional/[[...items]]/page.jsx': `import{Suspense}from'react';async function Item({params}){return <p>{(await params).items?.join('/')||'none'}</p>}export default({params})=> <Suspense fallback={<p>Waiting items</p>}><Item params={params}/></Suspense>`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    const manifest = await fixture.build();
    assert.equal(manifest.routes.find(route => route.pattern === '/scoped/[locale]/[item]').pprFallback, true);
    assert.equal(manifest.routes.find(route => route.pattern === '/optional/[[...items]]').pprFallback, true);
    assert.ok(!manifest.prerendered.some(item => item.path === '/optional'), 'An absent optional param is still unknown when no generator supplies it');
    const file = path.join(fixture.root, 'app/optional/[[...items]]/page.jsx');
    await writeFile(file, `export default async({params})=> <p>{(await params).items?.join('/')||'none'}</p>`);
    await assert.rejects(fixture.build(), /uncached data was accessed outside of <Suspense>/);
  } finally { await fixture.remove(); }
});

test('instant objects distinguish optional navigation diagnostics from mandatory shell checks', async () => {
  const fixture = await partialFixture();
  let runtime;
  try {
    const layout = path.join(fixture.root, 'app/layout.jsx');
    await writeFile(layout, `import{Suspense}from'react';export default({children})=><html><body><Suspense fallback={<p>Initial document fallback</p>}>{children}</Suspense></body></html>`);
    const page = path.join(fixture.root, 'app/instant/page.jsx');
    await mkdir(path.dirname(page), { recursive: true });
    const source = config => `import{cookies}from'next/headers';export const instant=${config};export default async()=> <p>{(await cookies()).get('name')?.value||'visitor'}</p>`;
    await writeFile(page, source("{level:'experimental-error'}"));
    await assert.rejects(fixture.build(), /instant navigation below shared layout.*would block/);
    await writeFile(page, source("{level:'experimental-error',unstable_disableBuildValidation:true}"));
    await assert.doesNotReject(fixture.build());
    await writeFile(page, source("{level:'warning'}"));
    await assert.doesNotReject(fixture.build(), 'Warnings must not fail production builds');
    const { build } = await import('./index.mjs');
    const manifest = await build(fixture.root, { dev: true });
    const distDir = manifest.outputDirectory;
    runtime = await import(pathToFileURL(path.join(distDir, 'runtime/app-render.mjs')).href);
    const route = manifest.routes.find(route => route.pattern === '/instant');
    const response = await runtime.renderAppPage({ manifest, distDir, route, modulePath: path.join(distDir, route.module), url: 'http://test/instant', headers: { RSC: '1' }, production: false });
    assert.match(response.body.toString(), /instant navigation below shared layout/);
    await runtime.closeAppRuntime(); runtime = null;
    await writeFile(layout, `export default({children})=><html><body>{children}</body></html>`);
    await writeFile(page, source("{level:'warning',unstable_disableValidation:true}"));
    await assert.rejects(fixture.build(), /outside of <Suspense>/, 'Disabling navigation probes never permits an invalid shared shell');
  } finally { await runtime?.closeAppRuntime(); await fixture.remove(); }
});

test('instant runtime samples exercise declared cookie/header/search values without publishing them in PPR shells',async()=>{
  const fixture=await partialFixture();
  try{
    await writeFile(path.join(fixture.root,'app/layout.jsx'),`import{Suspense}from'react';export default({children})=><html><body><Suspense fallback={<p>shell</p>}>{children}</Suspense></body></html>`);
    const directory=path.join(fixture.root,'app/sampled');await mkdir(directory,{recursive:true});
    const source=cookie=>`import{cookies,headers}from'next/headers';export const instant={level:'experimental-error',unstable_samples:[{cookies:[{name:'session',value:${JSON.stringify(cookie)}}],headers:[['x-test','header']],searchParams:{q:'query'}}]};export default async function Page({searchParams}){return <p>{(await cookies()).get('session')?.value||'absent'}:{(await headers()).get('x-test')}:{(await searchParams).q}</p>}`;
    await writeFile(path.join(directory,'page.jsx'),source('PRIVATE_SAMPLE_SENTINEL'));
    const manifest = await fixture.build();
    const sampled = manifest.routes.find(route=>route.pattern==='/sampled');
    for (const file of Object.values(sampled.ppr || {})) assert.ok(!(await readFile(path.join(fixture.root,'.prnext',file),'utf8')).includes('PRIVATE_SAMPLE_SENTINEL'));
    // A declared null is readable absence. An undeclared name is an actionable error.
    await writeFile(path.join(directory,'page.jsx'),source(null));await assert.doesNotReject(fixture.build());
    await writeFile(path.join(directory,'page.jsx'),source('known').replace("get('session')","get('undeclared')"));
    await assert.rejects(fixture.build(),/unstable_samples.*undeclared/);
  }finally{await fixture.remove()}
});
