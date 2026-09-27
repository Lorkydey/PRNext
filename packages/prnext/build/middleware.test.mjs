import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanProject } from './scan.mjs';
import { inspectMiddleware } from './middleware.mjs';
import { build } from './index.mjs';
import { shouldWatchProjectFile } from '../runtime/env.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, callback) {
  const root = await mkdtemp(path.join(repository, '.prnext-middleware-'));
  try {
    for (const [name, source] of Object.entries({ 'pages/api/ping.js': `export default function(req,res){res.json({ok:true})}`, ...files })) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    await callback(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('middleware and proxy conventions scan root/src extensions and reject conflicting entries', async () => {
  for (const extension of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) {
    const source = extension === 'cjs' ? 'exports.proxy=()=>new Response("ok")' : 'export const proxy=()=>new Response("ok")';
    await fixture({ [`src/proxy.${extension}`]: source }, async root => {
      const project = await scanProject(root);
      assert.equal(project.middleware.convention, 'proxy');
      assert.equal(project.middleware.exportName, 'proxy');
      assert.equal(project.middleware.runtime, 'nodejs');
      assert.equal(project.middleware.matchers[0].source, '/:path*');
      await writeFile(path.join(root, 'middleware.ts'), 'export default()=>new Response("other")');
      await assert.rejects(scanProject(root), /Conflicting middleware\/proxy files/);
    });
  }
  await fixture({ 'proxy.js': 'export default()=>null', 'proxy.ts': 'export default()=>null' }, root => assert.rejects(scanProject(root), /Conflicting middleware\/proxy files/));
});

test('middleware static config compiles shared matchers and conditions without evaluating the application', async () => {
  await fixture({ 'middleware.ts': `throw new Error('Must not evaluate application at build');
    const selection=[{source:'/private/:id?',locale:false,has:[{type:'query',key:'id'},{type:'header',key:'x-role',value:'(?<role>admin|editor)'}],missing:[{type:'cookie',key:'skip'}]},'/((?!api|_prnext/assets).*)'] as const;
    export const config={matcher:selection,runtime:'edge'};export const middleware=()=>new Response('ok');export default()=>new Response('unused');` }, async root => {
    const descriptor = await inspectMiddleware(path.join(root, 'middleware.ts'));
    assert.equal(descriptor.exportName, 'middleware', 'named convention takes precedence over default');
    assert.equal(descriptor.declaredRuntime, 'edge');
    assert.equal(descriptor.runtime, 'edge');
    assert.equal(descriptor.matchers.length, 2);
    assert.equal(new RegExp(descriptor.matchers[0].regex, 'i').test('/private/a/'), true);
    assert.equal(new RegExp(descriptor.matchers[0].regex, 'i').test('/private'), true);
    assert.equal(new RegExp(descriptor.matchers[1].regex, 'i').test('/api/test'), false);
    assert.deepEqual(descriptor.matchers[0].has[1].captures, [{ name: 'role', index: 1 }]);
    assert.equal(descriptor.matchers[0].missing[0].key, 'skip');
    await writeFile(path.join(root, 'middleware.ts'), 'export const config={matcher:[]};export default()=>null');
    assert.deepEqual((await inspectMiddleware(path.join(root, 'middleware.ts'))).matchers, []);
  });
});

test('unsupported or executable middleware configuration fails with actionable build diagnostics', async () => {
  await fixture({}, async root => {
    const file = path.join(root, 'proxy.ts');
    for (const [source, pattern] of [
      ['export const runtime="nodejs";export function proxy(){}', /cannot configure runtime/],
      ['export const config={runtime:"nodejs"};export function proxy(){}', /cannot configure runtime/],
      ['export const config={matcher:getMatchers()};export function proxy(){}', /statically analyzable/],
      ['export const config={matcher:"relative"};export function proxy(){}', /source must start/],
      ['export const config={matcher:[{source:"/",locale:true}]};export function proxy(){}', /locale only accepts false/],
      ['export const config={matcher:"/",regions:["iad1"]};export function proxy(){}', /unsupported config fields/],
      ['export const config={unstable_allowDynamic:"**"};export function proxy(){}', /unsupported config fields/],
      ['export {config} from "./other";export function proxy(){}', /not re-exported/],
      ['export const proxy={};', /must be a function/],
      ['export function middleware(){}', /named proxy function/],
      ['export * from "./other";', /wildcard exports/],
      ['"use client";export function proxy(){}', /Client Components/],
    ]) {
      await writeFile(file, source);
      await assert.rejects(inspectMiddleware(file), pattern);
    }
    await writeFile(file, `export const config={matcher:${JSON.stringify(Array(1001).fill('/'))}};export function proxy(){}`);
    await assert.rejects(inspectMiddleware(file), /at most 1000/);
  });
});

test('middleware bundles npm compatibility imports and frozen env without executing or exposing its code to browsers', async () => {
  const privateName = 'PRNEXT_MIDDLEWARE_PRIVATE_TEST';
  const previous = process.env[privateName];
  delete globalThis.__prnextMiddlewareBuildEvaluation;
  try {
    process.env[privateName] = 'private-at-build';
    await fixture({
      'proxy.ts': `import {reply} from 'middleware-helper';globalThis.__prnextMiddlewareBuildEvaluation=(globalThis.__prnextMiddlewareBuildEvaluation||0)+1;
        export const config={matcher:['/intercept/:path*']};export async function proxy(request:Request){return reply(request,process.env.MIDDLEWARE_LABEL,process.env.PRNEXT_MIDDLEWARE_PRIVATE_TEST)}`,
      'prnext.config.mjs': `export default{env:{MIDDLEWARE_LABEL:'frozen-label'}}`,
      'node_modules/middleware-helper/package.json': '{"name":"middleware-helper","type":"module","exports":"./index.js"}',
      'node_modules/middleware-helper/index.js': `import{NextResponse}from'next/server';export const reply=(request,label,secret)=>NextResponse.json({path:new URL(request.url).pathname,label,secret});`,
    }, async root => {
      const built = await build(root);
      assert.equal(globalThis.__prnextMiddlewareBuildEvaluation, undefined);
      assert.equal(built.middleware.module, 'server/middleware.mjs');
      assert.equal(built.middleware.exportName, 'proxy');
      assert.equal(built.middleware.matchers[0].source, '/intercept/:path*');
      assert.ok(built.routes.filter(route => !route.internal).every(route => !route.client));
      for (const file of (await readdir(path.join(built.outputDirectory, 'assets'))).filter(file => file.endsWith('.js'))) {
        assert.doesNotMatch(await readFile(path.join(built.outputDirectory, 'assets', file), 'utf8'), /__prnextMiddlewareBuildEvaluation|middleware-helper|private-at-build|frozen-label/);
      }
      const source = await readFile(path.join(built.outputDirectory, built.middleware.module), 'utf8');
      assert.ok(source.includes('frozen-label'));
      assert.ok(!source.includes('private-at-build'));
      process.env[privateName] = 'private-at-runtime';
      const module = await import(pathToFileURL(path.join(built.outputDirectory, built.middleware.module)).href);
      const response = await module.proxy(new Request('http://example.test/intercept/one'));
      assert.deepEqual(await response.json(), { path: '/intercept/one', label: 'frozen-label', secret: 'private-at-runtime' });
      assert.equal(globalThis.__prnextMiddlewareBuildEvaluation, 1);
      const before = await readFile(path.join(built.outputDirectory, 'manifest.json'), 'utf8');
      await writeFile(path.join(root, 'proxy.ts'), `export const config={matcher:compute()};export function proxy(){}`);
      await assert.rejects(build(root), /statically analyzable/);
      assert.equal(await readFile(path.join(built.outputDirectory, 'manifest.json'), 'utf8'), before);
    });
  } finally {
    if (previous === undefined) delete process.env[privateName]; else process.env[privateName] = previous;
    delete globalThis.__prnextMiddlewareBuildEvaluation;
  }
});

test('CommonJS middleware and native npm loaders remain callable after relocation', async t => {
  await fixture({
    'middleware.cjs': `const native=require('native-middleware');module.exports=function(request){return new Response(native.value+':'+new URL(request.url).pathname)};module.exports.config={matcher:'/native/:path*'};`,
    'node_modules/native-middleware/package.json': '{"name":"native-middleware","main":"index.cjs"}',
    'node_modules/native-middleware/index.cjs': `const fs=require('node:fs');exports.value=fs.readFileSync(__dirname+'/value.txt','utf8');`,
    'node_modules/native-middleware/value.txt': 'native-adjacent-file',
    'node_modules/native-middleware/addon.node': 'fixture for native package discovery; not executed',
  }, async root => {
    const built = await build(root);
    const source = await readFile(path.join(built.outputDirectory, built.middleware.module), 'utf8');
    assert.ok(source.includes('native-middleware'));
    assert.ok(!source.includes('native-adjacent-file'));
    const relocated = root + '-relocated';
    t.after(() => rm(relocated, { recursive: true, force: true }));
    await rename(root, relocated);
    const namespace = await import(pathToFileURL(path.join(relocated, '.prnext', built.middleware.module)).href);
    assert.equal(await (await namespace.default(new Request('http://example.test/native/test'))).text(), 'native-adjacent-file:/native/test');
  });
});

test('development file watching includes added, changed and removed root/src middleware conventions', () => {
  for (const root of ['', 'src/']) for (const name of ['middleware', 'proxy']) for (const extension of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) {
    assert.equal(shouldWatchProjectFile(`${root}${name}.${extension}`), true);
  }
  assert.equal(shouldWatchProjectFile('.prnext/server/middleware.mjs'), false);
  assert.equal(shouldWatchProjectFile('node_modules/library/middleware.js'), false);
});

test('middleware constant expansion is bounded before allocation without reducing matcher capacity', async () => {
  await fixture({}, async root => {
    const file = path.join(root, 'proxy.js');
    const declarations = ["const level0=['/'];"];
    for (let level = 1; level <= 8; level++) declarations.push(`const level${level}=[${Array(8).fill(`level${level - 1}`).join(',')}];`);
    await writeFile(file, `${declarations.join('\n')}\nexport const config={matcher:level8};export function proxy(){}`);
    // This tiny source describes over 16 million expanded leaves. A subprocess
    // heap cap makes the regression distinguish a budget error from an OOM.
    const script = `import {inspectMiddleware} from ${JSON.stringify(new URL('./middleware.mjs', import.meta.url).href)};
      try {await inspectMiddleware(process.argv[1]);process.exitCode=2}
      catch(error){if(!/configuration constant expansion exceeds/.test(error.message))throw error;process.stdout.write('bounded')}`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script, file],
      { timeout: 5000, maxBuffer: 16 * 1024 });
    assert.equal(stdout, 'bounded');
    const matchers = Array.from({ length: 1000 }, (_, index) => '/' + 'a'.repeat(850) + index);
    await writeFile(file, `export const config={matcher:${JSON.stringify(matchers)}};export function proxy(){}`);
    const result = await inspectMiddleware(file);
    assert.equal(result.matchers.length, 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(result.matchers)) < 2 * 1024 * 1024);
    await writeFile(file, `export const config={matcher:${JSON.stringify(Array(1000).fill('/' + 'a'.repeat(1100)))}};export function proxy(){}`);
    await assert.rejects(inspectMiddleware(file), /compiled matchers exceed 2 MiB/);
  });
});
