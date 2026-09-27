import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProjectConfig, publicAssetBase } from './config.mjs';
import { compileCustomRoutes, compileRouteMatcher } from './custom-routes.mjs';
import { relativeServerChunkImports } from './transform.mjs';
import { build } from './index.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const project = await mkdtemp(path.join(repository, '.prnext-mount-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(project, name)), { recursive: true });
      await writeFile(path.join(project, name), content);
    }
    return await callback(project);
  } finally { await rm(project, { recursive: true, force: true }); }
}

function matches(rule, value) { return new RegExp(rule.regex, 'i').test(value); }

test('basePath and assetPrefix validate mounted paths and normalize local or HTTP asset locations', () => {
  for (const basePath of ['/', 'docs', '/docs/', '//example.test', '/docs?x=1', '/docs#x', '/a/../b', '/a\\b', '/bad%zz', '/docs//x', '/café', 12, null]) {
    assert.throws(() => validateProjectConfig({ basePath }), /basePath/);
  }
  for (const assetPrefix of ['//example.test', 'javascript:alert(1)', 'ftp://example.test', 'https://user:password@example.test', 'https://example.test?secret=1', 'https://example.test?', 'https://example.test#', '/a#fragment', '/a/../b', '/cdn//images', '/café', 'https://example.test/café', 'https://example.test/cdn//images', 12, null]) {
    assert.throws(() => validateProjectConfig({ assetPrefix }), /assetPrefix/);
  }
  for (const [input, prefix, assets] of [
    [{}, '', '/_prnext/assets'],
    [{ basePath: '/docs' }, '', '/docs/_prnext/assets'],
    [{ basePath: '/caf%C3%A9' }, '', '/caf%C3%A9/_prnext/assets'],
    [{ basePath: '/docs', assetPrefix: '/' }, '/', '/_prnext/assets'],
    [{ basePath: '/docs', assetPrefix: 'cdn/local/' }, '/cdn/local', '/cdn/local/_prnext/assets'],
    [{ basePath: '/docs', assetPrefix: 'https://cdn.example.test/assets/' }, 'https://cdn.example.test/assets', 'https://cdn.example.test/assets/_prnext/assets'],
  ]) {
    const config = validateProjectConfig(input);
    assert.equal(config.assetPrefix, prefix);
    assert.equal(publicAssetBase(config), assets);
  }
});

test('custom rules and middleware use literal mount prefixes while external and opted-out destinations remain unchanged', async () => {
  const rules = await compileCustomRoutes({ basePath: '/docs/v1',
    headers: () => [{ source: '/:path*', headers: [{ key: 'x-mounted', value: 'yes' }] }, { source: '/outside', basePath: false, headers: [{ key: 'x-outside', value: 'yes' }] }],
    redirects: () => [
      { source: '/', destination: '/', permanent: false },
      { source: '/old/:slug', destination: '/new/:slug?from=redirect#part', permanent: true },
      { source: '/outside', destination: '/elsewhere', basePath: false, permanent: false },
      { source: '/external', destination: 'https://example.test/path', permanent: false },
    ],
    rewrites: () => ({ beforeFiles: [{ source: '/alias/:slug', destination: '/target/:slug' }], afterFiles: [{ source: '/proxy/:rest*', destination: 'https://example.test/:rest*', basePath: false }] }),
  });
  assert.equal(matches(rules.headers[0], '/docs/v1/page'), true);
  assert.equal(matches(rules.headers[0], '/page'), false);
  assert.equal(matches(rules.headers[1], '/outside'), true);
  assert.equal(rules.redirects[0].source, '/docs/v1');
  assert.deepEqual(rules.redirects[0].destination.pathname, ['/docs/v1']);
  assert.equal(matches(rules.redirects[1], '/docs/v1/old/book'), true);
  assert.deepEqual(rules.redirects[1].destination.pathname, ['/docs/v1/new', { param: 'slug', prefix: '/', suffix: '', modifier: '' }]);
  assert.deepEqual(rules.redirects[2].destination.pathname, ['/elsewhere']);
  assert.deepEqual(rules.redirects[3].destination.pathname, ['/path']);
  assert.equal(rules.rewrites.beforeFiles[0].source, '/docs/v1/alias/:slug');
  assert.equal(rules.rewrites.afterFiles[0].source, '/proxy/:rest*');
  await assert.rejects(compileCustomRoutes({ basePath: '/docs', rewrites: () => [{ source: '/outside', destination: '/inside', basePath: false }] }), /external HTTP/);
  await assert.rejects(compileCustomRoutes({ basePath: '/docs', redirects: () => [{ source: 'relative', destination: '/', permanent: false }] }), /source must start/);
  const matcher = compileRouteMatcher({ source: '/:path*', missing: [{ type: 'cookie', key: 'skip' }] }, 'fixture', { basePath: '/docs' });
  assert.equal(matches(matcher, '/docs'), true);
  assert.equal(matches(matcher, '/docs/anything'), true);
  assert.equal(matches(matcher, '/anything'), false);
  assert.equal(matcher.missing[0].key, 'skip');
  assert.throws(() => compileRouteMatcher({ source: '/', basePath: false }), /unsupported fields/);
  const literal = compileRouteMatcher('/:path*', 'fixture', { basePath: '/v:1(x)' });
  assert.equal(matches(literal, '/v:1(x)/page'), true);
  assert.equal(matches(literal, '/v12/page'), false);
});

