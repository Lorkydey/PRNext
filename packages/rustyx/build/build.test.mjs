import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject, routePattern } from './scan.mjs';
import { stripServerCode, assertSupportedSource } from './transform.mjs';
import { build, staticPath } from './index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

async function fixture(files, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rustyx-scan-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), contents);
    }
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('scans pages, API, _app and dynamic routes with stable IDs', async () => {
  await fixture({ 'src/pages/index.tsx': '', 'src/pages/_app.tsx': '', 'src/pages/posts/[id].tsx': '', 'src/pages/api/hello.ts': '', 'src/pages/types.d.ts': '' }, async root => {
    const first = await scanProject(root);
    const second = await scanProject(root);
    assert.deepEqual(first, second);
    assert.equal(first.routes.length, 3);
    assert.equal(first.app, path.join(root, 'src/pages/_app.tsx'));
    assert.ok(first.routes.some(route => route.kind === 'api' && route.pattern === '/api/hello'));
    assert.ok(first.routes.some(route => route.pattern === '/posts/[id]'));
  });
});

test('rejects conflicting routes and unsupported frameworks instead of ignoring them', async () => {
  await fixture({ 'pages/index.tsx': '', 'pages/index.js': '' }, root => assert.rejects(scanProject(root), /Conflicting routes/));
  await fixture({ 'pages/[id].tsx': '', 'pages/[slug].tsx': '' }, root => assert.rejects(scanProject(root), /Conflicting routes/));
  await fixture({ 'pages/index.tsx': '', 'app/page.tsx': '' }, root => assert.rejects(scanProject(root), /App Router/));
  assert.throws(() => routePattern('[...all]/extra.tsx'), /final segment/);
  assert.throws(() => routePattern('[id]/[id].tsx'), /Duplicate parameter/);
});

test('removes data loader and transitive server-only dependencies', () => {
  const client = stripServerCode(`
    import { readFileSync } from 'node:fs';
    import { connect } from './server-database';
    import React from 'react';
    import './global.css';
    const secret = 'SERVER_SECRET_MUST_NOT_LEAK';
    const database = connect(secret);
    const getData = () => database.query(readFileSync('/etc/hosts'));
    export async function getServerSideProps() { return {props: {data: getData()}}; }
    export default function Page({data}) { return <main>{data}</main>; }
  `);
  for (const secret of ['node:fs', 'server-database', 'SERVER_SECRET_MUST_NOT_LEAK', 'getServerSideProps', 'getData', 'database']) assert.ok(!client.includes(secret), client);
  assert.match(client, /global.css/);
  assert.match(client, /function Page/);
});

test('preserves shared helpers and mixed import bindings used by page', () => {
  const client = stripServerCode(`
    import { clientFormat, serverRead } from './utilities';
    const shared = value => clientFormat(value);
    export const getStaticProps = () => ({props: {x: shared(serverRead())}});
    export const getStaticPaths = () => ({paths: [], fallback: false});
    export default function Page({x}) { return <p>{shared(x)}</p>; }
  `);
  assert.match(client, /clientFormat/);
  assert.match(client, /shared/);
  assert.ok(!client.includes('serverRead'));
  assert.ok(!client.includes('getStaticProps'));
  assert.ok(!client.includes('getStaticPaths'));
});

test('supports aliased loader exports and removes direct loader re-exports', () => {
  const client = stripServerCode(`
    import loader from './server-loader';
    export {loader as getServerSideProps};
    export {other as getStaticPaths} from './server-paths';
    export default function Page() { return <p>Hello</p>; }
  `);
  assert.ok(!client.includes('server-loader'));
  assert.ok(!client.includes('server-paths'));
  assert.match(client, /Hello/);
});

test('preserves unrelated side effects while removing server dependency graph', () => {
  const client = stripServerCode(`
    import { secret } from './private';
    const sideEffect = registerBrowserWidget();
    export async function getServerSideProps() { return {props: {x:secret}}; }
    export default function Page() { return null; }
  `);
  assert.match(client, /registerBrowserWidget/);
  assert.ok(!client.includes('./private'));
});

