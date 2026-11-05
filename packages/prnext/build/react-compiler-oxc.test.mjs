import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SourceMap, createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {transform} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {__napiBindingTarget} from 'oxc-transform-react';
import {createReactCompilerTransform, normalizeReactCompilerConfig, OXC_REACT_COMPILER_VERSION} from './react-compiler.mjs';
import {withCompilation, configureCompiler} from './compiler.mjs';
import {reactCompilerReport, withReactCompilerGraph, printReactCompilerReport, writeReactCompilerReport, readReactCompilerReport} from './react-compiler-report.mjs';
import {withSourceMaps, configureSourceMaps, extractSourceMap, inlineSourceMap} from './source-maps.mjs';
import {createSourceLocationTransform, createRefreshTransform} from './dev.mjs';
import {transformCacheStats} from './transform-cache.mjs';

const config = {backend: 'oxc'};
const root = path.resolve('/oxc-compiler-fixture');
const filename = name => path.join(root, name + '.jsx');
const component = 'export function Card({title}){return <p>{title}</p>}';
const memo = /react\/compiler-runtime/;
const invalid = "import{useState}from'react';export function Broken({flag}){if(flag){useState(0)}return <p/>}";
const require = createRequire(import.meta.url);

async function reportFor(run, settings = config) {
  return withCompilation(async () => {
    configureCompiler({root, config: {reactCompiler: settings}, buildId: 'oxc-test'});
    await run(createReactCompilerTransform(root, settings));
    return reactCompilerReport();
  });
}
async function commonJs(source) {
  const lowered = await transform(source, {loader: 'jsx', jsx: 'automatic', format: 'cjs'});
  const module = {exports: {}};
  runInNewContext(lowered.code, {module, exports: module.exports, require});
  return module.exports;
}

test('backend selection is explicit, strict, idempotent and leaves Babel defaults unchanged', () => {
  assert.equal(__napiBindingTarget, 'native', 'exercise the actual Rust binding');
  assert.equal(OXC_REACT_COMPILER_VERSION, '0.157.0');
  const defaults = {compilationMode: 'infer', panicThreshold: 'none', target: '19'};
  assert.deepEqual(normalizeReactCompilerConfig(true), defaults);
  assert.deepEqual(normalizeReactCompilerConfig({backend: 'babel'}), defaults);
  const normalized = normalizeReactCompilerConfig(config);
  assert.deepEqual(normalized, {backend: 'oxc', ...defaults});
  assert.deepEqual(normalizeReactCompilerConfig(normalized), normalized);
  for (const value of [null, '', true, 'rust', 'Oxc', 1]) assert.throws(() => normalizeReactCompilerConfig({backend: value}), /backend/);
  for (const value of [{backend: 'oxc', environment: {}}, {backend: 'oxc', outputMode: 'client'}, {backend: 'oxc', target: '18'}]) {
    assert.throws(() => normalizeReactCompilerConfig(value), /reactCompiler/);
  }
});

test('native compilation preserves ESM and JSX while lowering typed syntax', async () => {
  for (const extension of ['js', 'jsx', 'mjs', 'tsx']) {
    const source = extension === 'tsx' ? component.replace('({title})', '({title}:{title:string})') : component;
    const result = await createReactCompilerTransform(root, config)(source, path.join(root, 'Card.' + extension));
    assert.match(result, memo); assert.match(result, /export function Card/); assert.match(result, /<p>/);
    assert.doesNotMatch(result, /title:string/);
  }
});

test('native memoization really reuses equal results and invalidates changed props in CommonJS', async () => {
  const source = "const React=require('react');function Card({title}){return <p>{title}</p>}module.exports=Card;";
  const result = await createReactCompilerTransform(root, config)(source, path.join(root, 'Card.cjs'));
  assert.match(result, /require\("react\/compiler-runtime"\)/); assert.doesNotMatch(result, /\bimport\b/);
  const lowered = await transform(result, {loader: 'jsx', jsx: 'transform', format: 'cjs'});
  const module = {exports: {}}, cache = Array(2).fill(Symbol.for('react.memo_cache_sentinel'));
  runInNewContext(lowered.code, {module, exports: module.exports, require(name) {
    if (name === 'react') return {createElement: (tag, props, ...children) => ({tag, props, children})};
    assert.equal(name, 'react/compiler-runtime'); return {c: () => cache};
  }});
  const first = module.exports({title: 'First'});
  assert.equal(module.exports({title: 'First'}), first);
  const changed = module.exports({title: 'Changed'});
  assert.notEqual(changed, first); assert.equal(changed.children[0], 'Changed');
});

