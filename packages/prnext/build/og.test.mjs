import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, copyFile, symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {imageResponseRequirement} from './og.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-og-graph-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const put = async (name, source) => { const file = path.join(root, name); await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, source); };
  return {root, put, check: options => imageResponseRequirement(root, options)};
}

test('OG omission certifies emitted static graphs and ignores comment/string lookalikes', async t => {
  const f = await fixture(t);
  await f.put('server/page.mjs', `import {jsx} from 'react/jsx-runtime';import {data} from './chunk.mjs';export const page=()=>jsx('p',{children:data});`);
  await f.put('server/chunk.mjs', `// import {ImageResponse} from 'next/og';\nexport const data="next/og ImageResponse";`);
  await f.put('app-ssr/client.mjs', `import {createElement} from 'react';export default()=>createElement('p',null,'hello');`);
  const result = await f.check();
  assert.equal(result.included, false); assert.equal(result.reason, 'certified-unused');
  assert.equal(result.files, 3); assert.ok(result.bytes > 0);
});

test('OG reachability follows reexports, literal dynamic imports and known compatibility modules', async t => {
  const f = await fixture(t);
  await f.put('server/page.mjs', `export * from './barrel.mjs';`);
  await f.put('server/barrel.mjs', `export const image=()=>import('../compat/og.cjs');`);
  assert.equal((await f.check()).reason, 'image-response-import');
  for (const specifier of ['next/og', 'prnext/og', '@thomas.f/prnext/og', 'next/og.js']) {
    await f.put('server/barrel.mjs', `export {ImageResponse} from '${specifier}';`);
    assert.equal((await f.check()).included, true, specifier);
  }
  await f.put('server/barrel.mjs', `export {cookies} from '../compat/headers.cjs';`);
  await f.put('compat/headers.cjs', 'different installed code');
  assert.equal((await f.check()).reason, 'unverified-framework');
  await copyFile(new URL('../compat/headers.cjs', import.meta.url), path.join(f.root, 'compat/headers.cjs'));
  assert.equal((await f.check()).included, false);
});

test('OG retains its renderer when executable loading or dependencies cannot be certified', async t => {
  const f = await fixture(t);
  const cases = [
    `export const load=name=>import(name)`,
    `export const load=name=>require(name)`,
    `export const load=name=>module.require(name)`,
    `import {createRequire as q} from 'node:module';const load=q(import.meta.url);export const value=name=>load(name)`,
    `import {createRequire as q} from 'node:module';export const factory=()=>q(import.meta.url)`,
    `export const load=()=>eval('import("next/og")')`,
    `export const load=new Function('return import("next/og")')`,
    `export const load=globalThis['Function']('return import("next/og")')`,
    `const f=Function;export const load=f('return import("next/og")')`,
    `export const load=__webpack_require__(42)`,
    `import {runInNewContext} from 'node:vm';export const load=runInNewContext`,
    `import {Worker} from 'node:worker_threads';export const worker=Worker`,
    `import thing from 'unknown-optional-package';export default thing`,
    `const alias=require;export const load=name=>alias(name)`,
    `const x=()=>import('./missing.mjs');export default x`,
    `export const malformed=;`,
  ];
  for (const source of cases) {
    await f.put('server/handler.mjs', source);
    assert.equal((await f.check()).included, true, source);
  }
  await f.put('server/handler.mjs', `import {createRequire as __prnextCreateRequire} from 'node:module';const require=__prnextCreateRequire(import.meta.url);export const path=require('node:path');`);
  assert.equal((await f.check()).included, false, 'the framework createRequire banner is certified with literal builtin imports');
});

test('OG certification is conservative for dev, Edge, symlinks, unexpected files and byte budgets', async t => {
  const f = await fixture(t);
  assert.equal((await f.check({dev: true})).included, true);
  assert.equal((await f.check({manifest: {routes: [{handlerConfig: {runtime: 'edge'}}]}})).included, true);
  await f.put('server/file.mjs', 'x'.repeat(8 * 1024 * 1024 + 1));
  assert.equal((await f.check()).included, true);
  await rm(path.join(f.root, 'server'), {recursive: true});
  await mkdir(path.join(f.root, 'server/nested'), {recursive: true});
  assert.equal((await f.check()).included, true);
  await rm(path.join(f.root, 'server'), {recursive: true});
  await mkdir(path.join(f.root, 'external'));
  await symlink(path.join(f.root, 'external'), path.join(f.root, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.check()).included, true);
});
