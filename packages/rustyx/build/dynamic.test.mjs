import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { transformDynamicImports } from './dynamic.mjs';
import { stripServerCode } from './transform.mjs';
import { build } from './index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const compile = (source, mode = 'browser', filename = '/project/pages/index.tsx') => transformDynamicImports(source, filename, { projectRoot: '/project', mode });
const ids = source => [...source.matchAll(/dynamic-[a-f\d]{20}/g)].map(match => match[0]);

test('dynamic hydration identities survive server stripping, project relocation, aliases and named exports', () => {
  const source = `import load from 'next/dynamic';import fs from 'node:fs';
    export function getServerSideProps(){return {props:{secret:fs.readFileSync('/secret','utf8')}}}
    const Lazy=load(()=>import('../components/part').then(mod=>mod.Named),{loading:()=>null});
    export default function Page(){return <Lazy/>}`;
  const server = compile(source, 'server');
  const browser = stripServerCode(compile(source), '/project/pages/index.tsx');
  const relocated = transformDynamicImports(source, '/elsewhere/pages/index.tsx', { projectRoot: '/elsewhere' });
  assert.equal(ids(server).length, 1);
  assert.deepEqual(ids(browser), ids(server));
  assert.deepEqual(ids(relocated), ids(server));
  assert.match(browser, /mod\.Named/);
  assert.doesNotMatch(browser, /getServerSideProps|node:fs|\/secret/);
  const repeated = compile(`import dynamic from 'rustyx/dynamic';const A=dynamic(()=>import('./part'));const B=dynamic(()=>import('./part').then(m=>m.Named));`);
  assert.equal(ids(repeated)[0], ids(repeated)[1]);
});

