import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {copyStandaloneTrace} from './standalone-copy.mjs';

const file = size => ({dev: 1, ino: 2, size, mtimeMs: 1, ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false});
const root = path.resolve('standalone-copy-fixture');
const options = {tracingRoot: root, relocate: source => path.join(root, 'output', path.basename(source)), maxFiles: 100000, maxBytes: 2 * 1024 ** 3, concurrency: 4};
const inputs = count => Array.from({length: count}, (_, i) => path.join(root, 'source-' + i));

test('standalone copy overlaps bounded writes, creates each parent once and preserves alias order', async () => {
  const sources = inputs(12), writes = [], directories = [];
  let active = 0, peak = 0;
  const io = {lstat: async () => file(4), stat: async () => file(4), realpath: async p => p,
    mkdir: async p => {directories.push(p);}, copyFile: async (source, target) => {
      peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve));
      writes.push([source, target]); active--;
    }};
  const result = await copyStandaloneTrace(sources, options, io);
  assert.equal(result.copiedFiles, 12); assert.equal(result.copiedBytes, 48);
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(directories.length, 1);
  writes.length = 0;
  await copyStandaloneTrace(sources, {...options, relocate: () => path.join(root, 'output', 'alias')}, io);
  assert.deepEqual(writes.map(([source]) => source), sources);
});

test('standalone copy admits its whole byte/file/path plan before writing anything', async () => {
  let writes = 0;
  const io = {lstat: async () => file(4), stat: async () => file(4), realpath: async p => p,
    mkdir: async () => {writes++;}, copyFile: async () => {writes++;}};
  await assert.rejects(copyStandaloneTrace(inputs(2), {...options, maxBytes: 7}, io), /exceeds/);
  await assert.rejects(copyStandaloneTrace(inputs(2), {...options, maxFiles: 1}, io), /exceeds/);
  await assert.rejects(copyStandaloneTrace(inputs(2), {...options, relocate() {throw Error('outside tracing root');}}, io), /outside/);
  assert.equal(writes, 0);
});

test('standalone copy retains deferred links and skips only ancestor aliases into the tracing root', async () => {
  const ordinary = inputs(1)[0], link = path.join(root, 'link'), ancestor = path.resolve(root, '..', 'alias');
  const symbolic = {size: 3, isSymbolicLink: () => true, isFile: () => false};
  const writes = [];
  const io = {lstat: async source => source === ordinary ? file(4) : symbolic, stat: async () => file(4),
    realpath: async source => source === ancestor ? path.dirname(root) : ordinary, mkdir: async () => {}, copyFile: async source => {writes.push(source);}};
  const result = await copyStandaloneTrace([ordinary, link, ancestor], options, io);
  assert.deepEqual(writes, [ordinary]); assert.equal(result.copiedFiles, 2); assert.equal(result.copiedBytes, 7);
  assert.deepEqual(result.pendingLinks, [[options.relocate(link), options.relocate(ordinary)]]);
});

test('copy failure stops new admissions and waits for every already running writer', async () => {
  let release, settled = false, rejected = false;
  const gate = new Promise(resolve => {release = resolve;});
  const writes = [];
  const io = {lstat: async () => file(4), stat: async () => file(4), realpath: async p => p, mkdir: async () => {},
    copyFile: async source => {writes.push(source); if (source.endsWith('-0')) throw Error('copy failed'); await gate; settled = true;}};
  const result = copyStandaloneTrace(inputs(8), {...options, concurrency: 2}, io).catch(error => {rejected = true; throw error;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejected, false); assert.equal(writes.length, 2);
  release(); await assert.rejects(result, /copy failed/); assert.equal(settled, true); assert.equal(writes.length, 2);
});

test('source replacement or growth is rejected before or after the copy', async () => {
  for (const changeAt of [2, 3]) {
    let reads = 0, writes = 0;
    const io = {lstat: async () => file(++reads >= changeAt ? 8 : 4), stat: async () => file(4), realpath: async p => p,
      mkdir: async () => {}, copyFile: async () => {writes++;}};
    await assert.rejects(copyStandaloneTrace(inputs(1), options, io), /input changed/);
    assert.equal(writes, changeAt === 2 ? 0 : 1);
  }
});

test('real standalone file copies preserve bytes and independent outputs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-copy-trace-'));
  try {
    const source = path.join(directory, 'source'), output = path.join(directory, 'output');
    await mkdir(source); const files = [];
    for (let i = 0; i < 24; i++) {const p = path.join(source, 'file-' + i); files.push(p); await writeFile(p, Buffer.alloc(127 + i, i));}
    const result = await copyStandaloneTrace(files, {tracingRoot: directory, relocate: p => path.join(output, path.basename(p)), maxFiles: 100000, maxBytes: 2 * 1024 ** 3});
    assert.equal(result.copiedFiles, 24);
    for (const p of files) assert.deepEqual(await readFile(path.join(output, path.basename(p))), await readFile(p));
    await writeFile(files[0], 'later source mutation');
    assert.deepEqual(await readFile(path.join(output, path.basename(files[0]))), Buffer.alloc(127));
  } finally {
    assert.equal(path.dirname(await realpath(directory)), await realpath(tmpdir()));
    assert.ok(path.basename(directory).startsWith('prnext-copy-trace-'));
    await rm(directory, {recursive: true, force: true});
  }
});
