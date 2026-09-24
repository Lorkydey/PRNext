import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expandActionExports } from './action-exports.mjs';
import { createServerActions } from './actions.mjs';

test('wildcard actions resolve cycles, aliases, default exclusion and ambiguous ESM names without evaluating code', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-action-exports-'));
  const source = `'use server';export * from './a.js';export * from './b.js';export {one as explicit} from './a.js';`;
  try {
    await writeFile(path.join(root, 'index.js'), source);
    await writeFile(path.join(root, 'a.js'), `throw Error('do not execute at compile time');export async function one(){};export async function collision(){};export default async function hidden(){};export * from './index.js';`);
    await writeFile(path.join(root, 'b.js'), `export async function two(){};export async function collision(){};export {one as shared} from './a.js'`);
    const expanded = await expandActionExports(source, path.join(root, 'index.js'), (name, importer) => path.resolve(path.dirname(importer), name));
    const actions = createServerActions({ projectRoot: root });
    const proxy = actions.transform(expanded, path.join(root, 'index.js'), 'browser');
    assert.match(proxy, /as "one"/); assert.match(proxy, /as "two"/); assert.match(proxy, /as "explicit"/); assert.match(proxy, /as "shared"/);
    assert.doesNotMatch(proxy, /collision|hidden|do not execute/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wildcard actions reject non-async exports and unresolved external graphs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-action-exports-invalid-'));
  try {
    const filename = path.join(root, 'actions.js');
    const source = `'use server';export * from './data.js';`;
    await writeFile(path.join(root, 'data.js'), `export const secret='never export a value';`);
    await assert.rejects(expandActionExports(source, filename, (name, importer) => path.resolve(path.dirname(importer), name)), /must be an async function/);
    await assert.rejects(expandActionExports(source, filename, () => undefined), /Cannot enumerate/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wildcard action resolution stays bounded on a diamond DAG with billions of paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-action-exports-dag-'));
  try {
    const layers = 32;
    const files = [['index.mjs', `'use server';export * from './0-a.mjs';export * from './0-b.mjs';`], ['leaf.mjs', 'export async function shared() {}']];
    for (let layer = 0; layer < layers; layer++) for (const branch of ['a', 'b']) {
      const source = layer === layers - 1 ? `export * from './leaf.mjs';`
        : `export * from './${layer + 1}-a.mjs';export * from './${layer + 1}-b.mjs';`;
      files.push([`${layer}-${branch}.mjs`, source]);
    }
    await Promise.all(files.map(([name, source]) => writeFile(path.join(root, name), source)));
    // An isolated deadline can interrupt synchronous exponential recursion; a
    // node:test timeout in this process cannot. Also compare the native binding.
    const script = `
      import assert from 'node:assert/strict';
      import { readFile, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { expandActionExports } from ${JSON.stringify(new URL('./action-exports.mjs', import.meta.url).href)};
      const root = ${JSON.stringify(root)}, filename = path.join(root, 'index.mjs');
      const expanded = await expandActionExports(await readFile(filename, 'utf8'), filename, (name, importer) => path.resolve(path.dirname(importer), name));
      const output = path.join(root, 'expanded.mjs');
      await writeFile(output, expanded);
      const native = await import(pathToFileURL(filename));
      const actual = await import(pathToFileURL(output));
      assert.deepEqual(Object.keys(actual), Object.keys(native));
      assert.equal(actual.shared, native.shared);
      process.stdout.write(JSON.stringify(Object.keys(actual)));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout), ['shared']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wildcard action cycles and shared aliases match native ESM resolution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rustyx-action-exports-native-'));
  try {
    const source = `'use server';export * from './left.mjs';export * from './right.mjs';export * from './cycle.mjs';export {collision as explicit} from './leaf.mjs';`;
    const files = {
      'index.mjs': source,
      'leaf.mjs': `export async function shared() {} export {shared as alias};export async function collision() {} export default async function hidden() {}`,
      'left.mjs': `export * from './cycle.mjs';export * from './leaf.mjs';`,
      'right.mjs': `export {shared, alias} from './leaf.mjs';export async function collision() {}`,
      'cycle.mjs': `export * from './index.mjs';export async function cycle() {}`,
    };
    await Promise.all(Object.entries(files).map(([name, value]) => writeFile(path.join(root, name), value)));
    const filename = path.join(root, 'index.mjs'), output = path.join(root, 'expanded.mjs');
    await writeFile(output, await expandActionExports(source, filename, (name, importer) => path.resolve(path.dirname(importer), name)));
    const native = await import(pathToFileURL(filename)), actual = await import(pathToFileURL(output));
    assert.deepEqual(Object.keys(actual), ['alias', 'cycle', 'explicit', 'shared']);
    assert.deepEqual(Object.keys(actual), Object.keys(native));
    for (const name of Object.keys(native)) assert.equal(actual[name], native[name], name);
    assert.equal(actual.alias, actual.shared);
  } finally { await rm(root, { recursive: true, force: true }); }
});
