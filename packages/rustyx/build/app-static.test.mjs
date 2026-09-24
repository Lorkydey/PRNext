import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { appStaticEntries } from './app-static.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.rustyx-app-static-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const rootLayout = `export const revalidate=90;export default({children})=><html><body>{children}</body></html>`;

test('App parameter materialization escapes paths, deduplicates, and validates partial generation', () => {
  assert.deepEqual(appStaticEntries('/café/[team]/[...slug]', [{ team: 'a b', slug: ['one', 'two'] }, { team: 'a b', slug: ['one', 'two'] }, { team: 'parent-only' }]), [{ path: '/caf%C3%A9/a%20b/one/two', params: { team: 'a b', slug: ['one', 'two'] } }]);
  assert.deepEqual(appStaticEntries('/docs/[[...slug]]', [{}]), [{ path: '/docs', params: {} }]);
  assert.throws(() => appStaticEntries('/[team]/[item]', [{ team: '../secret' }]), /generateStaticParams.*path separators/);
  assert.throws(() => appStaticEntries('/[team]/[item]', [{ team: 12 }]), /generateStaticParams.*string/);
  assert.deepEqual(appStaticEntries('/[team]', [Object.create({ team: 'inherited' })]), []);
});

test('App build emits real HTML/Flight pairs and composes scoped generators across groups', async () => {
  await fixture({
    'app/layout.tsx': rootLayout,
    'app/page.tsx': 'export default()=> <h1>Static App home</h1>',
    'app/(shop)/[team]/layout.tsx': `export const dynamicParams=false;export const revalidate=40;
      export const generateStaticParams=()=>[{team:'café'},{team:'two'}];export default({children})=>children;`,
    'app/(shop)/[team]/items/[...slug]/page.tsx': `export const revalidate=60;
      export function generateStaticParams({params}){if(Object.keys(params).join(',')!=='team')throw new Error('Wrong parent scope');return [{slug:[params.team+' item','last']},{slug:[params.team+' item','last']}]}
      export default async function Page({params}){const value=await params;return <h1>{value.team}:{value.slug.join('/')}</h1>}`,
    'app/empty/[id]/page.tsx': `export const generateStaticParams=()=>[];export default async({params})=><h1>{(await params).id}</h1>`,
    'app/forced/[id]/page.tsx': `export const dynamic='force-static';export default async({params})=><h1>{(await params).id}</h1>`,
    'app/strict/[id]/page.tsx': `export const dynamic='error';export default async({params})=><h1>{(await params).id}</h1>`,
    'app/open/[id]/page.tsx': `export default async({params})=><h1>{(await params).id}</h1>`,
    'app/secret/page.tsx': `import {cookies} from 'next/headers';export default async()=> <h1>{(await cookies()).get('secret')?.value||'anonymous'}</h1>`,
    'app/forced-empty/page.tsx': `import {cookies,headers} from 'next/headers';export const dynamic='force-static';export default async()=> <h1>{String((await cookies()).size)}:{String((await headers()).get('host'))}</h1>`,
  }, async root => {
    const result = await build(root);
    const routes = new Map(result.routes.map(route => [route.pattern, route]));
    assert.equal(routes.get('/').ssg, true);
    assert.equal(routes.get('/secret').ssg, undefined);
    assert.equal(routes.get('/open/[id]').ssg, undefined);
    for (const pathname of ['/empty/[id]', '/forced/[id]', '/strict/[id]']) {
      assert.equal(routes.get(pathname).ssg, true);
      assert.equal(routes.get(pathname).fallback, 'blocking');
    }
    const nested = routes.get('/[team]/items/[...slug]');
    assert.equal(nested.fallback, false);
    assert.deepEqual(nested.allowedPaths, ['/caf%C3%A9/items/caf%C3%A9%20item/last', '/two/items/two%20item/last']);
    assert.equal(result.prerendered.filter(seed => seed.path !== '/_not-found').length, 4);
    for (const seed of result.prerendered) {
      const html = await readFile(path.join(result.outputDirectory, seed.file), 'utf8');
      const flight = await readFile(path.join(result.outputDirectory, seed.dataFile), 'utf8');
      assert.match(html, /<!DOCTYPE html>/i);
      assert.ok(flight.includes('0:'));
      assert.ok(seed.generatedAt > 0);
      assert.equal(gunzipSync(await readFile(path.join(result.outputDirectory, seed.file + '.gz'))).toString(), html);
      if (seed.path.includes('/items/')) assert.equal(seed.revalidate, 40);
      else assert.equal(seed.revalidate, 90);
    }
    const dev = await build(root, { dev: true });
    assert.deepEqual(dev.prerendered, []);
    assert.ok(dev.routes.every(route => !route.ssg));
    assert.equal(dev.routes.find(route => route.pattern === '/[team]/items/[...slug]').cacheConfig.dynamicParams, false);
  });
});

test('dynamic parameter restrictions survive dynamic bailout and static failures preserve the previous build', async () => {
  await fixture({
    'app/layout.tsx': rootLayout,
    'app/private/[id]/page.tsx': `import {headers} from 'next/headers';export const dynamicParams=false;export const generateStaticParams=()=>[{id:'known'}];export default async()=> <h1>{(await headers()).get('host')}</h1>`,
  }, async root => {
    const result = await build(root);
    const route = result.routes[0];
    assert.deepEqual(route.allowedPaths, ['/private/known']);
    assert.deepEqual(route.dynamicPaths, ['/private/known']);
    assert.equal(result.prerendered.filter(seed => seed.path !== '/_not-found').length, 0);
    const before = await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8');
    await writeFile(path.join(root, 'app/private/[id]/page.tsx'), `import {headers} from 'next/headers';export const dynamic='error';export const generateStaticParams=()=>[{id:'known'}];export default async()=> <h1>{(await headers()).get('host')}</h1>`);
    await assert.rejects(build(root), /static|dynamic|headers/i);
    assert.equal(await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8'), before);
  });
});
