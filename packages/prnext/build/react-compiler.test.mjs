import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { createReactCompilerTransform, normalizeReactCompilerConfig, REACT_COMPILER_VERSION } from './react-compiler.mjs';
import { transformCacheStats } from './transform-cache.mjs';
import { withSourceMaps, configureSourceMaps, extractSourceMap, inlineSourceMap } from './source-maps.mjs';

const component = 'export function Card({title}){return <p>{title}</p>}';
const compiled = /react\/compiler-runtime/;

test('normalizes a narrow React 19 compiler config without mutating caller options', () => {
  assert.equal(normalizeReactCompilerConfig(undefined), false);
  assert.equal(normalizeReactCompilerConfig(false), false);
  const defaults = { compilationMode: 'infer', panicThreshold: 'none', target: '19' };
  assert.deepEqual(normalizeReactCompilerConfig(true), defaults);
  assert.deepEqual(normalizeReactCompilerConfig({}), defaults);
  const input = { compilationMode: 'annotation', panicThreshold: 'all_errors' };
  assert.deepEqual(normalizeReactCompilerConfig(input), { ...defaults, ...input });
  assert.deepEqual(input, { compilationMode: 'annotation', panicThreshold: 'all_errors' });
  assert.deepEqual(normalizeReactCompilerConfig(normalizeReactCompilerConfig(true)), defaults);
  assert.deepEqual(normalizeReactCompilerConfig({ target: undefined }), defaults);
  assert.equal(REACT_COMPILER_VERSION, '1.0.0');
  for (const value of [null, [], '', 1, () => {}, new Date(), { target: '18' }, { target: 19 }, { target: null },
    { compilationMode: 'all' }, { compilationMode: 'syntax' }, { compilationMode: null }, { panicThreshold: 'always' },
    { panicThreshold: false }, { sources: [] }, { logger() {} }, { environment: {} }, { [Symbol('extra')]: true }]) {
    assert.throws(() => normalizeReactCompilerConfig(value), /reactCompiler/);
  }
});

test('disabled compiler is byte-identical and never parses invalid source', async () => {
  const source = '\uFEFFthis is deliberately not valid JSX\n//# sourceMappingURL=data:invalid';
  for (const config of [undefined, false]) assert.equal(await createReactCompilerTransform('/fixture', config)(source), source);
});

test('official compiler memoizes JSX while preserving TypeScript and ESM for later transforms', async () => {
  for (const extension of ['js', 'jsx', 'mjs', 'tsx']) {
    const typed = extension === 'tsx';
    const source = typed ? 'export type Title=string;export function Card({title}:{title:Title}){return <p>{title}</p>}' : component;
    const result = await createReactCompilerTransform('/fixture', true)(source, '/fixture/Card.' + extension);
    assert.match(result, compiled);
    assert.match(result, /\$\[0\] !== title/);
    assert.match(result, /export function Card/);
    assert.match(result, /<p>/, 'JSX remains available to the graph transform');
    if (typed) assert.match(result, /export type Title = string/);
    assert.equal(extractSourceMap(result).map, undefined);
  }
  for (const extension of ['ts', 'mts']) {
    const source = "export type Title=string;import {useState} from 'react';export function useTitle(title:Title){const [value]=useState(title);return {value}}";
    const result = await createReactCompilerTransform('/fixture', true)(source, '/fixture/useTitle.' + extension);
    assert.match(result, compiled);
    assert.match(result, /export type Title = string/);
    assert.match(result, /useState\(title\)/);
    assert.match(result, /\$\[0\] !== value/);
  }
});

