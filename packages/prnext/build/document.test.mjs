import { devNull } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './index.mjs';
import { scanProject } from './scan.mjs';
import { shouldWatchProjectFile } from '../runtime/env.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.prnext-document-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(root + '-relocated', { recursive: true, force: true });
  }
}

const documentFunction = `import{Html,Head,Main,NextScript}from'next/document';export default function CustomDocument(){return <Html lang="fr"><Head/><body data-document="server shell"><Main/><NextScript/></body></Html>}`;

test('scanner treats root/src _document as a nonroute convention and rejects duplicates', async () => {
  for (const directory of ['pages', 'src/pages']) {
    for (const extension of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) {
      await fixture({ [`${directory}/index.jsx`]: 'export default()=>null', [`${directory}/_document.${extension}`]: 'export default()=>null' }, async root => {
        const project = await scanProject(root);
        assert.equal(project.document, path.join(root, directory, `_document.${extension}`));
        assert.deepEqual(project.routes.map(route => route.pattern), ['/']);
        const other = extension === 'tsx' ? 'jsx' : 'tsx';
        await writeFile(path.join(root, directory, `_document.${other}`), 'export default()=>null');
        await assert.rejects(scanProject(root), /Multiple _document files/);
      });
    }
  }
});

test('custom Document stays in the shared server graph, preserves static generation, and relocates with Pages error entries', async () => {
  await fixture({
    'prnext.config.mjs': 'export default {productionBrowserSourceMaps:true}',
    'pages/_document.jsx': `import Document,{Html,Head,Main,NextScript}from'prnext/document';import{readFileSync}from'node:fs';import{privateValue}from'../document-helper.js';
      export default class CustomDocument extends Document{static async getInitialProps(ctx){const props=await Document.getInitialProps(ctx);return {...props,privateValue:privateValue+readFileSync(${JSON.stringify(devNull)},'utf8')}}render(){return <Html lang="fr"><Head/><body data-document="server shell"><Main/><NextScript/></body></Html>}}`,
    'document-helper.js': `import'server-only';export const privateValue='DOCUMENT_SERVER_PRIVATE_SENTINEL'`,
    'pages/_app.jsx': 'export default({Component,pageProps})=><section id="shared-app"><Component {...pageProps}/></section>',
    'pages/index.jsx': 'export default()=> <h1>Static home</h1>',
    'pages/ssr.jsx': 'export const getServerSideProps=()=>({props:{}});export default()=> <p>Server page</p>',
    'pages/items/[id].jsx': `export const getStaticPaths=()=>({paths:['/items/seed'],fallback:true});export const getStaticProps=({params})=>({props:{id:params.id},revalidate:5});export default({id})=><p>{id||'loading'}</p>`,
    'pages/404.jsx': 'export const getStaticProps=()=>({props:{message:"Custom missing"}});export default({message})=><p>{message}</p>',
    'pages/500.jsx': 'export default()=> <p>Custom failure</p>',
    'pages/api/ping.js': 'export default(req,res)=>res.json({ok:true})',
    'app/layout.jsx': 'export default({children})=><html><body>{children}</body></html>',
    'app/other/page.jsx': 'export default()=> <h1>Independent App shell</h1>',
  }, async root => {
    const manifest = await build(root);
    assert.ok(!manifest.routes.some(route => route.pattern === '/_document'));
    assert.ok(manifest.prerendered.some(seed => seed.path === '/'));
    assert.equal(manifest.routes.find(route => route.pattern === '/items/[id]').ssg, true);
    assert.equal(manifest.routes.find(route => route.pattern === '/ssr').ssp, true);
    let sharedDocument;
    for (const route of manifest.routes.filter(route => route.router !== 'app')) {
      const namespace = await import(pathToFileURL(path.join(manifest.outputDirectory, route.module)).href);
      if (route.kind === 'api') assert.equal(namespace.Document, undefined);
      else {
        assert.equal(typeof namespace.Document, 'function');
        assert.equal(typeof namespace.Document.getInitialProps, 'function');
        sharedDocument ||= namespace.Document;
        assert.equal(namespace.Document, sharedDocument);
      }
    }
    for (const seed of manifest.prerendered.filter(seed => !['/other', '/_not-found'].includes(seed.path))) {
      const html = await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8');
      assert.match(html, /data-document="server shell"/);
      assert.doesNotMatch(html, /DOCUMENT_SERVER_PRIVATE_SENTINEL/);
    }
    const fallbackFile = manifest.routes.find(route => route.pattern === '/items/[id]').fallbackFile;
    assert.match(await readFile(path.join(manifest.outputDirectory, fallbackFile), 'utf8'), /data-document="server shell"/);
    const appSeed = manifest.prerendered.find(seed => seed.path === '/other');
    assert.doesNotMatch(await readFile(path.join(manifest.outputDirectory, appSeed.file), 'utf8'), /data-document|shared-app/);
    const assets = path.join(manifest.outputDirectory, 'assets');
    for (const name of (await readdir(assets)).filter(name => /\.js(?:\.map)?$/.test(name))) {
      assert.doesNotMatch(await readFile(path.join(assets, name), 'utf8'), /DOCUMENT_SERVER_PRIVATE_SENTINEL|document-helper|pages\/_document|node:fs/);
    }
    const exposed = JSON.parse(await readFile(path.join(assets, path.basename(manifest.pagesManifest)), 'utf8'));
    assert.ok([...exposed.routes, ...exposed.nonPagesRoutes].every(route => route.pattern !== '/_document'));
    await rename(root, root + '-relocated');
    const page = manifest.routes.find(route => route.pattern === '/');
    const relocated = await import(pathToFileURL(path.join(root + '-relocated', '.prnext', page.module)).href);
    assert.equal(typeof relocated.Document.getInitialProps, 'function');
  });
});

