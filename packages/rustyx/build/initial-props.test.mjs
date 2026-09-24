import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.rustyx-initial-props-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    return await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function exposed(manifest) {
  return JSON.parse(await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(manifest.pagesManifest)), 'utf8'));
}

test('Page getInitialProps opts out of prerender without executing at build and stays in the browser graph', async () => {
  await fixture({
    'pages/index.jsx': 'export default()=> <h1>Home</h1>',
    'pages/legacy.jsx': `function Legacy(){return <p>Legacy</p>}Legacy.getInitialProps=()=>{throw Error('LEGACY_HOOK_RUNTIME_ONLY')};export default Legacy`,
  }, async root => {
    const manifest = await build(root);
    assert.ok(manifest.prerendered.some(page => page.path === '/'));
    assert.ok(!manifest.prerendered.some(page => page.path === '/legacy'));
    const route = (await exposed(manifest)).routes.find(route => route.pattern === '/legacy');
    assert.equal(route.gip, true); assert.equal(route.appGip, false);
    const client = await readFile(path.join(manifest.outputDirectory, 'assets', path.basename(route.client)), 'utf8');
    assert.match(client, /LEGACY_HOOK_RUNTIME_ONLY/);
  });
});

test('custom App initial props disable automatic static pages while GSP preserves top-level App props', async () => {
  await fixture({
    'pages/_app.jsx': `import App from 'next/app';export default class CustomApp extends App{static async getInitialProps(ctx){return{...await App.getInitialProps(ctx),pageProps:{collision:'app',appOnly:true},extra:'public-top'}}}`,
    'pages/index.jsx': 'export default()=> <h1>Home</h1>',
    'pages/static.jsx': `export const getStaticProps=()=>({props:{collision:'gsp'}});export default({collision,appOnly})=><p>{collision}:{String(appOnly)}</p>`,
  }, async root => {
    const manifest = await build(root);
    assert.ok(!manifest.prerendered.some(page => page.path === '/'));
    const seed = manifest.prerendered.find(page => page.path === '/static');
    assert.ok(seed);
    const data = JSON.parse(await readFile(path.join(manifest.outputDirectory, seed.dataFile), 'utf8'));
    assert.equal(data.extra, 'public-top'); assert.deepEqual(data.pageProps, { collision: 'gsp', appOnly: true });
    const publicManifest = await exposed(manifest);
    assert.ok(publicManifest.routes.every(route => route.appGip));
    assert.deepEqual(Object.keys(publicManifest.errors), ['error']);
    assert.equal(publicManifest.errors.error.pattern, '/_error');
    assert.ok(!manifest.prerendered.some(seed => seed.path.startsWith('/_rustyx/errors/')));
  });
});

test('inherited or explicitly preserved default App hook identity keeps automatic static optimization', async () => {
  for (const [source, expected] of [
    [`export default class CustomApp extends App {}`, false],
    [`function CustomApp(props){return <App {...props}/>};CustomApp.getInitialProps=App.getInitialProps;CustomApp.origGetInitialProps=App.origGetInitialProps;export default CustomApp`, false],
    [`function CustomApp(props){return <App {...props}/>};CustomApp.getInitialProps=App.getInitialProps;export default CustomApp`, true],
  ]) {
    await fixture({
      'pages/_app.jsx': `import App from 'next/app';${source}`,
      'pages/index.jsx': 'export default()=> <p>Home</p>',
    }, async root => {
      const manifest = await build(root);
      assert.equal(manifest.routes.find(route => route.pattern === '/').appGip, expected);
      assert.equal(manifest.prerendered.some(page => page.path === '/'), !expected);
    });
  }
});
