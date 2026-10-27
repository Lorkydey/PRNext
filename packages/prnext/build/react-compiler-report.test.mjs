import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReactCompilerTransform, REACT_COMPILER_VERSION } from './react-compiler.mjs';
import { withCompilation, configureCompiler } from './compiler.mjs';
import { compilerEvent, configureReactCompilerReporting, printReactCompilerReport, reactCompilerReport,
  readReactCompilerReport, recordReactCompilerGraph, recordReactCompilerTransform, withReactCompilerGraph,
  withReactCompilerReporting, writeReactCompilerReport, REACT_COMPILER_REPORT_FILE } from './react-compiler-report.mjs';

const exec = promisify(execFile), root = path.resolve('/compiler-report-fixture');
const source = 'export function Card({title}){return <p>{title}</p>}';
function scope(run, { config = true, buildId = 'test-build', dev = false, project = root } = {}) {
  return withCompilation(async () => {
    configureCompiler({ root: project, config: { reactCompiler: config }, buildId, dev });
    await run(createReactCompilerTransform(project, config), project);
    return reactCompilerReport();
  });
}
const file = name => path.join(root, name + '.jsx');

test('actual compiler events identify optimized, opted-out and invalid functions without retaining source', async () => {
  const report = await scope(async compile => {
    await withReactCompilerGraph('browser', () => compile(source + '\n// SOURCE_SECRET_DO_NOT_SERIALIZE', file('actual')));
    await compile(source.replace('{return', '{"use no memo";return'), file('function-opt-out'));
    await compile('"use no memo";\n' + source, file('module-opt-out'));
    await compile("import{useState}from'react';export function Broken({flag}){if(flag){useState(0)}return <p/>}", file('invalid'));
  });
  assert.equal(report.enabled, true); assert.equal(report.compilerVersion, '1.0.0');
  assert.deepEqual(report.options, { compilationMode: 'infer', panicThreshold: 'none', target: '19' });
  assert.equal(report.summary.optimized, 1); assert.equal(report.summary.skipped, 2); assert.equal(report.summary.errors, 1);
  const card = report.files.find(item => item.file === 'actual.jsx').functions[0];
  assert.equal(card.name, 'Card'); assert.deepEqual(card.start, { line: 1, column: 7 });
  assert.deepEqual(card.targets, ['browser']); assert.equal(card.events[0].memoSlots, 2);
  const module = report.files.find(item => item.file === 'module-opt-out.jsx').functions[0];
  assert.equal(module.events[0].kind, 'CompileSuccess', 'preserve the actual upstream event');
  assert.equal(module.status, 'skipped', 'a successful analysis is not emitted optimization when the module opts out');
  assert.match(module.events[0].reason, /Module uses/);
  assert.equal(report.files.find(item => item.file === 'function-opt-out.jsx').functions[0].name, 'Card', 'body-only skip event maps to its containing function');
  const error = report.files.find(item => item.file === 'invalid.jsx').functions[0];
  assert.equal(error.name, 'Broken'); assert.equal(error.events[0].category, 'Hooks');
  assert.match(error.events[0].reason, /consistent order/);
  assert.doesNotMatch(JSON.stringify(report), /SOURCE_SECRET|sourcesContent|compiler-runtime|[A-Za-z]:\\|<p>/);
});

test('cached results preserve real decisions across builds and graphs without inflating function counts', async () => {
  const filename = file('cached'), first = await scope(compile => withReactCompilerGraph('browser', () => compile(source, filename)));
  const second = await scope(async compile => {
    await withReactCompilerGraph('browser', () => compile(source, filename));
    await withReactCompilerGraph('node', () => compile(source, filename));
    await withReactCompilerGraph('edge', () => compile(source, filename));
  }, { buildId: 'next-build' });
  assert.equal(first.summary.cacheReuses, 0);
  assert.equal(second.summary.cacheReuses, 3); assert.equal(second.summary.transforms, 3);
  assert.equal(second.summary.functions, 1); assert.equal(second.summary.optimized, 1);
  assert.equal(second.buildId, 'next-build');
  assert.deepEqual(second.files[0].functions[0].targets, ['browser', 'edge', 'node']);
  assert.deepEqual(second.files[0].functions[0].events, first.files[0].functions[0].events.map(event => ({ ...event, targets: ['browser', 'edge', 'node'] })));
  assert.equal(reactCompilerReport(), null, 'build collectors never escape their async scope');
});

