import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, cp, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanProject } from './scan.mjs';
import { build } from './index.mjs';
import { build as bundle } from 'esbuild';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, fn) {
  const root = await mkdtemp(path.join(repo, '.prnext-app-compiler-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const layout = `export default function Layout({children}) { return <html><body>{children}</body></html>; }`;

test('App Router scans inherited conventions, groups, private folders and route handlers alongside Pages', async () => {
  await fixture({
    'src/app/layout.tsx': layout,
    'src/app/loading.tsx': 'export default () => null;',
    'src/app/(shop)/layout.tsx': 'export default ({children}) => children;',
    'src/app/(shop)/products/[id]/page.tsx': 'export default () => null;',
    'src/app/(shop)/products/error.tsx': "'use client'; export default () => null;",
    'src/app/(shop)/products/not-found.tsx': 'export default () => null;',
    'src/app/_private/page.tsx': 'not even parsed',
    'src/app/_private/route.ts': 'not even parsed',
    'src/app/health/route.ts': 'export const GET = () => new Response("ok");',
    'src/app/index/page.tsx': 'export default () => null;',
    'pages/legacy.tsx': 'export default () => null;',
  }, async root => {
    const project = await scanProject(root);
    assert.deepEqual(project.routes.map(route => route.pattern).sort(), ['/health', '/index', '/legacy', '/products/[id]']);
    const product = project.routes.find(route => route.pattern === '/products/[id]');
    assert.equal(product.router, 'app');
    assert.equal(product.segments[0].layout, path.join(root, 'src/app/layout.tsx'));
    assert.equal(product.segments[0].loading, path.join(root, 'src/app/loading.tsx'));
    assert.equal(product.segments[1].layout, path.join(root, 'src/app/(shop)/layout.tsx'));
    assert.equal(product.segments[2].error, path.join(root, 'src/app/(shop)/products/error.tsx'));
    assert.equal(product.segments[2].notFound, path.join(root, 'src/app/(shop)/products/not-found.tsx'));
    assert.equal(project.routes.find(route => route.pattern === '/health').kind, 'api');
  });
});

test('App Router rejects ambiguous routing and absent root layouts, while discovering parallel slots', async () => {
  await fixture({ 'app/layout.tsx': layout, 'app/(one)/page.tsx': '', 'app/(two)/page.tsx': '' }, root => assert.rejects(scanProject(root), /Conflicting routes/));
  await fixture({ 'app/layout.tsx': layout, 'app/page.tsx': '', 'pages/index.tsx': '' }, root => assert.rejects(scanProject(root), /Conflicting routes/));
  await fixture({ 'app/layout.tsx': layout, 'app/page.tsx': '', 'app/route.ts': '' }, root => assert.rejects(scanProject(root), /page and route handler/));
  await fixture({ 'app/layout.tsx': layout, 'app/page.js': '', 'app/page.tsx': '' }, root => assert.rejects(scanProject(root), /Multiple page/));
  await fixture({ 'app/layout.tsx': layout, 'app/@modal/page.tsx': '' }, async root => {
    const project = await scanProject(root);
    assert.equal(project.routes[0].pattern, '/');
    assert.ok(project.routes[0].routing.slots.modal);
  });
  await fixture({ 'app/page.tsx': '' }, root => assert.rejects(scanProject(root), /root layout/));
});

test('App compiler produces real Flight references, SSR/browser exports and excludes server secrets', async () => {
  await fixture({
    'app/layout.tsx': layout,
    'app/page.tsx': `import 'server-only'; import {readFileSync} from 'node:fs'; import Counter, {Badge} from './counter'; import {NpmWidget} from 'client-fixture'; import {CjsWidget} from 'cjs-client-fixture'; import styles from './page.module.css'; import './global.css'; const secret='PRNEXT_RSC_SERVER_SECRET_SENTINEL'; export default async function Page() { const label=await Promise.resolve('server result'); readFileSync('/dev/null'); if (!secret) throw new Error('secret'); return <main className={styles.main}><h1>{label}</h1><Counter count={3}/><Badge label="named"/><NpmWidget/><CjsWidget/></main>; }`,
    'app/counter.tsx': `'use client'; import {useState} from 'react'; export * from './badge'; export default function Counter({count}) { const [value,setValue]=useState(count); return <button onClick={()=>setValue(value+1)}>{value}</button>; }`,
    'app/badge.tsx': `export function Badge({label}) { return <span>{label}</span>; }`,
    'app/page.module.css': '.main{color:teal}',
    'app/global.css': 'body{margin:0}',
    'node_modules/client-fixture/package.json': JSON.stringify({name:'client-fixture',type:'module',exports:'./index.js',optionalDependencies:{'unused-native':'1.0.0'}}),
    'node_modules/client-fixture/index.js': `'use client'; import {useState} from 'react'; import {widgetLabel} from 'client-helper'; export function NpmWidget(){const [value]=useState(widgetLabel);return <p>{value}</p>}`,
    'node_modules/client-helper/package.json': JSON.stringify({name:'client-helper',type:'module',exports:'./index.js',optionalDependencies:{'unused-native':'1.0.0'}}),
    'node_modules/client-helper/index.js': `import './widget.css'; export const widgetLabel='npm boundary';`,
    'node_modules/client-helper/widget.css': '.npm-widget{color:purple}',
    'node_modules/unused-native/package.json': '{"name":"unused-native","main":"index.js"}',
    'node_modules/unused-native/index.js': `module.exports='unused optional native package';`,
    'node_modules/unused-native/binding.node': 'unused native binary',
    'node_modules/cjs-client-fixture/package.json': '{"name":"cjs-client-fixture","main":"./index.cjs"}',
    'node_modules/cjs-client-fixture/index.cjs': `'use client'; const React=require('react'); Object.defineProperty(exports,'CjsWidget',{enumerable:true,get(){return CjsWidget}}); function CjsWidget(){const [value]=React.useState('cjs npm boundary');return React.createElement('p',null,value)}`,
  }, async root => {
    const built = await build(root);
    const route = built.routes.find(route => route.pattern === '/');
    assert.equal(route.router, 'app');
    assert.ok(route.client);
    assert.ok(route.css.length);
    assert.equal(built.prerendered.filter(seed => seed.path !== '/_not-found').length, 1, 'static App routes produce their own HTML and Flight pair');
    assert.equal(route.ssg, true);
    const seed = built.prerendered[0];
    assert.match(await readFile(path.join(built.outputDirectory, seed.file), 'utf8'), /server result/);
    assert.match(await readFile(path.join(built.outputDirectory, seed.dataFile), 'utf8'), /server result/);
    const references = Object.values(built.app.clientModules);
    assert.ok(references.length >= 5, 'application and framework client boundaries are registered');
    const pageReferences=[];
    for (const reference of references) {
      assert.equal(reference.chunks[0], reference.id);
      assert.equal(reference.chunks[1], reference.browserModule);
      const namespace = await import(pathToFileURL(path.join(built.outputDirectory, reference.ssrModule)).href);
      assert.ok(namespace.default || namespace.NpmWidget || namespace.LayoutProvider);
      if(namespace.default?.name!=='AppNavigationBoundary' && !namespace.ClientPageRoot && !namespace.LayoutProvider) pageReferences.push(reference);
      if (namespace.CjsWidget) {
        const output = await bundle({ entryPoints: [path.join(built.outputDirectory, 'assets', path.basename(reference.browserModule))], bundle:true, write:false, format:'esm', logLevel:'silent', plugins:[{name:'test-public-assets',setup(esbuild){esbuild.onResolve({filter:/^\/_prnext\/assets\//},args=>({path:path.join(built.outputDirectory,'assets',path.basename(args.path))}));}}] });
        const browser = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
        assert.equal(typeof browser.CjsWidget, 'function', 'CommonJS named exports survive the browser Flight module loader');
      }
    }
    const assets = await readdir(path.join(built.outputDirectory, 'assets'));
    const browser = (await Promise.all(assets.filter(file => file.endsWith('.js')).map(file => readFile(path.join(built.outputDirectory, 'assets', file), 'utf8')))).join('\n');
    assert.ok(!browser.includes('PRNEXT_RSC_SERVER_SECRET_SENTINEL'));
    assert.ok(!browser.includes('node:fs'));
    assert.ok(!browser.includes('server result'), 'Server Component render function is absent from browser graph');
    const script = `import React from 'react'; import {renderToReadableStream} from 'react-server-dom-webpack/server'; import * as route from ${JSON.stringify(pathToFileURL(path.join(built.outputDirectory, route.module)).href)}; const stream=renderToReadableStream(React.createElement(route.page.default, {params:Promise.resolve({}),searchParams:Promise.resolve({})}),${JSON.stringify(built.app.clientModules)}); process.stdout.write(await new Response(stream).text());`;
    const { stdout } = await execute(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', script], { cwd: root });
    assert.match(stdout, /server result/);
    assert.match(stdout, /\"count\":3/);
    assert.equal(pageReferences.length,3,'local, ESM npm and CommonJS npm client boundaries are registered');
    for (const reference of pageReferences) assert.ok(stdout.includes(reference.id), 'Flight contains the genuine client module reference');
    const rebuilt = await build(root, {dev:true});
    assert.deepEqual(Object.keys(rebuilt.app.clientModules).sort(), Object.keys(built.app.clientModules).sort(), 'client ids remain stable across production/development');
  });
});

test('App compiler refuses server-only imports and inline actions in Client Components', async () => {
  await fixture({
    'app/layout.tsx': layout,
    'app/page.tsx': `import Client from './client'; export default () => <Client/>;`,
    'app/client.tsx': `'use client'; import secret from './secret'; export default () => <p>{secret}</p>;`,
    'app/secret.ts': `import 'server-only'; export default 'SECRET';`,
  }, async root => {
    await assert.rejects(build(root), /server-only.*Client Component/);
    await writeFile(path.join(root, 'app/client.tsx'), `'use client'; export default function Client(){async function action(){'use server';}return null;}`);
    await assert.rejects(build(root), /Inline 'use server'.*Client Component/);
    await writeFile(path.join(root, 'app/client.tsx'), `'use client'; import {unstable_cache} from 'next/cache'; export default function Client(){return <p>{String(unstable_cache)}</p>}`);
    await assert.rejects(build(root), /next\/cache is server-only.*Client Component/);
  });
});

test('App route handlers build without a layout or a page default export', async () => {
  await fixture({ 'app/health/route.ts': `export const GET = () => new Response('healthy'); export const POST = async request => new Response(await request.text());` }, async root => {
    const built = await build(root);
    assert.equal(built.routes.length, 1);
    assert.equal(built.routes[0].router, 'app');
    assert.equal(built.routes[0].kind, 'api');
    const api = await import(pathToFileURL(path.join(built.outputDirectory, built.routes[0].module)).href);
    assert.equal(await api.GET().text(), 'healthy');
    assert.equal(await (await api.POST(new Request('http://test/health', {method:'POST',body:'posted'}))).text(), 'posted');
  });
});


test('App builds reject mismatched React protocol packages and preserve the last successful output', async () => {
  await fixture({ 'app/health/route.ts': `export const GET=()=>new Response('healthy');` }, async root => {
    const initial = await build(root);
    const before = await readFile(path.join(initial.outputDirectory, 'manifest.json'), 'utf8');
    for (const name of ['react', 'react-dom', 'react-server-dom-webpack']) {
      const directory = path.join(root, 'node_modules', name);
      await mkdir(directory, {recursive:true});
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({name,version:'19.3.1'}));
      await assert.rejects(build(root), error => {
        assert.match(error.message, /requires exactly matching React protocol versions/);
        assert.ok(error.message.includes(`${name}@19.3.1`));
        assert.match(error.message, /npm install --save-exact react@19\.3\.0 react-dom@19\.3\.0 react-server-dom-webpack@19\.3\.0/);
        return true;
      });
      assert.equal(await readFile(path.join(initial.outputDirectory, 'manifest.json'), 'utf8'), before);
      await rm(directory, {recursive:true,force:true});
    }
  });
});

test('computed native npm loaders traverse runtime and optional dependencies and survive relocation', async t => {
  let include;
  for (const directory of [path.resolve(path.dirname(process.execPath), '../include/node'), '/usr/local/include/node', '/usr/include/node', '/opt/homebrew/include/node']) {
    try { await access(path.join(directory, 'node_api.h')); include=directory; break; } catch {}
  }
  if (!include) { t.skip('Node-API development headers are not installed'); return; }
  try { await execute('cc', ['--version']); } catch { t.skip('A C compiler is required for the native Node-API relocation test'); return; }
  const deployment = await mkdtemp(path.join(os.tmpdir(), 'prnext-native-deployment-'));
  try {
    await fixture({
      'package.json': JSON.stringify({name:'native-app',type:'module',dependencies:{'native-owner':'1.0.0'}}),
      'app/health/route.ts': `import value from 'native-owner'; export const GET=()=>new Response(value());`,
      'app/layout.tsx': layout,
      'app/page.tsx': `import Client from './client';export default ()=> <Client/>;`,
      'app/client.tsx': `'use client';import value from 'native-owner';export default ()=> <p>{value()}</p>;`,
      'node_modules/native-owner/package.json': JSON.stringify({name:'native-owner',version:'1.0.0',main:'index.cjs',exports:{browser:'./browser.cjs',default:'./index.cjs'},dependencies:{'native-loader':'1.0.0'}}),
      'node_modules/native-owner/index.cjs': `const leaf=require('native-loader');const fs=require('node:fs');const path=require('node:path');module.exports=()=>fs.readFileSync(path.join(__dirname,'label.txt'),'utf8')+leaf.answer();`,
      'node_modules/native-owner/label.txt': 'relocated-native:',
      'node_modules/native-owner/browser.cjs': `module.exports=()=> 'browser-native:42';`,
      'node_modules/native-owner/node_modules/native-loader/package.json': JSON.stringify({name:'native-loader',version:'1.0.0',main:'index.cjs',optionalDependencies:{'uninstalled-platform-addon':'1.0.0','native-leaf':'1.0.0'}}),
      'node_modules/native-owner/node_modules/native-loader/index.cjs': `const packageName=['native','leaf'].join('-');module.exports=require(packageName);`,
      'node_modules/native-owner/node_modules/native-loader/node_modules/native-leaf/package.json': '{"name":"native-leaf","version":"1.0.0","main":"index.cjs"}',
      'node_modules/native-owner/node_modules/native-loader/node_modules/native-leaf/index.cjs': `const path=require('node:path');const file=['binding','node'].join('.');module.exports=require(path.join(__dirname,file));`,
      'addon.c': `#include <node_api.h>
static napi_value answer(napi_env env,napi_callback_info info){napi_value value;napi_create_int32(env,42,&value);return value;}
static napi_value init(napi_env env,napi_value exports){napi_value function;napi_create_function(env,"answer",NAPI_AUTO_LENGTH,answer,NULL,&function);napi_set_named_property(env,exports,"answer",function);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
`,
    }, async root => {
      const binary = path.join(root, 'node_modules/native-owner/node_modules/native-loader/node_modules/native-leaf/binding.node');
      await execute('cc', ['-shared','-fPIC',...(process.platform === 'darwin' ? ['-undefined','dynamic_lookup'] : []), '-DNODE_GYP_MODULE_NAME=native_fixture', '-I',include,path.join(root,'addon.c'),'-o',binary]);
      const built = await build(root);
      const browserFiles = await readdir(path.join(built.outputDirectory,'assets'));
      assert.ok(!browserFiles.some(file=>file.endsWith('.node')));
      const browserCode = (await Promise.all(browserFiles.filter(file=>file.endsWith('.js')).map(file=>readFile(path.join(built.outputDirectory,'assets',file),'utf8')))).join('\n');
      assert.ok(browserCode.includes('browser-native:42'),'Client Components resolve the native package browser condition');
      assert.ok(!browserCode.includes('binding.node'));
      await cp(built.outputDirectory,path.join(deployment,'.prnext'),{recursive:true});
      await mkdir(path.join(deployment,'node_modules'),{recursive:true});
      await cp(path.join(root,'node_modules/native-owner'),path.join(deployment,'node_modules/native-owner'),{recursive:true});
      await rm(root,{recursive:true,force:true});
      const route = built.routes.find(route => route.pattern === '/health');
      const script = `import {GET} from ${JSON.stringify(pathToFileURL(path.join(deployment,'.prnext',route.module)).href)};process.stdout.write(await GET().text());`;
      const result = await execute(process.execPath,['--input-type=module','-e',script],{cwd:deployment});
      assert.equal(result.stdout,'relocated-native:42','relocated Node resolves the installed native package, nested addon and adjacent data');
    });
  } finally { await rm(deployment,{recursive:true,force:true}); }
});

test('local addons need a relocatable npm package and native binaries cannot enter Client Components', async () => {
  await fixture({
    'app/health/route.ts': `import value from '../../binding.node';export const GET=()=>new Response(String(value));`,
    'binding.node': 'not a real binary',
  }, root => assert.rejects(build(root), /Local native addon.*cannot be relocated.*Package the addon/));
  await fixture({
    'app/layout.tsx': layout,
    'app/page.tsx': `import Client from './client';export default ()=> <Client/>;`,
    'app/client.tsx': `'use client';import native from 'native-client-fixture';export default ()=> <p>{native.answer()}</p>;`,
    'node_modules/native-client-fixture/package.json': '{"name":"native-client-fixture","main":"index.cjs"}',
    'node_modules/native-client-fixture/index.cjs': `module.exports=require('./binding.node');`,
    'node_modules/native-client-fixture/binding.node': 'not a browser binary',
  }, root => assert.rejects(build(root), /Native Node addon.*cannot run in a Client Component/));
});
