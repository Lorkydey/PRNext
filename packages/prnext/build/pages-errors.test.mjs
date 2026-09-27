import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from './index.mjs';
import { scanProject } from './scan.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.prnext-errors-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    return await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const readPublic = async manifest => JSON.parse(await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(manifest.pagesManifest)), 'utf8'));

test('scanner reserves _error while keeping custom 404 and 500 addressable with their HTTP statuses', async () => {
  await fixture({
    'src/pages/index.jsx': 'export default()=>null',
    'src/pages/404.jsx': 'export default()=>null',
    'src/pages/500.jsx': 'export default()=>null',
    'src/pages/_error.jsx': 'export default()=>null',
  }, async root => {
    const project = await scanProject(root);
    for (const [kind, pattern, status] of [['notFound', '/404', 404], ['serverError', '/500', 500], ['error', '/_error', undefined]]) {
      const route = project.routes.find(route => route.id === project.pagesErrors[kind]);
      assert.equal(route.pattern, pattern);
      assert.equal(route.errorStatus, status);
      assert.equal(!!route.internal, kind === 'error');
    }
    await writeFile(path.join(root, 'src/pages/_error.tsx'), 'export default()=>null');
    await assert.rejects(scanProject(root), /Conflicting routes/);
  });
});

test('custom static error pages preserve GSP data and CSS while _error GIP is bundled without executing at build', async () => {
  await fixture({
    'pages/_app.jsx': `import '../style.css';export default function App({Component,pageProps}){return <section id="custom-app"><Component {...pageProps}/></section>}`,
    'style.css': '#custom-app{color:navy}',
    'pages/index.jsx': `export const getServerSideProps=()=>({props:{}});export default()=> <p>Home</p>`,
    'pages/404.jsx': `import{readFileSync}from'node:fs';export const getStaticProps=()=>({props:{message:'Missing '+readFileSync('/dev/null','utf8')},revalidate:10});export default({message})=><h1>{message}</h1>`,
    'pages/500.jsx': `export const getStaticProps=()=>({props:{message:'Broken'}});export default({message})=><h1>{message}</h1>`,
    'pages/_error.jsx': `import ErrorView from 'next/error';function ErrorPage({statusCode}){return <ErrorView statusCode={statusCode}/>};ErrorPage.getInitialProps=()=>{throw new Error('ERROR_GIP_MUST_NOT_RUN_AT_BUILD')};export default ErrorPage`,
  }, async root => {
    const manifest = await build(root);
    const publicManifest = await readPublic(manifest);
    assert.deepEqual(Object.keys(publicManifest.errors).sort(), ['error', 'notFound', 'serverError']);
    assert.equal(publicManifest.errors.error.pattern, '/_error');
    assert.ok(!publicManifest.routes.some(route => route.pattern === '/_error'));
    assert.ok(!publicManifest.nonPagesRoutes.some(route => route.pattern === '/_error'));
    assert.ok(!manifest.prerendered.some(seed => seed.path === '/_error'));
    for (const [kind, status, message] of [['notFound', 404, 'Missing '], ['serverError', 500, 'Broken']]) {
      const route = manifest.routes.find(route => route.id === manifest.pagesErrors[kind]);
      assert.equal(route.ssg, true);
      const seed = manifest.prerendered.find(seed => seed.path === route.pattern);
      assert.equal(seed.status, status);
      assert.ok((await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8')).includes('custom-app'));
      const data = JSON.parse(await readFile(path.join(manifest.outputDirectory, seed.dataFile), 'utf8'));
      assert.equal(data.pageProps.message, message);
      assert.equal(data.__N_SSG, true);
      assert.ok(publicManifest.errors[kind].css.length);
    }
    const module = await import(pathToFileURL(path.join(manifest.outputDirectory, manifest.routes.find(route => route.internal).module)).href);
    assert.equal(typeof module.default.getInitialProps, 'function');
    const javascript = (await Promise.all((await readdir(path.join(manifest.outputDirectory, 'assets'))).filter(name => name.endsWith('.js')).map(name => readFile(path.join(manifest.outputDirectory, 'assets', name), 'utf8')))).join('\n');
    assert.doesNotMatch(javascript, /node:fs|getStaticProps|getServerSideProps/);
  });
});

test('error convention validation preserves the last good build and rejects conflicting data functions', async () => {
  await fixture({ 'pages/index.jsx': 'export default()=> <p>Home</p>' }, async root => {
    const original = await build(root);
    const index = 'export default()=> <p>Home</p>';
    for (const [filename, source, expected] of [
      ['404.jsx', `export const getServerSideProps=()=>({props:{}});export default()=>null`, /must be static/],
      ['500.jsx', `function Page(){return null};Page.getInitialProps=()=>({});export default Page`, /must be static/],
      ['404.jsx', `function Page(){return null};Page.getInitialProps=()=>({});export default Page`, /must be static/],
      ['_error.jsx', `export const getStaticProps=()=>({props:{}});export default()=>null`, /_error does not support/],
      ['_error.jsx', `export const getServerSideProps=()=>({props:{}});export default()=>null`, /_error does not support/],
      ['index.jsx', `export const getStaticProps=()=>({props:{}});function Page(){return null};Page.getInitialProps=()=>({});export default Page`, /cannot combine getInitialProps/],
      ['index.jsx', `export const getServerSideProps=()=>({props:{}});function Page(){return null};Page.getInitialProps=()=>({});export default Page`, /cannot combine getInitialProps/],
    ]) {
      const file = path.join(root, 'pages', filename);
      await writeFile(file, source);
      await assert.rejects(build(root), expected, filename);
      assert.equal(JSON.parse(await readFile(path.join(original.outputDirectory, 'manifest.json'), 'utf8')).cacheId, original.cacheId);
      if (filename === 'index.jsx') await writeFile(file, index); else await rm(file);
    }
  });
});

test('missing error conventions receive internal static builtins under the shared custom App', async () => {
  await fixture({
    'pages/index.jsx': 'export default()=> <p>Home</p>',
    'pages/_app.jsx': `export default({Component,pageProps})=><section id="shared-app"><Component {...pageProps}/></section>`,
  }, async root => {
    const manifest = await build(root);
    const exposed = await readPublic(manifest);
    assert.deepEqual(exposed.routes.map(route => route.pattern), ['/']);
    for (const [kind, status] of [['notFound', 404], ['serverError', 500]]) {
      const route = manifest.routes.find(route => route.id === manifest.pagesErrors[kind]);
      assert.equal(route.internal, true);
      assert.equal(route.pattern, `/_prnext/errors/${status}`);
      assert.equal(exposed.errors[kind].id, route.id);
      const seed = manifest.prerendered.find(seed => seed.path === route.pattern);
      assert.equal(seed.status, status);
      const html = await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8');
      assert.match(html, /shared-app/); assert.ok(html.includes(String(status)));
    }
    await writeFile(path.join(root, 'pages/_error.jsx'), `function ErrorPage(){return <p>Custom fallback</p>};ErrorPage.getInitialProps=()=>({});export default ErrorPage`);
    const custom = await build(root);
    assert.deepEqual(Object.keys(custom.pagesErrors), ['error']);
    assert.ok(!custom.prerendered.some(seed => seed.path.startsWith('/_prnext/errors/')));
  });
});

test('internal Pages error artifacts cannot collide with addressable App 404 and 500 pages', async () => {
  await fixture({
    'pages/index.jsx': 'export default()=> <p>Pages home</p>',
    'app/layout.jsx': 'export default({children})=><html><body>{children}</body></html>',
    'app/404/page.jsx': 'export default()=> <p>Real App four-oh-four page</p>',
    'app/500/page.jsx': 'export default()=> <p>Real App five-hundred page</p>',
  }, async root => {
    const manifest = await build(root);
    const publicManifest = await readPublic(manifest);
    for (const [status, marker] of [[404, 'Real App four-oh-four'], [500, 'Real App five-hundred']]) {
      const seed = manifest.prerendered.find(seed => seed.path === `/${status}`);
      assert.equal(seed.status, 200);
      assert.match(await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8'), new RegExp(marker));
      const builtin = manifest.prerendered.find(seed => seed.path === `/_prnext/errors/${status}`);
      assert.equal(builtin.status, status);
      assert.notEqual(builtin.file, seed.file);
    }
    assert.ok(publicManifest.routes.every(route => !route.pattern.startsWith('/_prnext/')));
  });
});

test('root App layout produces an internal global not-found Flight and HTML entry', async () => {
  await fixture({
    'app/layout.jsx': `export default({children})=><html><body><header>Root layout</header>{children}</body></html>`,
    'app/not-found.jsx': `export default()=> <main>Global application not found</main>`,
    'app/hello/page.jsx': `export default()=> <p>Hello</p>`,
    'pages/index.jsx': `export default()=> <p>Pages home</p>`,
  }, async root => {
    const manifest = await build(root);
    const route = manifest.routes.find(route => route.id === manifest.appNotFound);
    assert.equal(route.router, 'app'); assert.equal(route.internal, true); assert.equal(route.pattern, '/_not-found');
    const seed = manifest.prerendered.find(seed => seed.path === '/_not-found');
    assert.equal(seed.status, 404); assert.ok(seed.dataFile);
    const html = await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8');
    assert.match(html, /Root layout/); assert.match(html, /Global application not found/);
    const publicManifest = await readPublic(manifest);
    assert.ok(!publicManifest.routes.some(route => route.pattern === '/_not-found'));
    assert.ok(!publicManifest.nonPagesRoutes.some(route => route.pattern === '/_not-found'));
  });
});

test('global App not-found does not execute root layout parameter generators', async () => {
  await fixture({
    'app/layout.jsx': `export function generateStaticParams(){throw new Error('UNRELATED_LAYOUT_GENERATOR')};export default({children})=><html><body>{children}</body></html>`,
    'app/not-found.jsx': 'export default()=> <p>Only a global missing route</p>',
  }, async root => {
    const manifest = await build(root);
    const route = manifest.routes.find(route => route.id === manifest.appNotFound);
    assert.equal(route.hasStaticParams, false);
    const seed = manifest.prerendered.find(seed => seed.path === '/_not-found');
    assert.equal(seed.status, 404);
    assert.match(await readFile(path.join(manifest.outputDirectory, seed.file), 'utf8'), /Only a global missing route/);
  });
});