test('public CDN chunk URLs become relative only in server import declarations and dynamic imports', () => {
  const prefix = 'https://cdn.example.test/site/_prnext/assets';
  const source = `import {a} from '${prefix}/chunk-A.mjs';export {b} from '${prefix}/chunk-B.mjs';const load=()=>import('${prefix}/chunk-C.mjs');const image='${prefix}/image.png';`;
  const result = relativeServerChunkImports(source, new Set(['chunk-A.mjs', 'chunk-B.mjs', 'chunk-C.mjs']), prefix);
  for (const name of ['A', 'B', 'C']) assert.ok(result.includes(`"./chunk-${name}.mjs"`));
  assert.ok(result.includes(`${prefix}/image.png`));
});

test('mixed builds prefix browser graphs, CSS assets, Flight modules and manifests without changing server route keys or relocation', async () => {
  await fixture({
    'pages/index.jsx': `import asset from '../pixel.png';import styles from '../shared.module.css';import dynamic from 'next/dynamic';const Deferred=dynamic(()=>import('../dynamic.jsx'));export async function getStaticProps(){const {answer}=await import('../answer.js');return{props:{answer}}}export default function Home({answer}){return <main className={styles.root}><img src={asset.src}/>{answer}<Deferred/></main>}`,
    'pages/second.jsx': `import {answer} from '../answer.js';export default()=> <p>{answer}</p>`,
    'answer.js': `export const answer='shared-server-value'`,
    'dynamic.jsx': `export default()=> <p>Deferred component</p>`,
    'pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYKjYAgABqQEtEfonzQAAAABJRU5ErkJggg==', 'base64'),
    'shared.module.css': '.root {background-image:url("./pixel.png")}',
    'app/application/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
    'app/application/page.jsx': `import Client from './client';export default()=> <Client/>`,
    'app/application/client.jsx': `'use client';import asset from '../../pixel.png';import styles from '../../shared.module.css';export default()=> <section className={styles.root}><img src={asset.src}/>Application client</section>`,
    'proxy.js': `export default()=>new Response('unreachable');export const config={matcher:'/intercept/:path*'}`, 
  }, async project => {
    for (const assetPrefix of ['', '/resources/', 'https://cdn.example.test/resources/']) {
      await writeFile(path.join(project, 'prnext.config.mjs'), `export default ${JSON.stringify({ basePath: '/docs', assetPrefix })}`);
      const manifest = await build(project);
      const assets = publicAssetBase(validateProjectConfig({ basePath: '/docs', assetPrefix }));
      assert.equal(manifest.config.basePath, '/docs');
      assert.equal(manifest.config.assetBase, assets);
      assert.equal(manifest.middleware.matchers[0].source, '/docs/intercept/:path*');
      assert.ok(manifest.routes.every(route => !route.pattern.startsWith('/docs')));
      assert.ok(manifest.prerendered.every(seed => !seed.path.startsWith('/docs')));
      assert.ok(manifest.pagesManifest.startsWith(assets + '/pages-manifest-'));
      const publicPages = JSON.parse(await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(manifest.pagesManifest)), 'utf8'));
      assert.equal(publicPages.basePath, '/docs'); assert.equal(publicPages.assetBase, assets);
      for (const route of manifest.routes.filter(route => route.kind === 'page')) {
        assert.ok(route.client.startsWith(assets + '/'));
        assert.ok(route.css.every(css => css.startsWith(assets + '/')));
      }
      for (const reference of Object.values(manifest.app.clientModules)) {
        assert.ok(reference.browserModule.startsWith(assets + '/'));
        assert.equal(reference.chunks[1], reference.browserModule);
      }
      const files = await readdir(path.join(manifest.outputDirectory, 'assets'));
      const css = (await Promise.all(files.filter(file => file.endsWith('.css')).map(file => readFile(path.join(manifest.outputDirectory, 'assets', file), 'utf8')))).join('\n');
      assert.ok(css.includes(assets + '/pixel-'));
      const browser = (await Promise.all(files.filter(file => file.endsWith('.js')).map(file => readFile(path.join(manifest.outputDirectory, 'assets', file), 'utf8')))).join('\n');
      assert.ok(browser.includes(assets + '/chunk-'), 'shared browser imports use the public asset base');
      for (const seed of manifest.prerendered) {
        const html = await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8');
        assert.ok(html.includes(assets + '/'), 'initial HTML uses the same prefix as browser modules');
      }
      const moved = path.join(project, '.relocated');
      await rename(manifest.outputDirectory, moved);
      const entry = manifest.routes.find(route => route.pattern === '/');
      const page = await import(pathToFileURL(path.join(moved, entry.module)).href + '?' + manifest.cacheId);
      assert.equal((await page.getStaticProps()).props.answer, 'shared-server-value');
      await rm(moved, { recursive: true, force: true });
    }
  });
});