test('native annotation and opt-out directives are respected and Server Action source stays byte-identical', async () => {
  const compile = createReactCompilerTransform(root, config);
  const annotation = createReactCompilerTransform(root, {...config, compilationMode: 'annotation'});
  assert.doesNotMatch(await annotation(component, filename('unselected')), memo);
  assert.match(await annotation(component.replace('{return', '{"use memo";return'), filename('selected')), memo);
  for (const directive of ['use no memo', 'use no forget']) {
    assert.doesNotMatch(await compile(component.replace('{return', `{${JSON.stringify(directive)};return`), filename('function-' + directive)), memo);
    assert.doesNotMatch(await compile(JSON.stringify(directive) + ';\n' + component, filename('module-' + directive)), memo);
  }
  const action = '/* preserve comments */\n"use server";\n' + component;
  assert.equal(await compile(action, filename('action')), action);
});

test('native recoverable diagnostics remain visible and strict or syntax errors never silently fall back', async () => {
  const compile = createReactCompilerTransform(root, config);
  assert.doesNotMatch(await compile(invalid, filename('recoverable')), memo);
  await assert.rejects(createReactCompilerTransform(root, {...config, panicThreshold: 'all_errors'})(invalid, filename('strict')), /consistent order|conditionally/);
  await assert.rejects(compile('export function Broken( {', filename('syntax')), /React Compiler \(oxc|Expected/);
  const report = await reportFor(async compile => {
    await compile(invalid + '\n// SOURCE_SECRET', filename('diagnostic'));
    await assert.rejects(compile('export function Broken( {', filename('fatal-report')), /failed/);
  });
  assert.equal(report.backend, 'oxc'); assert.equal(report.compilerVersion, '0.157.0');
  assert.equal(report.summary.functions, 0); assert.equal(report.summary.optimized, 0);
  assert.equal(report.summary.diagnostics, 1); assert.equal(report.summary.errors, 1);
  assert.match(report.files.find(file => file.file === 'diagnostic.jsx').diagnostics[0].reason, /consistent order/);
  assert.doesNotMatch(JSON.stringify(report), /SOURCE_SECRET|codeframe|sourcesContent|<p>|[A-Za-z]:\\/);
  const lines = []; printReactCompilerReport(report, {details: true, log: line => lines.push(line)});
  assert.match(lines[0], /totals unavailable/); assert.doesNotMatch(lines[0], /0 optimized/);
});

test('source boundaries are enforced before native parsing, including generated loader output', async () => {
  const compile = createReactCompilerTransform(root, config), source = 'deliberately invalid @';
  for (const file of [path.join(root, 'node_modules/pkg/Card.jsx'), path.join(root, '.prnext-build-stage/Card.jsx'), path.join(root, 'types.d.ts'), path.join(root, 'asset.svg'), path.resolve('/outside/Card.jsx')]) {
    assert.equal(await compile(source, file), source);
  }
  assert.match(await compile(component, path.join(root, 'guide.mdx'), {loaderOutput: true}), memo);
  assert.equal(await compile(source, path.join(root, 'node_modules/guide.mdx'), {loaderOutput: true}), source);
  assert.match(await compile(component, path.join(root, 'my-node_modules-components/Card.jsx')), memo);
});

test('client and SSR graph modes have separate caches and actual SSR output renders without client memo hooks', async () => {
  const compile = createReactCompilerTransform(root, config), file = filename('graph-modes');
  const client = await withReactCompilerGraph('browser', () => compile(component, file));
  const ssr = await withReactCompilerGraph('node', () => compile(component, file));
  assert.match(client, memo); assert.doesNotMatch(ssr, memo);
  const module = await commonJs(ssr);
  assert.equal(renderToStaticMarkup(createElement(module.Card, {title: 'SSR'})), '<p>SSR</p>');
  assert.equal(await withReactCompilerGraph('edge', () => compile(component, file)), ssr);
  assert.equal(await withReactCompilerGraph('browser', () => compile(component, file)), client);
});

test('warm native results preserve file diagnostics and backend changes cannot reuse Babel transform entries', async () => {
  const file = filename('warm-native'), compile = createReactCompilerTransform(root, config);
  const firstStats = transformCacheStats();
  const first = await compile(component, file);
  assert.equal(transformCacheStats().misses, firstStats.misses + 1);
  assert.equal(await compile(component, file), first);
  assert.equal(transformCacheStats().hits, firstStats.hits + 1);
  const beforeBabel = transformCacheStats().misses;
  await createReactCompilerTransform(root, true)(component, file);
  assert.equal(transformCacheStats().misses, beforeBabel + 1);
  const report = await reportFor(async transform => {
    await withReactCompilerGraph('browser', () => transform(invalid, filename('warm-diagnostic')));
    await withReactCompilerGraph('browser', () => transform(invalid, filename('warm-diagnostic')));
  });
  assert.equal(report.summary.diagnostics, 1); assert.equal(report.summary.cacheReuses, 1);
  assert.equal(report.files[0].diagnostics.length, 1); assert.deepEqual(report.files[0].diagnostics[0].targets, ['browser']);
});

test('native source maps compose prior loader coordinates through actual JSX lowering', async () => withSourceMaps(async () => {
  configureSourceMaps(true);
  const file = path.join(root, 'Mapped.tsx');
  const source = 'export function Card({title}:{title:string}){return <p>{title + "native-map-value"}</p>}';
  const original = '\n'.repeat(7) + 'original template';
  const input = inlineSourceMap(source, {version: 3, sources: ['/fixture/original.template'], sourcesContent: [original], names: [], mappings: 'AAOA'});
  const result = await createReactCompilerTransform(root, config)(input, file);
  assert.match(result, memo); assert.ok(extractSourceMap(result).map);
  const lowered = await transform(result, {loader: 'tsx', sourcefile: file, sourcemap: 'external', minify: true});
  const offset = lowered.code.indexOf('native-map-value'); assert.ok(offset >= 0);
  const before = lowered.code.slice(0, offset).split('\n');
  const entry = new SourceMap(JSON.parse(lowered.map)).findEntry(before.length - 1, before.at(-1).length);
  assert.equal(entry.originalSource, '/fixture/original.template'); assert.equal(entry.originalLine, 7);
  assert.ok(JSON.parse(lowered.map).sourcesContent.includes(original));
}));

test('native JSX keeps editable inspector positions and enters the existing Fast Refresh transform', async () => withSourceMaps(async () => {
  configureSourceMaps(true);
  const source = 'export function Card({title}) {\n  return <main><h2>Static title</h2><p>{title}</p></main>;\n}';
  const file = filename('Inspector');
  // Static JSX can be hoisted without a generated mapping. The development
  // pipeline attaches the original inspector coordinates before native work.
  const located = await createSourceLocationTransform(root)(source, file);
  const compiled = await createReactCompilerTransform(root, config, {dev: true})(located, file);
  assert.match(compiled, /Inspector.jsx:2:10/);
  assert.match(compiled, /Inspector.jsx:2:16/);
  assert.match(compiled, /Inspector.jsx:2:37/);
  const refreshed = await createRefreshTransform(root)(compiled, file);
  assert.match(refreshed, /__prnextRegisterModule/); assert.match(refreshed, /Inspector.jsx:2:16/);
}));

test('native report artifacts round-trip and reject invented backend or diagnostic fields', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-oxc-report-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const report = await reportFor(compile => compile(invalid, filename('report-reader')));
  await writeReactCompilerReport(directory, report);
  assert.deepEqual(await readReactCompilerReport(directory), report);
  for (const mutate of [value => value.backend = 'babel', value => value.files[0].diagnostics[0].source = 'PRIVATE', value => value.files[0].diagnostics[0].reason = '\u001bunsafe']) {
    const changed = structuredClone(report); mutate(changed);
    await writeFile(path.join(directory, 'react-compiler-report.json'), JSON.stringify(changed));
    await assert.rejects(readReactCompilerReport(directory), /Invalid/);
  }
});