test('Document data function diagnostics and browser boundary errors preserve the published build', async () => {
  await fixture({ 'pages/index.jsx': 'export default()=> <p>Home</p>', 'pages/_document.jsx': documentFunction }, async root => {
    const original = await build(root);
    for (const name of ['getStaticProps', 'getStaticPaths', 'getServerSideProps']) {
      await writeFile(path.join(root, 'document-data.js'), `export const ${name}=()=>({props:{}})`);
      await writeFile(path.join(root, 'pages/_document.jsx'), `${documentFunction};export {${name}}from'../document-data.js'`);
      await assert.rejects(build(root), new RegExp(`pages/_document does not support ${name}`));
      assert.equal(JSON.parse(await readFile(path.join(original.outputDirectory, 'manifest.json'), 'utf8')).cacheId, original.cacheId);
    }
    for (const stylesheet of ['global.css', 'document.module.css', 'document.scss']) {
      await writeFile(path.join(root, stylesheet), 'body{color:navy}');
      await writeFile(path.join(root, 'pages/_document.jsx'), `import '../${stylesheet}';${documentFunction}`);
      await assert.rejects(build(root), /CSS cannot be imported within pages\/_document/);
      assert.equal(JSON.parse(await readFile(path.join(original.outputDirectory, 'manifest.json'), 'utf8')).cacheId, original.cacheId);
    }
    await writeFile(path.join(root, 'pages/_document.jsx'), documentFunction);
    await writeFile(path.join(root, 'pages/index.jsx'), `import{Html}from'next/document';export default()=> <Html/>`);
    await assert.rejects(build(root), /next\/document is server-only/);
    assert.equal(JSON.parse(await readFile(path.join(original.outputDirectory, 'manifest.json'), 'utf8')).cacheId, original.cacheId);
    await writeFile(path.join(root, 'pages/_document.jsx'), 'export default()=> <html><body>PRIVATE_DOCUMENT_COMPONENT</body></html>');
    await writeFile(path.join(root, 'pages/index.jsx'), `import Document from './_document';export default()=> <Document/>`);
    await assert.rejects(build(root), /pages\/_document is server-only/);
    await writeFile(path.join(root, 'pages/index.jsx'), 'export default()=>null');
    await mkdir(path.join(root, 'app/client'), { recursive: true });
    await writeFile(path.join(root, 'app/layout.jsx'), 'export default({children})=><html><body>{children}</body></html>');
    await writeFile(path.join(root, 'app/client/page.jsx'), `"use client";import Document from '../../pages/_document';export default()=> <Document/>`);
    await assert.rejects(build(root), /pages\/_document is server-only/);
  });
});

test('development watcher includes Document conventions and their local server dependencies', () => {
  for (const root of ['pages/', 'src/pages/']) for (const extension of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) {
    assert.equal(shouldWatchProjectFile(`${root}_document.${extension}`), true);
  }
  assert.equal(shouldWatchProjectFile('src/server/document-styles.ts'), true);
  assert.equal(shouldWatchProjectFile('.prnext/server/document.mjs'), false);
});