test('official CommonJS output retains requires/exports and reuses the rendered value', async () => {
  for (const extension of ['cjs', 'cts']) {
    const source = extension === 'cjs'
      ? "'use strict';const React=require('react');function Card({title}){return <p>{title}</p>}module.exports=Card;"
      : "'use strict';const{useState}=require('react');function useTitle({title}){const [value]=useState(title);return {title:value}}module.exports=useTitle;";
    const result = await createReactCompilerTransform('/fixture', true)(source, '/fixture/Card.' + extension);
    assert.match(result, /require\("react\/compiler-runtime"\)/);
    assert.doesNotMatch(result, /\bimport\b/);
    assert.match(result, /module\.exports = (?:Card|useTitle)/);
    const lowered = await transform(result, { loader: extension === 'cts' ? 'ts' : 'jsx', jsx: 'transform', format: 'cjs' });
    const module = { exports: {} }, cache = Array(2).fill(Symbol.for('react.memo_cache_sentinel'));
    runInNewContext(lowered.code, { module, exports: module.exports, require(name) {
      if (name === 'react') return { createElement: (tag, props, ...children) => ({ tag, props, children }), useState: value => [value] };
      assert.equal(name, 'react/compiler-runtime');
      return { c: () => cache };
    } });
    const first = module.exports({ title: 'First' });
    assert.equal(module.exports({ title: 'First' }), first, 'equal component inputs reuse the actual JSX result');
    const changed = module.exports({ title: 'Changed' });
    assert.notEqual(changed, first);
    assert.equal(extension === 'cjs' ? changed.children[0] : changed.title, 'Changed');
  }
});

test('annotation mode and function/module opt-outs use official compiler directives', async () => {
  const inferred = createReactCompilerTransform('/fixture', true);
  const annotation = createReactCompilerTransform('/fixture', { compilationMode: 'annotation' });
  assert.doesNotMatch(await annotation(component, '/fixture/Card.jsx'), compiled);
  assert.match(await annotation(component.replace('{return', '{"use memo";return'), '/fixture/Card.jsx'), compiled);
  assert.doesNotMatch(await inferred(component.replace('{return', '{"use no memo";return'), '/fixture/Card.jsx'), compiled);
  assert.doesNotMatch(await inferred('"use no memo";\n' + component, '/fixture/Card.jsx'), compiled);
  const action = '/* Server Action module */\n"use server";\n' + component;
  assert.equal(await inferred(action, '/fixture/actions.tsx'), action);
});

test('default bailouts preserve invalid React code, strict diagnostics and syntax failures propagate', async () => {
  const invalid = "import{useState}from'react';export function Broken({flag}){if(flag){useState(0)}return <p/>}";
  const regular = await createReactCompilerTransform('/fixture', true)(invalid, '/fixture/Broken.jsx');
  assert.doesNotMatch(regular, compiled);
  assert.match(regular, /useState\(0\)/);
  await assert.rejects(createReactCompilerTransform('/fixture', { panicThreshold: 'all_errors' })(invalid, '/fixture/Broken.jsx'), /conditionally|Hooks|hook/i);
  await assert.rejects(createReactCompilerTransform('/fixture', true)('export function Broken( {', '/fixture/Syntax.jsx'), /Syntax|Unexpected token/);
});

test('excludes dependencies, generated files, declarations, framework and outside-project files before parsing', async () => {
  const invalid = 'not valid source @';
  const compile = createReactCompilerTransform('/fixture', true);
  for (const filename of ['/elsewhere/Card.jsx', '/fixture-other/Card.jsx', '/fixture/node_modules/widget/Card.jsx',
    '/fixture/.next/server/Card.js', '/fixture/.prnext/server/Card.js', '/fixture/.prnext-cache/Card.js',
    '/fixture/.prnext-build-123/Card.tsx', '/fixture/.prnext-incremental-stage/Card.tsx',
    '/fixture/.prnext-dev/Card.js', '/fixture/.prnext-types/Card.tsx', '/fixture/.contentlayer/generated/Card.js',
    '/fixture/out/Card.js', '/fixture/dist/Card.js', '/fixture/types.d.ts',
    '/fixture/types.d.mts', '/fixture/image.svg', '/fixture/Card.jsx?generated']) {
    assert.equal(await compile(invalid, filename), invalid, filename);
  }
  const frameworkFile = fileURLToPath(new URL('./dev.mjs', import.meta.url));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  assert.equal(await createReactCompilerTransform(repo, true)(invalid, frameworkFile), invalid);
  assert.match(await compile(component, '/fixture/my-node_modules-components/Card.jsx'), compiled, 'dependency filtering matches path segments, not unrelated names');
});

