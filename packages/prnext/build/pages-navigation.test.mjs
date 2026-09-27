import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { gunzipSync } from 'node:zlib';
import { build } from './index.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function fixture(files, callback) {
  const project = await mkdtemp(path.join(repository, '.prnext-navigation-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(project, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    await callback(project);
  } finally { await rm(project, { recursive: true, force: true }); }
}

async function publicManifest(manifest) {
  return JSON.parse(await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(manifest.pagesManifest)), 'utf8'));
}

function entryExports(source) {
  return parse(source, { sourceType: 'module' }).program.body
    .filter(node => node.type === 'ExportNamedDeclaration')
    .flatMap(node => node.specifiers.map(specifier => specifier.exported.name ?? specifier.exported.value));
}

test('Pages navigation manifest exposes only public route metadata and preserves shared App/React chunks', async () => {
  await fixture({
    'pages/_app.jsx': `import {useState} from 'react';import './global.css';export default function App({Component,pageProps}){const[count]=useState(0);return <section data-count={count}><Component {...pageProps}/></section>}`,
    'pages/global.css': '.shared-app {color:navy}',
    'pages/index.jsx': `export default function Home(){return <h1>Home</h1>}`,
    'pages/plain/[id].jsx': `export default function Plain(){return <p>Automatic dynamic page</p>}`,
    'pages/ssr.jsx': `import {readFileSync} from 'node:fs';import styles from './ssr.module.css';const secret='PAGES_SPA_SERVER_SECRET';export function getServerSideProps(){return {props:{value:readFileSync('/dev/null','utf8')+secret}}}export default function ServerPage(){return <p className={styles.page}>Server page</p>}`,
    'pages/ssr.module.css': '.page {color:teal}',
    'pages/static/[id].jsx': `export const getStaticPaths=()=>({paths:['/static/first'],fallback:true});export const getStaticProps=({params})=>({props:{id:params.id},revalidate:3});export default function Static({id}){return <p>{id||'fallback'}</p>}`,
    'pages/api/private.js': `export default function handler(req,res){res.json({token:'PRIVATE_API_SENTINEL'})}`,
    'app/other/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
    'app/other/page.jsx': `export default function Other(){return <h1>Other router</h1>}`,
    'app/endpoint/route.js': `export function GET(){return Response.json({token:'PRIVATE_HANDLER_SENTINEL'})}`,
  }, async project => {
    const manifest = await build(project);
    assert.equal(manifest.pagesManifest, `/_prnext/assets/pages-manifest-${manifest.cacheId}.json`);
    const exposed = await publicManifest(manifest);
    assert.equal(exposed.buildId, manifest.buildId);
    assert.equal(exposed.needsServerRouting, false);
    assert.deepEqual(exposed.routes.map(route => route.pattern).sort(), ['/', '/plain/[id]', '/ssr', '/static/[id]']);
    const routes = new Map(exposed.routes.map(route => [route.pattern, route]));
    assert.deepEqual([routes.get('/').ssg, routes.get('/').ssp], [false, false]);
    assert.deepEqual([routes.get('/plain/[id]').ssg, routes.get('/plain/[id]').ssp], [false, false]);
    assert.deepEqual([routes.get('/ssr').ssg, routes.get('/ssr').ssp], [false, true]);
    assert.deepEqual([routes.get('/static/[id]').ssg, routes.get('/static/[id]').ssp], [true, false]);
    assert.equal(manifest.routes.find(route => route.pattern === '/ssr').ssp, true);
    assert.deepEqual(exposed.nonPagesRoutes.map(route => [route.pattern, route.kind, route.router]).sort(), [
      ['/api/private', 'api', 'pages'], ['/endpoint', 'api', 'app'], ['/other', 'page', 'app'],
    ]);
    const publicText = JSON.stringify(exposed);
    assert.doesNotMatch(publicText, /PAGES_SPA_SERVER_SECRET|PRIVATE_API_SENTINEL|PRIVATE_HANDLER_SENTINEL|server\/|ssrModule|actionKey|handlerConfig/);
    assert.ok(!publicText.includes(project));
    for (const route of exposed.routes) {
      assert.deepEqual(Object.keys(route).sort(), ['appGip', 'client', 'css', 'gip', 'id', 'pattern', 'ssg', 'ssp']);
      const javascript = await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(route.client)), 'utf8');
      assert.deepEqual(entryExports(javascript).sort(), ['App', 'Page']);
      assert.ok(javascript.includes(manifest.pagesManifest), 'each entry bootstraps with this build’s manifest');
      assert.ok(javascript.includes(JSON.stringify(route.pattern)));
      for (const file of route.css) assert.ok((await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(file)))).length);
    }
    const pageScripts = await Promise.all(exposed.routes.map(async route => parse(await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(route.client)), 'utf8'), { sourceType: 'module' })));
    const eagerImports = pageScripts.map(ast => new Set(ast.program.body.filter(node => node.type === 'ImportDeclaration').map(node => node.source.value)));
    assert.ok([...eagerImports[0]].some(file => eagerImports.every(files => files.has(file))), 'route entries share their runtime and _app graph');
    const assets = path.join(manifest.outputDirectory, 'assets');
    const javascript = (await Promise.all((await readdir(assets)).filter(name => name.endsWith('.js')).map(name => readFile(path.join(assets, name), 'utf8')))).join('\n');
    assert.doesNotMatch(javascript, /PAGES_SPA_SERVER_SECRET|PRIVATE_API_SENTINEL|PRIVATE_HANDLER_SENTINEL|node:fs|getServerSideProps|getStaticProps|getStaticPaths/);
    const filename = path.join(assets, path.basename(manifest.pagesManifest));
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(filename + '.gz')).toString()), exposed);
  });
});