test('annotation/off/source changes report this generation rather than a previous optimization', async () => {
  const filename = file('config');
  assert.equal((await scope(compile => compile(source, filename))).summary.optimized, 1);
  const annotation = await scope(compile => compile(source, filename), { config: { compilationMode: 'annotation' } });
  assert.equal(annotation.summary.functions, 0); assert.equal(annotation.summary.optimized, 0);
  assert.match(annotation.files[0].notes[0], /only selects functions with "use memo"/);
  const disabled = await scope(compile => compile('this is not valid source', filename), { config: false });
  assert.equal(disabled.enabled, false); assert.equal(disabled.options, null); assert.deepEqual(disabled.files, []);
  const changed = await scope(compile => compile(source.replace('{return', '{"use no memo";return'), filename));
  assert.equal(changed.summary.optimized, 0); assert.equal(changed.summary.skipped, 1);
  const reenabled = await scope(compile => compile(source, filename));
  assert.equal(reenabled.summary.optimized, 1); assert.equal(reenabled.summary.cacheReuses, 1);
});

test('overlapping and failed build collectors stay isolated', async () => {
  const values = await Promise.all([
    scope(async compile => { await new Promise(resolve => setTimeout(resolve, 15)); await compile(source, file('parallel-a')); }, { buildId: 'a' }),
    scope(compile => compile(source.replace('Card', 'Other'), file('parallel-b')), { buildId: 'b', dev: true }),
  ]);
  assert.deepEqual(values.map(report => [report.buildId, report.mode, report.files[0].functions[0].name]),
    [['a', 'production', 'Card'], ['b', 'development', 'Other']]);
  await assert.rejects(scope(async compile => { await compile(source, file('failed')); throw new Error('unrelated failed graph'); }), /failed graph/);
  assert.equal((await scope(() => {})).files.length, 0, 'a failed generation cannot populate the next report');
});

test('graph coverage explicitly distinguishes observed transforms from unobserved reused inputs', async () => {
  const report = await scope(compile => withReactCompilerGraph('browser', async () => {
    await compile(source, file('coverage'));
    recordReactCompilerGraph({ metafile: { inputs: { 'coverage.jsx': {}, 'cached-without-callback.jsx': {}, 'node_modules/lib/a.js': {}, '.prnext-build-a/entry.js': {} } } });
  }));
  assert.equal(report.scope, 'observed-transforms');
  assert.deepEqual(report.graphs, [{ target: 'browser', metadataAvailable: true, projectJavaScriptInputs: 2, observedFiles: 1, unobservedInputs: 1 }]);
  const lines = []; printReactCompilerReport(report, { details: true, log: line => lines.push(line) });
  assert.match(lines.join('\n'), /not observed/); assert.match(lines.join('\n'), /Card:1: optimized/);
});

test('loader output locations are identified and excluded server/generated modules never inflate totals', async () => {
  const report = await scope(async compile => {
    await compile(source, path.join(root, 'guide.mdx'), { loaderOutput: true });
    await compile('"use server";\n' + source, file('actions'));
    await compile(source, path.join(root, 'node_modules', 'lib', 'Card.jsx'));
  });
  assert.equal(report.summary.optimized, 1); assert.equal(report.summary.files, 2);
  assert.match(report.files.find(value => value.file === 'guide.mdx').notes[0], /configured loader/);
  assert.deepEqual(report.files.find(value => value.file === 'actions.jsx').functions, []);
});

test('mixed graph outcomes are visible instead of claiming every target was optimized', async () => {
  const report = await scope(async compile => {
    await withReactCompilerGraph('browser', () => compile(source, file('mixed')));
    await withReactCompilerGraph('edge', () => compile(source.replace('{return', '{"use no memo";return'), file('mixed')));
  });
  assert.equal(report.summary.functions, 1); assert.equal(report.summary.optimized, 0); assert.equal(report.summary.mixed, 1);
  assert.equal(report.files[0].functions[0].events.length, 2);
  assert.deepEqual(report.files[0].functions[0].events.map(event => [event.status, event.targets]), [['optimized', ['browser']], ['skipped', ['edge']]]);
});

test('persistent cache replays compiler metadata in a genuinely fresh Node process', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-compiler-report-disk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), '{}');
  await writeFile(path.join(directory, 'Card.jsx'), source);
  const code = `import {createReactCompilerTransform} from ${JSON.stringify(new URL('./react-compiler.mjs', import.meta.url).href)};
    import {withPersistentTransforms,transformCacheStats} from ${JSON.stringify(new URL('./transform-cache.mjs', import.meta.url).href)};
    import {withCompilation,configureCompiler,reactCompilerReport} from ${JSON.stringify(new URL('./compiler.mjs', import.meta.url).href)};
    const root=${JSON.stringify(directory)};const report=await withPersistentTransforms(root,{},()=>withCompilation(async()=>{
      configureCompiler({root,config:{reactCompiler:true},buildId:'disk'});await createReactCompilerTransform(root,true)(${JSON.stringify(source)},${JSON.stringify(path.join(directory, 'Card.jsx'))});return reactCompilerReport();
    }));console.log(JSON.stringify({report,stats:transformCacheStats()}));`;
  const invoke = async () => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true,
    env: { ...process.env, PRNEXT_BUILD_CACHE: '1' }, maxBuffer: 1024 * 1024 })).stdout);
  const first = await invoke(), second = await invoke();
  assert.equal(first.report.summary.cacheReuses, 0); assert.equal(second.stats.diskHits, 1);
  assert.equal(second.report.summary.cacheReuses, 1); assert.equal(second.report.summary.optimized, 1);
  assert.deepEqual(second.report.files[0].functions, first.report.files[0].functions);
});