test('linked project roots compile canonical files while links outside and into dependencies remain excluded', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-react-compiler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actual = path.join(directory, 'actual'), linked = path.join(directory, 'linked'), outside = path.join(directory, 'outside');
  await mkdir(actual);await mkdir(outside);
  await writeFile(path.join(actual, 'Card.jsx'), component);await writeFile(path.join(outside, 'Card.jsx'), component);
  await mkdir(path.join(actual, 'node_modules/widget'), { recursive: true });
  await writeFile(path.join(actual, 'node_modules/widget/Card.jsx'), component);
  await symlink(actual, linked, 'junction');
  await symlink(outside, path.join(actual, 'external'), 'junction');
  await symlink(path.join(actual, 'node_modules/widget'), path.join(actual, 'dependency'), 'junction');
  const compile = createReactCompilerTransform(linked, true);
  assert.match(await compile(component, path.join(await realpath(actual), 'Card.jsx')), compiled);
  assert.match(await compile(component, path.join(linked, 'Card.jsx')), compiled);
  assert.equal(await compile(component, path.join(linked, 'external/Card.jsx')), component);
  assert.equal(await compile(component, path.join(linked, 'dependency/Card.jsx')), component);
});

test('explicit loader-produced JSX compiles MDX while retaining all source boundaries', async () => {
  const compile = createReactCompilerTransform('/fixture', true);
  const file = '/fixture/content/guide.mdx';
  assert.equal(await compile(component, file), component, 'raw MDX is not assumed to be JavaScript');
  assert.match(await compile(component, file, {loaderOutput:true}), compiled);
  for (const excluded of ['/elsewhere/guide.mdx', '/fixture/node_modules/docs/guide.mdx', '/fixture/.contentlayer/generated/guide.mdx', '/fixture/types.d.ts']) {
    assert.equal(await compile(component, excluded, {loaderOutput:true}), component, excluded);
  }
});

test('compiler cache keys distinguish configuration, build mode, source and source-map scopes', async () => {
  const file = '/fixture/cache-key-unique/Card.jsx';
  const compile = createReactCompilerTransform('/fixture', true);
  const before = transformCacheStats();
  const first = await compile(component, file);
  const afterFirst = transformCacheStats();
  assert.equal(afterFirst.misses, before.misses + 1);
  assert.equal(await compile(component, file), first);
  assert.equal(transformCacheStats().hits, afterFirst.hits + 1);
  assert.doesNotMatch(await createReactCompilerTransform('/fixture', { compilationMode: 'annotation' })(component, file), compiled);
  let previous = transformCacheStats().misses;
  await createReactCompilerTransform('/fixture', true, { dev: true })(component, file);
  assert.equal(transformCacheStats().misses, ++previous);
  await compile(component.replace('title}</p>', 'title + "!"}</p>'), file);
  assert.equal(transformCacheStats().misses, ++previous);
  await compile(component, file.replace('Card.jsx', 'Other.jsx'));
  assert.equal(transformCacheStats().misses, ++previous);
  await withSourceMaps(async () => {
    configureSourceMaps(true);
    assert.ok(extractSourceMap(await compile(component, file)).map);
  });
  assert.equal(transformCacheStats().misses, ++previous);
});

function locate(code, needle) {
  const position = code.indexOf(needle);assert.ok(position >= 0, needle);
  const lines = code.slice(0, position).split('\n');return [lines.length - 1, lines.at(-1).length];
}

test('compiler maps compose original loader coordinates through JSX lowering', async () => withSourceMaps(async () => {
  configureSourceMaps(true);
  const file = '/fixture/Mapped.tsx';
  const source = 'export function Card({title}:{title:string}){return <p>{title + "mapped-compiler-value"}</p>}';
  const input = inlineSourceMap(source, { version: 3, sources: ['/fixture/original.template'],
    sourcesContent: ['\n'.repeat(7) + 'original source'], names: [], mappings: 'AAOA' });
  const result = await createReactCompilerTransform('/fixture', true)(input, file);
  assert.match(result, compiled);
  const lowered = await transform(result, { loader: 'tsx', sourcefile: file, sourcemap: 'external', minify: true });
  const entry = new SourceMap(JSON.parse(lowered.map)).findEntry(...locate(lowered.code, 'mapped-compiler-value'));
  assert.equal(entry.originalSource, '/fixture/original.template');
  assert.equal(entry.originalLine, 7);
  assert.ok(JSON.parse(lowered.map).sourcesContent.includes('\n'.repeat(7) + 'original source'));
}));
