import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm, access, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateProjectConfig } from './config.mjs';
import { createStandalone } from './standalone.mjs';
import { build } from './index.mjs';
import { fileURLToPath } from 'node:url';

test('standalone configuration validates output, root and bounded route/file patterns', () => {
  assert.equal(validateProjectConfig({ output: 'standalone' }).output, 'standalone');
  assert.equal(validateProjectConfig({ output: 'export' }).output, 'export');
  for (const distDir of ['out', 'out/build']) assert.throws(() => validateProjectConfig({ output: 'export', distDir }), /reserves out/);
  for (const value of [false, 'invalid', {}, 1]) assert.throws(() => validateProjectConfig({ output: value }), /output/);
  assert.throws(() => validateProjectConfig({ outputFileTracingRoot: '../workspace' }), /absolute/);
  for (const value of [[], null, { '/api/*': 'file' }, { '/api': ['/etc/passwd'] }, { api: ['file'] }]) assert.throws(() => validateProjectConfig({ outputFileTracingIncludes: value }), /outputFileTracingIncludes/);
  assert.doesNotThrow(() => validateProjectConfig({ outputFileTracingIncludes: { '/api/\\[slug\\]': ['file'] } }));
});

test('tracing preserves workspace symlinks and conditional exports without copying unused package files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-trace-workspace-'));
  let deployed;
  const project = path.join(root, 'apps/site');
  const stage = path.join(project, '.rustyx-build-test');
  const put = async (file, value) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value); };
  try {
    await put('apps/site/package.json', '{"type":"module"}');
    await put('packages/widget/package.json', '{"name":"widget","type":"module","exports":{"react-server":"./rsc.mjs","default":"./node.mjs"}}');
    await put('packages/widget/node.mjs', 'export default "normal";');
    await put('packages/widget/rsc.mjs', 'export default "rsc";');
    await put('packages/widget/unused.txt', 'unused');
    await put('apps/site/.rustyx-build-test/runtime/worker.mjs', '');
    await put('apps/site/.rustyx-build-test/runtime/http.mjs', '');
    await put('apps/site/.rustyx-build-test/runtime/api.mjs', '');
    await put('apps/site/.rustyx-build-test/runtime/route-static.mjs', '');
    await put('apps/site/.rustyx-build-test/server/api.mjs', 'import value from "widget";console.log(value);');
    await put('apps/site/extra/include.txt', 'include');
    await put('apps/site/extra/exclude.txt', 'exclude');
    await mkdir(path.join(project, 'node_modules'), { recursive: true });
    await symlink('../../../packages/widget', path.join(project, 'node_modules/widget'));
    const config = validateProjectConfig({ output: 'standalone', outputFileTracingRoot: root,
      outputFileTracingIncludes: { '/api': ['extra/*.txt'] }, outputFileTracingExcludes: { '/api': ['extra/exclude.txt'] } });
    const manifest = { config: {}, routes: [{ pattern: '/api', module: 'server/api.mjs', kind: 'api' }] };
    await createStandalone({ projectRoot: project, stage, manifest, config });
    deployed = await mkdtemp(path.join(tmpdir(), 'rustyx-trace-moved-'));
    await cp(path.join(stage, 'standalone'), deployed, { recursive: true, verbatimSymlinks: true });
    await rm(root, { recursive: true, force: true });
    const entry = path.join(deployed, 'app/apps/site/.rustyx/server/api.mjs');
    const execute = promisify(execFile);
    assert.equal((await execute(process.execPath, [entry])).stdout.trim(), 'normal');
    assert.equal((await execute(process.execPath, ['--conditions=react-server', entry])).stdout.trim(), 'rsc');
    await assert.rejects(access(path.join(deployed, 'app/packages/widget/unused.txt')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(deployed, 'app/apps/site/extra/exclude.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(deployed, 'app/apps/site/extra/include.txt'), 'utf8'), 'include');
    assert.equal(path.isAbsolute(await readlink(path.join(deployed, 'app/apps/site/node_modules/widget'))), false);
  } finally { await rm(root, { recursive: true, force: true }); if (deployed) await rm(deployed, { recursive: true, force: true }); }
});

test('dependencies hoisted above a default tracing root are relocated and unknown external workspace files fail clearly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-trace-hoisted-'));
  const project = path.join(root, 'site');
  const stage = path.join(project, 'stage');
  const put = async (file, value) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value); };
  try {
    await put('site/package.json', '{}');
    await put('node_modules/hoisted/package.json', '{"name":"actual-npm-package-name","main":"index.cjs"}');
    await put('node_modules/hoisted/index.cjs', 'module.exports="hoisted";');
    await put('site/stage/runtime/worker.mjs', 'console.log(require("hoisted"))');
    await put('site/stage/runtime/http.mjs', '');
    const config = validateProjectConfig({ output: 'standalone' });
    await createStandalone({ projectRoot: project, stage, manifest: { config: {}, routes: [] }, config });
    const filename = path.join(stage, 'standalone/app/.rustyx/runtime/worker.mjs');
    // Only resolution is exercised here; the synthetic module uses CJS syntax.
    const script = `const {createRequire}=require('node:module');console.log(createRequire(${JSON.stringify(filename)})('hoisted'))`;
    assert.equal((await promisify(execFile)(process.execPath, ['-e', script])).stdout.trim(), 'hoisted');
    await rm(path.join(stage, 'standalone'), { recursive: true });
    await put('shared/data.json', '{}');
    await put('site/stage/runtime/worker.mjs', 'import data from "../../../shared/data.json" with {type:"json"};');
    await assert.rejects(createStandalone({ projectRoot: project, stage, manifest: { config: {}, routes: [] }, config }), /outside outputFileTracingRoot/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed standalone trace preserves the published build and output pointer', async () => {
  const root = await mkdtemp(path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.rustyx-standalone-atomic-'));
  try {
    await mkdir(path.join(root, 'pages'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'pages/index.jsx'), 'export default function Page(){return <h1>Previous build</h1>}');
    const previous = await build(root);
    const pointer = await readFile(path.join(root, '.rustyx-output.json'), 'utf8');
    await writeFile(path.join(root, 'rustyx.config.mjs'), `export default {output:'standalone',outputFileTracingIncludes:{'/*':['../outside.txt']}}`);
    await assert.rejects(build(root), /leaves outputFileTracingRoot/);
    assert.equal(JSON.parse(await readFile(path.join(previous.outputDirectory, 'manifest.json'), 'utf8')).buildId, previous.buildId);
    assert.equal(await readFile(path.join(root, '.rustyx-output.json'), 'utf8'), pointer);
  } finally { await rm(root, { recursive: true, force: true }); }
});
