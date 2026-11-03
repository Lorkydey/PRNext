import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build, disposeBuildSession} from './index.mjs';
import {readReactCompilerReport} from './react-compiler-report.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const memo = /react\/compiler-runtime|react\.memo_cache_sentinel|useMemoCache|const\s+\$\s*=/;
const nativeMemo = /const \$ = [^\n]*\(\d+\)/;
async function fixture(files, run) {
  const root = await mkdtemp(path.join(repository, '.prnext-oxc-build-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    for (const [name, source] of Object.entries(files)) {
      const filename = path.join(root, name);
      await mkdir(path.dirname(filename), {recursive: true}); await writeFile(filename, source);
    }
    await run(root);
  } finally { await disposeBuildSession(root); await rm(root, {recursive: true, force: true}); }
}
async function scripts(output, folder) {
  const directory = path.join(output, folder);
  const files = await readdir(directory).catch(error => {if (error.code === 'ENOENT') return []; throw error;});
  return (await Promise.all(files.filter(name => /\.(?:m?js)$/.test(name)).map(name => readFile(path.join(directory, name), 'utf8')))).join('\n');
}
async function emitted(output, folder, name) {
  const match = new RegExp('function ' + name + '\\([^]*?\\n}').exec(await scripts(output, folder));
  assert.ok(match, 'actual emitted function ' + name); return match[0];
}

test('Oxc build optimizes browser code, emits SSR-specific client boundaries, and excludes executable server graphs', async () => {
  await fixture({
    'next.config.mjs': "export default {reactCompiler:{backend:'oxc'}}",
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.jsx': "import Counter from './Counter.jsx';export default function Page(){return <Counter value={7}/>}",
    'app/Counter.jsx': "'use client';import {Action} from './actions.js';export default function Counter({value}){const label='native:'+value;return <button onClick={()=>Action()}>{label}</button>}",
    'app/actions.js': "'use server';export async function Action(){return 'action-original'}",
    'app/api/route.js': "export function GET(){return new Response('route-original')}",
    'app/edge/page.jsx': "import Counter from '../Counter.jsx';export const runtime='edge';export default function EdgePage(){return <Counter value={9}/>}",
    'pages/legacy.jsx': "export default function PagesCard({title='Pages'}){return <strong>{title}</strong>}",
    'pages/api/invoice.jsx': "import {renderToStaticMarkup} from 'react-dom/server';function Invoice(){return <p>invoice-original</p>}export default function handler(_req,res){res.json({html:renderToStaticMarkup(Invoice())})}",
  }, async root => {
    const result = await build(root, {dev: true, incremental: true});
    assert.match(await emitted(result.outputDirectory, 'assets', 'Counter'), nativeMemo);
    assert.doesNotMatch(await emitted(result.outputDirectory, 'app-ssr', 'Counter'), memo);
    assert.doesNotMatch(await emitted(result.outputDirectory, 'app-ssr-edge', 'Counter'), memo);
    assert.doesNotMatch(await scripts(result.outputDirectory, 'server'), memo);
    assert.ok(Object.keys(result.app.actions).length, 'Server Action really emitted');
    const report = await readReactCompilerReport(result.outputDirectory, {buildId: result.buildId});
    assert.equal(report.backend, 'oxc'); assert.equal(report.compilerVersion, '0.157.0');
    const counter = report.files.find(file => file.file === 'app/Counter.jsx');
    assert.deepEqual(counter.targets, ['browser', 'edge', 'node']);
    assert.deepEqual(counter.functions, []); assert.match(counter.notes.join(' '), /totals are unavailable/);
    assert.ok(counter.notes.includes('Oxc output mode: ssr. TypeScript syntax is removed; JSX is preserved for the graph compiler.'));
    const page = await import(pathToFileURL(path.join(result.outputDirectory, result.routes.find(route => route.pattern === '/legacy').module)).href);
    assert.equal(renderToStaticMarkup(createElement(page.default)), '<strong data-prnext-source="pages/legacy.jsx:1:59">Pages</strong>');
    const api = await import(pathToFileURL(path.join(result.outputDirectory, result.routes.find(route => route.pattern === '/api/invoice').module)).href);
    let response; api.default({}, {json(value) {response = value;}});
    assert.equal(response.html, '<p data-prnext-source="pages/api/invoice.jsx:1:81">invoice-original</p>');
    let ssr;
    for (const boundary of Object.values(result.app.clientModules)) {
      const module = await import(pathToFileURL(path.join(result.outputDirectory, boundary.ssrModule)).href);
      if (module.default?.name === 'Counter') ssr = module;
    }
    assert.ok(ssr); assert.match(renderToStaticMarkup(createElement(ssr.default, {value: 7})), /native:7/);
    assert.doesNotMatch(JSON.stringify(result.config), /reactCompiler|backend|diagnostics|cacheReuses/);
  });
});

