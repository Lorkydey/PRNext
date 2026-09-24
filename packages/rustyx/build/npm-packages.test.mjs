import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from './index.mjs';
import { standaloneFixture, appFixture, startServer } from '../../../tests/support.mjs';

async function pkg(root, name, files, metadata = {}) {
  const directory = path.join(root, 'node_modules', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js', type: 'module', ...metadata }));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
}

test('Pages compile direct and transitive npm Next imports without installing Next, plus configured TS/CSS packages', async () => {
  const fixture = await standaloneFixture();
  let server;
  try {
    await pkg(fixture.root, 'next-aware', { 'index.js': `export {default} from 'next/link';` }, { peerDependencies: { next: '*' } });
    await pkg(fixture.root, 'wrapper', { 'index.js': `export {default} from 'next-aware';export {version} from 'versioned-data';` });
    await pkg(fixture.root, 'versioned-data', { 'index.js': `export const version='root version';` });
    await pkg(path.join(fixture.root, 'node_modules/wrapper'), 'versioned-data', { 'index.js': `export const version='nested version';` });
    await pkg(fixture.root, 'next-cjs', { 'index.cjs': `exports.Link=require('next/link');` }, { type: 'commonjs', main: 'index.cjs' });
    await pkg(fixture.root, 'typed-widget', { 'index.tsx': `import styles from './card.module.css';export function Card({label}:{label:string}){return <strong className={styles.card}>{label}</strong>}`, 'card.module.css': '.card{color:rgb(12,34,56)}' }, { main: 'index.tsx' });
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), `export default{transpilePackages:['typed-widget']}`);
    await writeFile(path.join(fixture.root, 'pages/index.jsx'), `import Link,{version} from 'wrapper';import {Link as CjsLink} from 'next-cjs';import {Card} from 'typed-widget';export default()=> <main><Link href="/server">ESM link</Link><CjsLink href="/server">CJS link</CjsLink><Card label="Typed npm"/><p>{version}</p></main>;export const getServerSideProps=()=>({props:{}})`);
    const manifest = await build(fixture.root);
    const route = manifest.routes.find(item => item.pattern === '/');
    const compiled = await readFile(path.join(manifest.outputDirectory, route.module), 'utf8');
    assert.doesNotMatch(compiled, /from ["'](?:next\/|wrapper|next-aware|next-cjs|typed-widget)/);
    assert.ok(route.css.length);
    // Only emitted artifacts and ordinary runtime dependencies are needed.
    for (const name of ['wrapper', 'next-aware', 'next-cjs', 'typed-widget']) await rm(path.join(fixture.root, 'node_modules', name), { recursive: true });
    server = await startServer(fixture.root);
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /ESM link/); assert.match(html, /CJS link/); assert.match(html, /Typed npm/);
    assert.match(html, /href="\/server"/);
    assert.match(html, /nested version/);
    assert.doesNotMatch(html, /root version/);
  } finally { await server?.close(); await fixture.remove(); }
});

test('App serverExternalPackages preserve computed loaders and reject external Next imports', async () => {
  const fixture = await appFixture();
  let server;
  try {
    await pkg(fixture.root, 'runtime-loader', { 'index.cjs': `const name='./data.json';module.exports=require(name);`, 'data.json': '{"label":"Runtime npm data"}' }, { type: 'commonjs', main: 'index.cjs' });
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), `export default{serverExternalPackages:['runtime-loader']}`);
    await writeFile(path.join(fixture.root, 'app/page.tsx'), `import data from 'runtime-loader';export const dynamic='force-dynamic';export default()=> <h1>{data.label}</h1>`);
    await build(fixture.root);
    server = await startServer(fixture.root);
    assert.match(await (await fetch(server.url)).text(), /Runtime npm data/);
    await writeFile(path.join(fixture.root, 'node_modules/runtime-loader/index.cjs'), `module.exports=require('next/link');`);
    await assert.rejects(build(fixture.root), /imports require Next\/Rustyx compilation/);
    await pkg(fixture.root, 'external-wrapper', { 'index.js': `export {default} from 'runtime-loader';` });
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), `export default{serverExternalPackages:['external-wrapper','runtime-loader']}`);
    await writeFile(path.join(fixture.root, 'app/page.tsx'), `import Link from 'external-wrapper';export default()=> <Link href="/">External</Link>`);
    await assert.rejects(build(fixture.root), /imports require Next\/Rustyx compilation/);
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), `export default{serverExternalPackages:['runtime-loader'],transpilePackages:['runtime-loader']}`);
    await assert.rejects(build(fixture.root), /cannot be in both/);
  } finally { await server?.close(); await fixture.remove(); }
});
