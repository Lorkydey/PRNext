import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { optimizeImportsPlugins } from './optimize-imports.mjs';
import { validateProjectConfig } from './config.mjs';

test('package import optimization avoids traversing unused icons and preserves named aliases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-optimize-'));
  try {
    const pkg = path.join(root, 'node_modules/icons');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'icons', type: 'module', sideEffects: false, exports: { '.': { import: './index.js', require: './require.cjs' } } }));
    const imports = [], exports = [];
    for (let i = 0; i < 100; i++) {
      imports.push(`import {Icon as i${i}} from './icon${i}.js';`);
      exports.push(`i${i} as Icon${i}`);
      await writeFile(path.join(pkg, `icon${i}.js`), `export const Icon=${i};`);
    }
    await writeFile(path.join(pkg, 'index.js'), imports.join('') + `export {${exports.join(',')}};`);
    await writeFile(path.join(pkg, 'require.cjs'), 'throw new Error("wrong export condition");');
    await writeFile(path.join(root, 'entry.js'), `import {Icon42 as answer} from 'icons';export {answer};`);
    const plugins = [{ name: 'fixture', setup(builder) { builder.onLoad({ filter: /\.js$/, namespace: 'file' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'js' })); } }];
    const options = { absWorkingDir: root, entryPoints: ['entry.js'], bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', logLevel: 'silent' };
    const before = await build({ ...options, plugins });
    const after = await build({ ...options, plugins: optimizeImportsPlugins(plugins, ['icons']) });
    assert.equal(Object.keys(before.metafile.inputs).length, 102);
    assert.equal(Object.keys(after.metafile.inputs).length, 2);
    for (const output of [before, after]) assert.equal((await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'))).answer, 42);
    // A side-effectful barrel and a client boundary must retain normal semantics.
    for (const prefix of [`globalThis.__optimizeEffect=1;`, `'use client';`]) {
      await writeFile(path.join(pkg, 'index.js'), prefix + imports.join('') + `export {${exports.join(',')}};`);
      const unchanged = await build({ ...options, plugins: optimizeImportsPlugins(plugins, ['icons']) });
      assert.equal(Object.keys(unchanged.metafile.inputs).length, 102);
    }
    // Namespace imports need the full module object, including all names.
    await writeFile(path.join(pkg, 'index.js'), imports.join('') + `export {${exports.join(',')}};`);
    await writeFile(path.join(root, 'entry.js'), `import * as icons from 'icons';export const count=Object.keys(icons).length;`);
    const namespace = await build({ ...options, plugins: optimizeImportsPlugins(plugins, ['icons']) });
    assert.equal((await import('data:text/javascript;base64,' + Buffer.from(namespace.outputFiles[0].contents).toString('base64'))).count, 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('development indicator and optimized-package options are validated explicitly', () => {
  const config = validateProjectConfig({ devIndicators: false, experimental: { optimizePackageImports: ['@untitledui/icons', '@untitledui/icons'] } });
  assert.equal(config.devIndicators, false);
  assert.deepEqual(config.experimental.optimizePackageImports, ['@untitledui/icons']);
  for (const value of [true, null, {}, { position: 'bottom-left' }]) assert.throws(() => validateProjectConfig({ devIndicators: value }), /devIndicators/);
  for (const value of [null, 'icons', ['../icons'], ['icons/private'], [null], Array(257).fill('icons')]) assert.throws(() => validateProjectConfig({ experimental: { optimizePackageImports: value } }), /optimizePackageImports/);
});
