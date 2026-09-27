import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { scanProject } from './scan.mjs';
import { appRouteParts } from './app-routing.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.prnext-routing-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source);
    }
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('interception counts URL segments while ignoring groups and slots', () => {
  assert.deepEqual(appRouteParts(['(group)', 'users', '[user]', '@modal', '(..)(..)photo', '[id]']).url, ['photo', '[id]']);
  assert.deepEqual(appRouteParts(['users', '[user]', '@modal', '(...)photo', '[id]']).url, ['photo', '[id]']);
  assert.throws(() => appRouteParts(['@modal', '(..)photo']), /above the app root/);
});

test('parallel generators contribute concrete HTML/Flight seeds and share parent work', async () => {
  await fixture({
    'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
    'app/[team]/layout.jsx': `let calls=0;export function generateStaticParams(){if(++calls>1)throw new Error('Repeated parent generator');return [{team:'alpha'}]}export const dynamicParams=false;export default({children,detail})=><section>{children}{detail}</section>`,
    'app/[team]/[id]/page.jsx': `export default async({params})=><h1>Main {(await params).id}</h1>`,
    'app/[team]/@detail/[id]/page.jsx': `export function generateStaticParams({params}){if(params.team!=='alpha')throw new Error('Parent scope lost');return[{id:'one'},{id:'two'}]}export default async({params})=><h2>Detail {(await params).id}</h2>`,
  }, async root => {
    const result = await build(root);
    const route = result.routes.find(item => item.pattern === '/[team]/[id]');
    assert.deepEqual(route.allowedPaths, ['/alpha/one', '/alpha/two']);
    for (const name of ['one', 'two']) {
      const seed = result.prerendered.find(item => item.path === `/alpha/${name}`);
      assert.ok(seed);
      assert.match(await readFile(path.join(result.outputDirectory, seed.file), 'utf8'), new RegExp(`Main.*${name}`));
      assert.match(await readFile(path.join(result.outputDirectory, seed.dataFile), 'utf8'), /Detail/);
    }
  });
});

test('ambiguous pages in the same slot are rejected', async () => {
  await fixture({
    'app/layout.jsx': `export default({children,detail})=><html><body>{children}{detail}</body></html>`,
    'app/page.jsx': 'export default()=>null',
    'app/@detail/(one)/page.jsx': 'export default()=>null',
    'app/@detail/(two)/page.jsx': 'export default()=>null',
  }, async root => { await assert.rejects(scanProject(root), /Conflicting App routes/); });
});

test('parallel generators remap distinct slot parameter names to the canonical URL', async () => {
  await fixture({
    'app/layout.jsx': `export default({children,detail})=><html><body>{children}{detail}</body></html>`,
    'app/[category]/[...slug]/page.jsx': `export const dynamicParams=false;export default async({params})=><h1>Main {JSON.stringify(await params)}</h1>`,
    'app/@detail/[kind]/[...parts]/page.jsx': `export function generateStaticParams(){return[{kind:'book',parts:['one','two']}]}export default async({params})=><h2>Detail {JSON.stringify(await params)}</h2>`,
  }, async root => {
    const result = await build(root);
    const route = result.routes.find(item => item.pattern === '/[category]/[...slug]');
    assert.deepEqual(route.allowedPaths, ['/book/one/two']);
    const seed = result.prerendered.find(item => item.path === '/book/one/two');
    const html = await readFile(path.join(result.outputDirectory, seed.file), 'utf8');
    assert.match(html, /category.*book.*slug.*one.*two/);
    assert.match(html, /kind.*book.*parts.*one.*two/);
  });
});