test('ssr:false erases complete server loaders and rejects only actual Server Component calls', () => {
  for (const source of [
    `import dynamic from 'next/dynamic';const C=dynamic(()=>{sideEffect();return import('./browser')},{ssr:false});`,
    `import dynamic from 'next/dynamic';const C=dynamic({loader:()=>import('./browser'),ssr:false},{loading:()=>null});`,
    `const dynamic=require('rustyx/dynamic');const C=dynamic(import('./browser'),{'ssr':false});`,
    `import dynamic from 'next/dynamic';const C=dynamic({loader(){return import('./browser')},ssr:false});`,
  ]) {
    const server = compile(source, 'server');
    assert.doesNotMatch(server, /sideEffect\(|import\(|browser/);
    assert.match(server, /async \(\) => null/);
    assert.match(compile(source), /import\(['"]\.\/browser/);
    assert.throws(() => compile(source, 'rsc'), /ssr: false.*Server Component.*use client/);
  }
  const shadow = `import dynamic from 'next/dynamic';function helper(dynamic){return dynamic(()=>import('./local'),{ssr:false})}`;
  assert.equal(compile(shadow, 'rsc'), shadow);
  assert.doesNotThrow(() => compile(`import dynamic from 'next/dynamic';const C=dynamic(()=>import('./part'),{ssr:true})`, 'rsc'));
  assert.match(compile(`import dynamic from 'next/dynamic';const C=dynamic(()=>import('./part'),{ssr:false,...options})`, 'server'), /import\(/, 'a trailing spread can override ssr');
  assert.match(compile(`import dynamic from 'next/dynamic';const C=dynamic(()=>import('./part'),{ssr:false,[key]:true})`, 'server'), /import\(/, 'an unknown computed property can override ssr');
});

test('dynamic preserves loader retries, supports object loaders and defers legacy eager imports', () => {
  const custom = compile(`import dynamic from 'next/dynamic';let failures=0;const C=dynamic({loader:()=>++failures===1?Promise.reject(new Error('retry')):import('./part'),loading:Loading});`);
  assert.match(custom, /Promise\.reject/);
  assert.equal(ids(custom).length, 1);
  assert.match(compile(`import dynamic from 'next/dynamic';const C=dynamic(import('./part').then(mod=>mod.Named));`), /\(\) => import/);
  const referenced = compile(`import dynamic from 'next/dynamic';const loader=()=>import('./part');const C=dynamic(loader);`);
  assert.equal(ids(referenced).length, 1);
  assert.equal(ids(compile(`import dynamic from 'next/dynamic';const C=dynamic({loader(){return import('./part')}});`)).length, 1);
  assert.throws(() => compile(`import dynamic from 'next/dynamic';const C=dynamic(()=>import(variable));`), /string literals/);
  assert.throws(() => compile(`import dynamic from 'next/dynamic';const C=dynamic(()=>import('./part'),{},{});`), /accepts a loader/);
});

async function fixture(files, callback) {
  const project = await mkdtemp(path.join(root, '.rustyx-dynamic-test-'));
  try {
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(project, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    await callback(project);
  } finally { await rm(project, { recursive: true, force: true }); }
}

test('Pages dynamic builds separate browser chunks, SSR content, CSS, and relocated server imports', async () => {
  await fixture({
    'pages/index.jsx': `import dynamic from 'next/dynamic';
      const Normal=dynamic(()=>import('../components/normal').then(mod=>mod.Named));
      const Client=dynamic(()=>import('../components/browser'),{ssr:false,loading:()=> <p>client placeholder</p>});
      export const getServerSideProps=()=>({props:{}});export default()=> <main><Normal/><Client/></main>`,
    'components/normal.jsx': `import styles from './normal.module.css';export function Named(){return <h1 className={styles.title}>dynamic server content</h1>}`,
    'components/normal.module.css': '.title {color:rgb(12,34,56)}',
    'components/browser.jsx': `import './browser.css';const value=window.location.hostname;export default()=> <p>CLIENT_ONLY_DYNAMIC_MARKER:{value}</p>`,
    'components/browser.css': '.browser-only {color:rebeccapurple}',
  }, async project => {
    const manifest = await build(project);
    const route = manifest.routes.find(route => route.pattern === '/');
    assert.ok(route.css.length);
    const assets = await readdir(path.join(manifest.outputDirectory, 'assets'));
    const scripts = await Promise.all(assets.filter(name => name.endsWith('.js')).map(async name => [name, await readFile(path.join(manifest.outputDirectory, 'assets', name), 'utf8')]));
    assert.ok(scripts.some(([name, source]) => source.includes('CLIENT_ONLY_DYNAMIC_MARKER') && name !== path.basename(route.client)), 'client-only code lives outside the eager route chunk');
    const entry = scripts.find(([name]) => name === path.basename(route.client))[1];
    assert.match(entry, /import\(/);
    const css = (await Promise.all(route.css.map(file => readFile(path.join(manifest.outputDirectory, 'assets', path.basename(file)), 'utf8')))).join('\n');
    assert.match(css, /\.browser-only\{color:#639\}/);
    const moved = path.join(project, 'relocated');
    await rename(manifest.outputDirectory, moved);
    const { renderPage } = await import(pathToFileURL(path.join(moved, 'runtime/render.mjs')).href);
    const rendered = await renderPage({ modulePath: path.join(moved, route.module), route, url: 'http://localhost/', production: true });
    const html = rendered.body.toString();
    assert.match(html, /dynamic server content/);
    assert.match(html, /client placeholder/);
    assert.doesNotMatch(html, /CLIENT_ONLY_DYNAMIC_MARKER/);
    assert.match(html, /dynamicIds/);
    const serverScripts = (await Promise.all((await readdir(path.join(moved, 'server'))).filter(name => name.endsWith('.mjs')).map(name => readFile(path.join(moved, 'server', name), 'utf8')))).join('\n');
    assert.doesNotMatch(serverScripts, /CLIENT_ONLY_DYNAMIC_MARKER/);
    assert.match(serverScripts, /import\("\.\/chunk-/);
  });
});

test('App dynamic compiles Server and Client Component imports and refuses server ssr:false atomically', async () => {
  await fixture({
    'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
    'app/page.jsx': `import dynamic from 'next/dynamic';const Server=dynamic(()=>import('../components/server'));const Client=dynamic(()=>import('../components/client'));export default()=> <main><Server/><Client/></main>`,
    'components/server.jsx': `export default async function Server(){return <h1>async dynamic Server Component</h1>}`,
    'components/client.jsx': `'use client';import dynamic from 'rustyx/dynamic';const OnlyClient=dynamic(()=>import('./browser'),{ssr:false,loading:()=> <p>App client placeholder</p>});export default function Client(){return <OnlyClient/>}`,
    'components/browser.jsx': `const value=window.location.hostname;export default()=> <p>APP_ONLY_CLIENT_DYNAMIC:{value}</p>`,
  }, async project => {
    const manifest = await build(project);
    const seed = manifest.prerendered.find(item => item.path === '/');
    const html = await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8');
    assert.match(html, /async dynamic Server Component/);
    assert.match(html, /App client placeholder/);
    assert.doesNotMatch(html, /APP_ONLY_CLIENT_DYNAMIC/);
    const before = await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8');
    await writeFile(path.join(project, 'app/page.jsx'), `import dynamic from 'next/dynamic';const Bad=dynamic(()=>import('../components/client'),{ssr:false});export default()=> <Bad/>`);
    await assert.rejects(build(project), /ssr: false.*Server Component/);
    assert.equal(await readFile(path.join(manifest.outputDirectory, 'manifest.json'), 'utf8'), before);
  });
});
