import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { validateProjectConfig } from './config.mjs';
import { checkTypeScript, projectTsconfig } from './typescript.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(files, run) {
  const root = await mkdtemp(path.join(repo, '.prnext-typescript-test-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{}');
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), contents);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['source.ts'] });

test('compiler options reject unsupported transforms and route typing accepts booleans', () => {
  const config = validateProjectConfig({ reactCompiler: false, typedRoutes: false, typescript: {} });
  assert.deepEqual(config.typescript, { ignoreBuildErrors: false, tsconfigPath: 'tsconfig.json' });
  for (const value of [true, {}, { compilationMode: 'annotation' }, null, 'false']) {
    assert.throws(() => validateProjectConfig({ reactCompiler: value }), /React Compiler transform/);
    if(value!==true)assert.throws(() => validateProjectConfig({ typedRoutes: value }), /typedRoutes must be a boolean/);
  }
  assert.equal(validateProjectConfig({typedRoutes:true}).typedRoutes,true);
  for (const value of [true, null, [], { unknown: true }, { ignoreBuildErrors: 'true' }, { tsconfigPath: '' }, { tsconfigPath: null }]) {
    assert.throws(() => validateProjectConfig({ typescript: value }), /typescript/);
  }
});

test('production type checking rejects errors, honors explicit opt-out and emits no files', async () => {
  await fixture({ 'tsconfig.json': tsconfig, 'source.ts': 'const count: number = "wrong";' }, async root => {
    await assert.rejects(checkTypeScript(root, { typescript: {} }), /source.ts\(1,7\).*TS2322/);
    await checkTypeScript(root, { typescript: { ignoreBuildErrors: true } });
    await checkTypeScript(root, { typescript: {} }, { dev: true });
    await checkTypeScript(root, {});
    await writeFile(path.join(root, 'source.ts'), 'const count: number = 1;');
    await checkTypeScript(root, { typescript: {} });
    assert.deepEqual((await readdir(root)).sort(), ['package.json', 'source.ts', 'tsconfig.json']);
    assert.equal(await readFile(path.join(root, 'tsconfig.json'), 'utf8'), tsconfig);
  });
});

test('custom config paths and extends are used by both the checker and production bundles', async () => {
  await fixture({
    'next.config.mjs': 'export default {reactCompiler:false,typedRoutes:false,typescript:{tsconfigPath:"tsconfig.build.json"}}',
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@value': ['./wrong.ts'] } }, files: ['broken.ts'] }),
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', skipLibCheck: true, baseUrl: '.', paths: { '@value': ['./value.ts'] } } }),
    'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.base.json', include: ['pages/api/**/*.ts', 'value.ts'] }),
    'value.ts': 'export const value: string = "custom-config-value";',
    'wrong.ts': 'export const value = "wrong-config-value";',
    'broken.ts': 'const bad: number = "type-error-in-excluded-file";',
    'pages/api/value.ts': 'import {value} from "@value"; export default function handler(_request: unknown, response: {json: (input: unknown) => void}) {response.json({value})}',
  }, async root => {
    const result = await build(root);
    const file = path.join(result.outputDirectory, result.routes.find(route => route.pattern === '/api/value').module);
    assert.match(await readFile(file, 'utf8'), /custom-config-value/);
    assert.doesNotMatch(await readFile(file, 'utf8'), /wrong-config-value/);
    // A plugin forces the webpack graph bridge, whose resolver must receive
    // the same custom configuration as the default esbuild graph.
    await writeFile(path.join(root, 'next.config.mjs'), 'export default {typescript:{tsconfigPath:"tsconfig.build.json"},webpack(config){config.plugins.push({apply(){}});return config}}');
    const webpackResult = await build(root);
    const webpackFile = path.join(webpackResult.outputDirectory, webpackResult.routes.find(route => route.pattern === '/api/value').module);
    assert.match(await readFile(webpackFile, 'utf8'), /custom-config-value/);
    const manifest = await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8');
    await writeFile(path.join(root, 'value.ts'), 'export const value: string = 12;');
    await assert.rejects(build(root), /TypeScript check failed.*tsconfig.build.json[\s\S]*TS2322/);
    assert.equal(await readFile(path.join(result.outputDirectory, 'manifest.json'), 'utf8'), manifest);
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.prnext-build-')), []);
    await writeFile(path.join(root, 'next.config.mjs'), 'export default {typescript:{tsconfigPath:"tsconfig.build.json",ignoreBuildErrors:true}}');
    await build(root);
  });
});

test('missing custom TypeScript configs fail even when checking is disabled', async () => {
  await fixture({}, async root => {
    assert.equal(await projectTsconfig(root, {}), undefined);
    await assert.rejects(checkTypeScript(root, { typescript: {} }), /explicitly enabled, but tsconfig.json does not exist/);
    await checkTypeScript(root, {});
    await checkTypeScript(root, { typescript: { ignoreBuildErrors: true } });
    await assert.rejects(projectTsconfig(root, { typescript: { tsconfigPath: 'missing.json', ignoreBuildErrors: true } }), /typescript.tsconfigPath does not exist/);
  });
});
