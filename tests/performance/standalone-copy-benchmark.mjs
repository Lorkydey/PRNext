// Opt-in filesystem microbenchmark. It never builds/runs an application.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, lstat, copyFile, readdir, realpath, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyStandaloneTrace} from '../../packages/prnext/build/standalone-copy.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
async function snapshot(directory) {
  const result = [];
  async function walk(relative = '') {
    for (const entry of (await readdir(path.join(directory, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {assert.ok(entry.isFile()); result.push([file, sha(await readFile(path.join(directory, file)))]);}
    }
  }
  await walk(); return sha(JSON.stringify(result));
}

export async function benchmarkStandaloneCopy(output) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-standalone-copy-bench-'));
  const rows = [];
  try {
    const source = path.join(root, 'source'); await mkdir(source);
    const files = [];
    for (let i = 0; i < 512; i++) {
      const file = path.join(source, 'group-' + (i % 16), 'file-' + i);
      await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, Buffer.alloc(4096 + i % 64, i % 251)); files.push(file);
    }
    const expected = await snapshot(source);
    for (let round = 0; round < 4; round++) for (const variant of round % 2 ? ['parallel', 'serial'] : ['serial', 'parallel']) {
      const destination = path.join(root, variant + '-' + round); await mkdir(destination);
      const relocate = file => path.join(destination, path.relative(source, file));
      const started = performance.now();
      if (variant === 'serial') {
        // Exact old regular-file materialization loop, not the new helper with
        // concurrency=1 (which also adds source-change validation).
        for (const file of files) {const info = await lstat(file); assert.ok(info.isFile()); const target = relocate(file); await mkdir(path.dirname(target), {recursive: true}); await copyFile(file, target);}
      } else await copyStandaloneTrace(files, {tracingRoot: root, relocate, maxFiles: 100000, maxBytes: 2 * 1024 ** 3});
      rows.push({round, variant, milliseconds: performance.now() - started, outputSha256: await snapshot(destination)});
      assert.equal(rows.at(-1).outputSha256, expected);
    }
    const median = values => {const sorted = [...values].sort((a, b) => a - b); return (sorted[1] + sorted[2]) / 2;};
    const serial = median(rows.filter(row => row.variant === 'serial').map(row => row.milliseconds));
    const parallel = median(rows.filter(row => row.variant === 'parallel').map(row => row.milliseconds));
    const report = {version: 1, complete: true, node: process.version, platform: process.platform, arch: process.arch,
      sourcePins: {benchmark: sha(await readFile(fileURLToPath(import.meta.url))), copyHelper: sha(await readFile(new URL('../../packages/prnext/build/standalone-copy.mjs', import.meta.url)))},
      files: files.length, bytes: 512 * 4096 + 512 / 64 * 63 * 64 / 2, concurrency: 8, rows,
      serialMedianMilliseconds: serial, parallelMedianMilliseconds: parallel, changePercent: (parallel / serial - 1) * 100,
      allOutputsByteIdentical: true, limitations: ['Warm OS/filesystem-cache microbenchmark, four alternating pairs; no application, whole-build, physical-cold-disk or CI significance claim.', 'The candidate adds source-change checks; serial is the old regular-file copy loop. Other filesystem activity is uncontrolled.']};
    await mkdir(path.dirname(output), {recursive: true}); await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'}); return report;
  } finally {
    assert.equal(path.dirname(await realpath(root)), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith('prnext-standalone-copy-bench-'));
    await rm(root, {recursive: true, force: true});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 5 || process.argv[2] !== '--run' || process.argv[3] !== '--output') console.log('Opt-in: node tests/performance/standalone-copy-benchmark.mjs --run --output <new-report.json>');
  else console.log(JSON.stringify(await benchmarkStandaloneCopy(path.resolve(process.argv[4]))));
}
