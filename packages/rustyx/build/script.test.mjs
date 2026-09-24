import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import { build } from './index.mjs';
import { validateProjectConfig } from './config.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
async function fixture(files, run) {
  const root = await mkdtemp(path.join(repository, '.rustyx-script-build-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function browserSource(manifest) {
  const directory = path.join(manifest.outputDirectory, 'assets');
  return (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.js')).map(name => readFile(path.join(directory, name), 'utf8')))).join('\n');
}

test('Pages Script aliases preserve the public component and loader exports in server and browser graphs', async () => {
  await fixture({
    'pages/index.jsx': `import Script,{initScriptLoader,handleClientScriptLoad} from 'next/script';import NativeScript from 'rustyx/script.js';export {Script,NativeScript,initScriptLoader,handleClientScriptLoad};export const getServerSideProps=()=>({props:{}});export default function Page(){return <main><Script id="pages-next-script" src="/script.js"/><NativeScript id="pages-rustyx-script">{'window.aliasScript=true'}</NativeScript></main>}`,
  }, async root => {
    const manifest = await build(root, { dev: true });
    const route = manifest.routes.find(route => route.pattern === '/');
    const entry = await import(pathToFileURL(path.join(manifest.outputDirectory, route.module)).href);
    assert.equal(entry.Script, entry.NativeScript);
    assert.equal(typeof entry.Script, 'function');
    assert.equal(typeof entry.initScriptLoader, 'function');
    assert.equal(typeof entry.handleClientScriptLoad, 'function');
    assert.equal(entry.default().props.children[0].type, entry.Script);
    const browser = await browserSource(manifest);
    assert.match(browser, /pages-next-script/);
    assert.match(browser, /pages-rustyx-script/);
    assert.match(browser, /data-nscript/);
    assert.doesNotMatch(browser, /node:async_hooks|node:fs/);
  });
});

test('App Script imports become real Flight client references with shared SSR context and browser exports', async () => {
  await fixture({
    'app/layout.jsx': `export default({children})=><html><body>{children}</body></html>`,
    'app/page.jsx': `import Script from 'next/script.js';import NativeScript from 'rustyx/script';export {Script,NativeScript};export default()=> <main><Script id="app-script" strategy="beforeInteractive" src="/app-script.js"/><NativeScript id="app-inline-script">{'window.appInline=true'}</NativeScript></main>`,
  }, async root => {
    const manifest = await build(root, { dev: true });
    const route = manifest.routes.find(route => route.pattern === '/');
    const probe = `import * as entry from ${JSON.stringify(pathToFileURL(path.join(manifest.outputDirectory, route.module)).href)};console.log(JSON.stringify({id:entry.page.Script.$$id,same:entry.page.Script===entry.page.NativeScript,kind:String(entry.page.Script.$$typeof)}))`;
    const output = await execute(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', probe], { cwd: root });
    const reference = JSON.parse(output.stdout.trim());
    assert.equal(reference.same, true);
    assert.equal(reference.kind, 'Symbol(react.client.reference)');
    const id = reference.id.slice(0, reference.id.lastIndexOf('#'));
    const client = manifest.app.clientModules[id];
    assert.ok(client);
    const namespace = await import(pathToFileURL(path.join(manifest.outputDirectory, client.ssrModule)).href);
    const compat = await import(pathToFileURL(path.join(manifest.outputDirectory, 'compat/script.cjs')).href);
    assert.equal(namespace.default, compat.default, 'SSR uses the copied compatibility module and its shared context');
    assert.equal(typeof namespace.handleClientScriptLoad, 'function');
    assert.equal(typeof namespace.initScriptLoader, 'function');
    const browser = await bundle({ entryPoints: [path.join(manifest.outputDirectory, 'assets', path.basename(client.browserModule))], bundle: true, write: false, format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'test-script-public-assets', setup(esbuild) { esbuild.onResolve({ filter: /^\/_rustyx\/assets\// }, args => ({ path: path.join(manifest.outputDirectory, 'assets', path.basename(args.path)) })); } }] });
    const imported = await import('data:text/javascript;base64,' + Buffer.from(browser.outputFiles[0].text).toString('base64'));
    assert.equal(typeof imported.default, 'function');
    assert.equal(typeof imported.handleClientScriptLoad, 'function');
    assert.equal(typeof imported.initScriptLoader, 'function');
    assert.doesNotMatch(browser.outputFiles[0].text, /node:async_hooks|node:fs/);
  });
});

test('worker scripts require an explicit boolean flag and reject unrelated experimental options', () => {
  assert.equal(validateProjectConfig({}).experimental.nextScriptWorkers, false);
  assert.equal(validateProjectConfig({ experimental: {} }).experimental.nextScriptWorkers, false);
  assert.equal(validateProjectConfig({ experimental: { nextScriptWorkers: true } }).experimental.nextScriptWorkers, true);
  for (const value of [null, 1, 'yes']) assert.throws(() => validateProjectConfig({ experimental: { nextScriptWorkers: value } }), /nextScriptWorkers.*boolean/);
  assert.throws(() => validateProjectConfig({ experimental: { unknownFeature: true } }), /experimental.unknownFeature.*not supported/);
});

test('worker builds use the application Partytown integration, copy assets and preserve prior output on setup failure', async () => {
  await fixture({
    'pages/index.jsx': 'export default()=> <p>Partytown build integration</p>',
    'rustyx.config.mjs': `export default{basePath:'/docs',assetPrefix:'/resources',experimental:{nextScriptWorkers:true}}`,
    'node_modules/@builder.io/partytown/package.json': JSON.stringify({ name: '@builder.io/partytown', exports: { './integration': './integration.cjs', './utils': './utils.cjs' } }),
    'node_modules/@builder.io/partytown/integration.cjs': `exports.partytownSnippet=()=> 'window.PROJECT_PARTYTOWN_BOOTSTRAP=true'`,
    'node_modules/@builder.io/partytown/utils.cjs': `const fs=require('node:fs/promises');const path=require('node:path');exports.copyLibFiles=async target=>{await fs.mkdir(path.join(target,'debug'),{recursive:true});await fs.writeFile(path.join(target,'partytown-sw.js'),'project worker source');await fs.writeFile(path.join(target,'debug/partytown.js'),'project debug source')}`,
  }, async root => {
    const first = await build(root, { dev: true });
    assert.deepEqual(first.scriptWorkers, { lib: '/resources/_rustyx/assets/~partytown/', snippet: 'window.PROJECT_PARTYTOWN_BOOTSTRAP=true' });
    assert.equal(await readFile(path.join(first.outputDirectory, 'assets/~partytown/partytown-sw.js'), 'utf8'), 'project worker source');
    assert.equal(await readFile(path.join(first.outputDirectory, 'assets/~partytown/debug/partytown.js'), 'utf8'), 'project debug source');
    assert.doesNotMatch(await browserSource(first), /PROJECT_PARTYTOWN_BOOTSTRAP/, 'bootstrap is SSR metadata, not an eager script side effect');
    const saved = await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8');
    await rm(path.join(root, 'node_modules/@builder.io/partytown'), { recursive: true });
    // A root devDependency must not satisfy this deliberately broken project
    // dependency through Node's ancestor lookup.
    await mkdir(path.join(root, 'node_modules/@builder.io/partytown'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/@builder.io/partytown/package.json'), JSON.stringify({ name: '@builder.io/partytown', exports: {} }));
    await assert.rejects(build(root, { dev: true }), /Partytown|partytown/);
    assert.equal(await readFile(path.join(first.outputDirectory, 'manifest.json'), 'utf8'), saved);
    await writeFile(path.join(root, 'rustyx.config.mjs'), 'export default{experimental:{nextScriptWorkers:false}}');
    const disabled = await build(root, { dev: true });
    assert.equal(disabled.scriptWorkers, undefined);
    await assert.rejects(readFile(path.join(disabled.outputDirectory, 'assets/~partytown/partytown-sw.js')), { code: 'ENOENT' });
  });
});