test('rejects unsafe wildcard page exports and Server Actions', () => {
  assert.throws(() => stripServerCode(`export * from './server'; export default () => null;`), /Wildcard/);
  assert.throws(() => assertSupportedSource(`export async function action() { 'use server'; return 1; }`, 'page.js'), /Server Actions/);
  assert.doesNotThrow(() => assertSupportedSource(`const label = 'use server';`, 'page.js'));
});

test('validates and materializes getStaticPaths params and catches mismatched strings', () => {
  assert.deepEqual(staticPath('/posts/[id]', {params: {id: 'first'}}), {path: '/posts/first', params: {id: 'first'}});
  assert.deepEqual(staticPath('/docs/[...slug]', '/docs/a/b'), {path: '/docs/a/b', params: {slug: ['a', 'b']}});
  assert.deepEqual(staticPath('/[[...slug]]', {params: {slug: []}}), {path: '/', params: {slug: []}});
  assert.throws(() => staticPath('/posts/[id]', '/different/first'), /does not match/);
  assert.throws(() => staticPath('/posts/[id]', {params: {id: 1}}), /nonempty string/);
  assert.throws(() => staticPath('/docs/[...slug]', {params: {slug: []}}), /nonempty array/);
  assert.throws(() => staticPath('/posts/[id]', {params: {id: '..'}}), /traversal/);
  assert.throws(() => staticPath('/posts/[id]', '/posts/secret%2Ffile'), /path separators/);
  assert.deepEqual(staticPath('/posts/[id]', '/posts/caf%C3%A9'), {path: '/posts/caf%C3%A9', params: {id: 'café'}});
});