test('pure Pages navigation needs server routing only for redirects, rewrites or middleware', async () => {
  await fixture({
    'pages/index.jsx': `export default function Page(){return <p>Home</p>}`,
  }, async project => {
    const cases = [
      [`{async headers(){return [{source:'/:path*',headers:[{key:'x-example',value:'yes'}]}]}}`, false],
      [`{async redirects(){return [{source:'/old',destination:'/',permanent:false}]}}`, true],
      ...['beforeFiles', 'afterFiles', 'fallback'].map(phase => [
        `{async rewrites(){return {${phase}:[{source:'/alias',destination:'/'}]}}}`, true,
      ]),
    ];
    for (const [config, expected] of cases) {
      await writeFile(path.join(project, 'prnext.config.mjs'), `export default ${config}`);
      const exposed = await publicManifest(await build(project));
      assert.equal(exposed.needsServerRouting, expected, config);
    }
    await writeFile(path.join(project, 'prnext.config.mjs'), 'export default {}');
    await writeFile(path.join(project, 'middleware.js'), `export default function middleware(){return new Response('ok')}export const config={matcher:[]}`);
    assert.equal((await publicManifest(await build(project))).needsServerRouting, true,
      'the presence of middleware conservatively retains server routing');
  });
});

test('Pages manifests change on every build even with a constant build ID, and entries export undefined App when absent', async () => {
  await fixture({
    'prnext.config.mjs': `export default {generateBuildId:()=> 'same-build-id'}`,
    'pages/index.jsx': `export default function Page(){return <p>First</p>}`,
  }, async project => {
    const first = await build(project);
    const firstPublic = await publicManifest(first);
    const source = await readFile(path.join(first.outputDirectory, 'assets', path.basename(firstPublic.routes[0].client)), 'utf8');
    assert.deepEqual(entryExports(source).sort(), ['App', 'Page']);
    const next = await build(project);
    assert.equal(first.buildId, next.buildId);
    assert.notEqual(first.cacheId, next.cacheId);
    assert.notEqual(first.pagesManifest, next.pagesManifest);
    const nextPublic = await publicManifest(next);
    assert.notEqual(firstPublic.routes[0].client, nextPublic.routes[0].client);
    await assert.rejects(readFile(path.join(next.outputDirectory, 'assets', path.basename(first.pagesManifest))), { code: 'ENOENT' });
  });
});