test('persistent native results replay in a fresh process without running Babel or losing diagnostics', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-oxc-persistent-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await writeFile(path.join(directory, 'package.json'), '{}');
  await writeFile(path.join(directory, 'Broken.jsx'), invalid);
  const code = `import {createReactCompilerTransform} from ${JSON.stringify(new URL('./react-compiler.mjs', import.meta.url).href)};
    import {withPersistentTransforms,transformCacheStats} from ${JSON.stringify(new URL('./transform-cache.mjs', import.meta.url).href)};
    import {withCompilation,configureCompiler,reactCompilerReport} from ${JSON.stringify(new URL('./compiler.mjs', import.meta.url).href)};
    const root=${JSON.stringify(directory)};
    const report=await withPersistentTransforms(root,{},()=>withCompilation(async()=>{
      configureCompiler({root,config:{reactCompiler:{backend:'oxc'}},buildId:'native-disk'});
      await createReactCompilerTransform(root,{backend:'oxc'})(${JSON.stringify(invalid)},${JSON.stringify(path.join(directory, 'Broken.jsx'))});return reactCompilerReport();
    }));console.log(JSON.stringify({report,stats:transformCacheStats()}));`;
  const invoke = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {windowsHide: true, env: {...process.env, PRNEXT_BUILD_CACHE: '1'}, maxBuffer: 1024 * 1024})).stdout);
  const first = await invoke(), second = await invoke();
  assert.equal(first.report.summary.cacheReuses, 0); assert.equal(second.stats.diskHits, 1);
  assert.equal(second.report.summary.cacheReuses, 1); assert.equal(second.report.summary.diagnostics, 1);
  assert.deepEqual(second.report.files[0].diagnostics, first.report.files[0].diagnostics);
});