test('build emits hydrated assets and SSG, excludes server dependencies, and preserves the last good build', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repo, '.rustyx-compiler-test-'));
  try {
    await mkdir(path.join(root, 'pages/blog'), { recursive: true });
    await writeFile(path.join(root, 'pages/index.tsx'), `
      import Head from 'next/head';
      import {readFileSync} from 'node:fs';
      import './global.css';
      const privateToken = 'RUSTYX_PRIVATE_COMPILER_SENTINEL';
      const readSecret = () => readFileSync('/dev/null', 'utf8') + privateToken;
      export function getServerSideProps() { return {props:{secret: readSecret()}}; }
      export default function Page() { return <><Head><title>Compiler</title></Head><h1>Home</h1></>; }
    `);
    await writeFile(path.join(root, 'pages/global.css'), 'h1{color:teal}');
    await writeFile(path.join(root, 'pages/blog/[id].tsx'), `
      export const getStaticProps = ({params}) => ({props:{id:params.id}});
      export const getStaticPaths = () => ({paths:[{params:{id:'hello'}}],fallback:false});
      export default function Blog({id}) { return <h1>Article {id}</h1>; }
    `);
    const first = await build(root);
    assert.equal(first.routes.filter(route => !route.internal).length, 2);
    assert.equal(first.prerendered.filter(seed => !seed.path.startsWith('/_rustyx/errors/')).length, 1);
    assert.equal(first.prerendered[0].path, '/blog/hello');
    const html = await readFile(path.join(first.outputDirectory, first.prerendered[0].file), 'utf8');
    assert.match(html, /Article/);
    assert.match(html, /hello/);
    assert.match(html, /window\.__RUSTYX_DATA__/);
    assert.equal(gunzipSync(await readFile(path.join(first.outputDirectory, first.prerendered[0].file + '.gz'))).toString(), html);
    const assets = await readdir(path.join(first.outputDirectory, 'assets'));
    assert.ok(assets.some(file => file.endsWith('.css')));
    assert.ok(assets.some(file => file.endsWith('.js.gz')), 'the published build includes precompressed browser assets');
    for (const file of assets.filter(file => file.endsWith('.js'))) {
      const content = await readFile(path.join(first.outputDirectory, 'assets', file), 'utf8');
      assert.ok(!content.includes('RUSTYX_PRIVATE_COMPILER_SENTINEL'));
      assert.ok(!content.includes('node:fs'));
    }
    const before = await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8');
    await writeFile(path.join(root, 'pages/index.tsx'), 'export default function Broken( {');
    await assert.rejects(build(root));
    assert.equal(await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8'), before);
    await writeFile(path.join(root, 'pages/index.tsx'), 'export default function Page() { return <h1>Home</h1>; }');
    const development = await build(root, {dev:true});
    assert.ok(development.prerendered.some(entry => entry.path === '/blog/hello'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CSS Modules share SSR/browser class maps, scope identical filenames, compose, and emit assets', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repo, '.rustyx-css-test-'));
  try {
    for (const directory of ['pages', 'styles/a', 'styles/b']) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, 'pages/index.tsx'), `
      import a from '../styles/a/Card.module.css';
      import b from '../styles/b/Card.module.css';
      export default function Page() { return <><h1 className={a.card}>A</h1><p className={b.card}>B</p></>; }
    `);
    await writeFile(path.join(root, 'styles/shared.module.css'), '.shared { font-weight: bold }');
    await writeFile(path.join(root, 'styles/a/Card.module.css'), '.card { composes: shared from "../shared.module.css"; color: red; background: url("../image.svg") } :global(.existing) { display: block }');
    await writeFile(path.join(root, 'styles/b/Card.module.css'), '.card { color: blue; background: url("/public-bg.png") }');
    await writeFile(path.join(root, 'styles/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    const result = await build(root);
    const html = await readFile(path.join(result.outputDirectory, result.prerendered[0].file), 'utf8');
    const a = /<h1 class="([^"]+)"/.exec(html)[1];
    const b = /<p class="([^"]+)"/.exec(html)[1];
    assert.notEqual(a, b, 'same CSS basenames in different directories must not collide');
    assert.equal(a.split(' ').length, 2, 'composes includes the imported class');
    const assetFiles = await readdir(path.join(result.outputDirectory, 'assets'));
    const javascript = (await Promise.all(assetFiles.filter(file => file.endsWith('.js')).map(file => readFile(path.join(result.outputDirectory, 'assets', file), 'utf8')))).join('\n');
    const css = (await Promise.all(assetFiles.filter(file => file.endsWith('.css')).map(file => readFile(path.join(result.outputDirectory, 'assets', file), 'utf8')))).join('\n');
    assert.ok(javascript.includes(a));
    assert.ok(javascript.includes(b));
    for (const className of [...a.split(' '), b]) assert.ok(css.includes('.' + className), `missing stylesheet class ${className}`);
    assert.match(css, /\.existing/);
    assert.match(css, /\/_rustyx\/assets\/image-[\w-]+\.svg/);
    assert.match(css, /\/public-bg\.png/);
    assert.ok(assetFiles.some(file => /^image-[\w-]+\.svg$/.test(file)));
    const development = await build(root, {dev:true});
    const devHtml = await readFile(path.join(development.outputDirectory, development.prerendered[0].file), 'utf8');
    assert.ok(devHtml.includes(`class="${a}"`), 'CSS names stay stable between production and development');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('supports native ESM npm default imports, top-level await, and lazy ESM imports', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repo, '.rustyx-esm-test-'));
  try {
    for (const directory of ['pages', 'node_modules/sync-esm', 'node_modules/async-esm', 'node_modules/lazy-esm']) await mkdir(path.join(root, directory), { recursive: true });
    for (const name of ['sync-esm', 'async-esm', 'lazy-esm']) {
      await writeFile(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({name, type:'module', main:'index.js'}));
    }
    await writeFile(path.join(root, 'node_modules/sync-esm/index.js'), `export default value => 'ESM ' + value;`);
    await writeFile(path.join(root, 'node_modules/async-esm/index.js'), `await Promise.resolve(); export default 'ASYNC';`);
    await writeFile(path.join(root, 'node_modules/lazy-esm/index.js'), `await Promise.resolve(); export default 'LAZY_ASYNC';`);
    await writeFile(path.join(root, 'pages/index.tsx'), `import format from 'sync-esm'; export default function Page() { return <h1>{format('works')}</h1>; }`);
    const initial = await build(root);
    assert.match(await readFile(path.join(initial.outputDirectory, initial.prerendered[0].file), 'utf8'), /ESM works/);
    await writeFile(path.join(root, 'pages/index.tsx'), `import value from 'async-esm'; export default function Page() { return <h1>{value}</h1>; }`);
    const asynchronous = await build(root);
    assert.match(await readFile(path.join(asynchronous.outputDirectory, asynchronous.prerendered[0].file), 'utf8'), /ASYNC/);
    await writeFile(path.join(root, 'pages/index.tsx'), `export async function getStaticProps() { const {default:value} = await import('lazy-esm'); return {props:{value}}; } export default function Page({value}) { return <h1>{value}</h1>; }`);
    const lazy = await build(root);
    assert.match(await readFile(path.join(lazy.outputDirectory, lazy.prerendered[0].file), 'utf8'), /LAZY_ASYNC/);
    await writeFile(path.join(root, 'server-helper.cjs'), `const path = require('node:path'); module.exports = () => path.basename('/nested/COMMONJS');`);
    await writeFile(path.join(root, 'pages/index.tsx'), `import helper from '../server-helper.cjs'; export function getStaticProps() { return {props:{value:helper()}}; } export default function Page({value}) { return <h1>{value}</h1>; }`);
    const commonjs = await build(root);
    assert.match(await readFile(path.join(commonjs.outputDirectory, commonjs.prerendered[0].file), 'utf8'), /COMMONJS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SSR routes share one application singleton through hashed ESM chunks', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const root = await mkdtemp(path.join(repo, '.rustyx-split-test-'));
  try {
    await mkdir(path.join(root, 'pages'), { recursive: true });
    await writeFile(path.join(root, 'singleton.ts'), `let count = 0; export const increment = () => ++count;`);
    await writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    for (const name of ['first', 'second']) {
      await writeFile(path.join(root, 'pages', name + '.tsx'), `
        import {increment} from '../singleton';
        import icon from '../icon.svg';
        export function getServerSideProps() { return {props:{count:increment()}}; }
        export default function Page({count}) { return <><output>{count}</output><img src={icon.src} alt="icon"/></>; }
      `);
    }
    const result = await build(root);
    const {renderPage} = await import(pathToFileURL(path.join(result.outputDirectory, 'runtime/render.mjs')).href);
    const first = result.routes.find(route => route.pattern === '/first');
    const second = result.routes.find(route => route.pattern === '/second');
    const render = async route => (await renderPage({modulePath:path.join(result.outputDirectory,route.module),route,url:'http://localhost'+route.pattern})).body.toString();
    const firstHtml = await render(first);
    assert.match(firstHtml, /<output>1<\/output>/);
    assert.match(await render(second), /<output>2<\/output>/);
    assert.match(await render(first), /<output>3<\/output>/);
    const serverFiles = await readdir(path.join(result.outputDirectory, 'server'));
    assert.ok(serverFiles.some(file => /^chunk-[\w-]+\.mjs$/.test(file)));
    const image = /src="(\/_rustyx\/assets\/image-[\w-]+\.svg)"/.exec(firstHtml)?.[1];
    assert.ok(image, 'server image URLs retain the public asset prefix');
    const assets = await readdir(path.join(result.outputDirectory, 'assets'));
    assert.ok(assets.includes(path.basename(image)));
    const browser = (await Promise.all(assets.filter(file => file.endsWith('.js')).map(file => readFile(path.join(result.outputDirectory, 'assets', file), 'utf8')))).join('\n');
    assert.ok(browser.includes(image), 'server/browser images use the same URL');
  } finally { await rm(root, {recursive:true,force:true}); }
});