test('incremental backend, annotation and off switches invalidate graph output without changing component source', async () => {
  await fixture({
    'next.config.mjs': 'export default {reactCompiler:true}',
    'pages/index.jsx': "export default function SwitchCard({title}){return <p>{title}</p>}",
  }, async root => {
    const options = {dev: true, incremental: true};
    const babel = await build(root, options);
    assert.equal((await readReactCompilerReport(babel.outputDirectory)).backend, 'babel');
    await writeFile(path.join(root, 'next.config.mjs'), "export default {reactCompiler:{backend:'oxc'}}");
    const native = await build(root, options), nativeReport = await readReactCompilerReport(native.outputDirectory);
    assert.equal(nativeReport.backend, 'oxc'); assert.equal(nativeReport.compilerVersion, '0.157.0');
    assert.match(await emitted(native.outputDirectory, 'assets', 'SwitchCard'), nativeMemo);
    const warm = await build(root, options), warmReport = await readReactCompilerReport(warm.outputDirectory);
    assert.equal(warmReport.backend, 'oxc'); assert.ok(warmReport.summary.cacheReuses >= 1);
    await writeFile(path.join(root, 'next.config.mjs'), "export default {reactCompiler:{backend:'oxc',compilationMode:'annotation'}}");
    const annotation = await build(root, options);
    assert.doesNotMatch(await emitted(annotation.outputDirectory, 'assets', 'SwitchCard'), memo);
    assert.equal((await readReactCompilerReport(annotation.outputDirectory)).options.compilationMode, 'annotation');
    await writeFile(path.join(root, 'next.config.mjs'), 'export default {reactCompiler:false}');
    const off = await build(root, options);
    assert.doesNotMatch(await emitted(off.outputDirectory, 'assets', 'SwitchCard'), memo);
    assert.equal((await readReactCompilerReport(off.outputDirectory)).enabled, false);
    await writeFile(path.join(root, 'next.config.mjs'), 'export default {reactCompiler:true}');
    const restored = await build(root, options);
    const report = await readReactCompilerReport(restored.outputDirectory);
    assert.equal(report.backend, 'babel'); assert.equal(report.summary.optimized, 1);
  });
});

test('both graph bridges send real loader-produced JSX to the native compiler before lowering', async () => {
  for (const graph of ['turbopack', 'webpack']) await fixture({
    'next.config.mjs': graph === 'webpack'
      ? "export default {reactCompiler:{backend:'oxc'},webpack(config){config.module.rules.push({test:/Card\\.jsx$/,use:['./jsx-loader.cjs']});return config}}"
      : "export default {reactCompiler:{backend:'oxc'},turbopack:{rules:{'Card.jsx':{loaders:['./jsx-loader.cjs'],as:'*.jsx'}}}}",
    'jsx-loader.cjs': "module.exports=source=>source.replace('__JSX__','<p>{title}</p>')",
    'components/Card.jsx': 'export default function LoadedCard({title}){return __JSX__}',
    'pages/index.jsx': "import Card from '../components/Card.jsx';export default function Page(){'use no memo';return <Card title='loader-original'/>}",
  }, async root => {
    const result = await build(root, {dev: true, incremental: true});
    assert.match(await emitted(result.outputDirectory, 'assets', 'LoadedCard'), nativeMemo, graph);
    assert.doesNotMatch(await scripts(result.outputDirectory, 'server'), /__JSX__|react\.memo_cache_sentinel/, graph);
    const report = await readReactCompilerReport(result.outputDirectory);
    assert.equal(report.backend, 'oxc');
    assert.ok(report.files.find(file => file.file === 'components/Card.jsx').notes.some(note => /configured loader/.test(note)));
    const page = await import(pathToFileURL(path.join(result.outputDirectory, result.routes[0].module)).href);
    assert.match(renderToStaticMarkup(createElement(page.default)), /loader-original/);
  });
});