test('the report reader rejects stale, malformed, path escaping and terminal-control artifacts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-compiler-report-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readReactCompilerReport(directory), null);
  const report = await scope(compile => compile(source, file('reader')));
  await writeReactCompilerReport(directory, report);
  assert.deepEqual(await readReactCompilerReport(directory, { buildId: 'test-build' }), report);
  await assert.rejects(readReactCompilerReport(directory, { buildId: 'other' }), /stale/);
  const mutations = [
    value => value.files[0].file = '../outside.jsx', value => value.files[0].file = 'C:/private/Card.jsx',
    value => value.files[0].functions[0].name = '\u001b[31munsafe', value => value.summary.optimized = 999,
    value => value.files[0].functions[0].events[0].source = 'source code must not be accepted',
    value => value.options = { logger: 'unsafe' }, value => value.files[0].cacheReuses = 999,
    value => value.files[0] = null,
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(report); mutate(invalid);
    await writeFile(path.join(directory, REACT_COMPILER_REPORT_FILE), JSON.stringify(invalid));
    await assert.rejects(readReactCompilerReport(directory), /Invalid/);
  }
  await writeFile(path.join(directory, REACT_COMPILER_REPORT_FILE), '{not json');
  await assert.rejects(readReactCompilerReport(directory), /JSON/);
  const handle = await open(path.join(directory, REACT_COMPILER_REPORT_FILE), 'w');
  try { await handle.truncate(8 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(readReactCompilerReport(directory), /size limit/);
});

test('event capture scrubs paths and ignores arbitrary pipeline stacks and timing payloads', () => {
  const event = compilerEvent({ kind: 'CompileError', detail: { options: { category: 'Hooks', reason: 'Failure in C:\\private\\secret.jsx\n' + '/private/project/secret.jsx', source: 'SECRET' } } }, [], { root });
  assert.doesNotMatch(JSON.stringify(event), /private|SECRET|\\n/);
  assert.equal(compilerEvent({ kind: 'PipelineError', data: 'SECRET\nC:\\private\\stack' }, []).reason, 'React Compiler could not complete this function.');
  assert.equal(compilerEvent({ kind: 'Timing', duration: 10, data: 'SECRET' }, []), null);
});

test('collectors cap large event streams and diagnostics remain optional for huge applications', async t => {
  const report = withReactCompilerReporting(() => {
    configureReactCompilerReporting({ root, config: { reactCompiler: true }, buildId: 'bounded', compilerVersion: REACT_COMPILER_VERSION });
    for (let i = 0; i < 1100; i++) recordReactCompilerTransform(file('bounded-' + i), { events: [], notes: [] });
    return reactCompilerReport();
  });
  assert.equal(report.truncated, true); assert.equal(report.files.length, 1024);
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-compiler-report-bounded-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const written = await writeReactCompilerReport(directory, report);
  assert.equal((await readReactCompilerReport(directory)).summary.files, written.summary.files);
  assert.ok((await readFile(path.join(directory, REACT_COMPILER_REPORT_FILE))).length < 8 * 1024 * 1024);
  const oversized = structuredClone(report);
  for (const item of oversized.files) item.notes = ['x'.repeat(10 * 1024)];
  const compact = await writeReactCompilerReport(directory, oversized);
  assert.ok(compact.files.length < oversized.files.length); assert.equal(compact.truncated, true);
  assert.equal(oversized.files.length, 1024, 'writer does not mutate the collector snapshot');
});

test('large graph input sets are capped and coverage explicitly becomes partial', async () => {
  const report = await scope(() => withReactCompilerGraph('browser', () => {
    recordReactCompilerGraph({ metafile: { inputs: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['component-' + i + '.jsx', {}])) } });
  }));
  assert.equal(report.truncated, true); assert.equal(report.graphs[0].metadataAvailable, false);
  assert.equal(report.graphs[0].projectJavaScriptInputs, 4096);
});

test('the official legacy opt-out alias is reported as skipped rather than optimized', async () => {
  const report = await scope(async compile => {
    await compile('"use no forget";\n' + source, file('legacy-module-opt-out'));
    await compile(source.replace('{return', '{"use no forget";return'), file('legacy-function-opt-out'));
  });
  assert.equal(report.summary.skipped, 2); assert.equal(report.summary.optimized, 0);
  assert.ok(report.files.every(value => value.functions[0].events[0].reason.includes('use no forget')));
});
