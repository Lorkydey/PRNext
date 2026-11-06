import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isMainModule } from './main-module.mjs';
import { prepareOutputPath } from './ci-shards.mjs';

export const qualificationNode = '26.13.0';
export const qualificationSuites = ['runtime', 'browser', 'reference', 'package'];
const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unitFiles = [
  'app-render', 'app-render-key', 'app-prewarm', 'app-stream', 'app-stream-channel',
  'cache-rsc', 'cache-request', 'cache-wire', 'cache-result', 'cache-components-rsc',
  'compile-cache', 'flight-delta', 'flight-diagnostics', 'rsc-flight-diagnostics', 'flight-tap', 'html-envelope',
  'html-envelope-fragmented', 'native-ppr', 'request-stream', 'worker-prewarm', 'profile',
].map(name => `packages/prnext/runtime/${name}.test.mjs`).concat([
  'packages/prnext/build/flight-summary.test.mjs',
  'packages/prnext/build/inspection-summary.test.mjs',
  'packages/prnext/build/source-analysis.test.mjs',
  'packages/prnext/build/source-summary.test.mjs',
  'packages/prnext/build/transform-cache.test.mjs',
  'packages/prnext/build/native-discovery.test.mjs',
]);
const integrationFiles = ['app', 'streaming', 'request-streaming', 'cache', 'worker-compile-cache', 'render-readiness', 'inspector'].map(name => `tests/${name}.test.mjs`);
const browserFiles = ['hydration', 'streaming', 'flight-delta', 'isr', 'partial', 'deployment-coherence'].map(name => `tests/browser/${name}.spec.mjs`);

export function qualificationPlan(suite) {
  if (!qualificationSuites.includes(suite)) throw new Error('Expected runtime, browser, reference or package suite.');
  if (suite === 'runtime') return [
    { name: 'runtime-contracts', args: ['--test', '--test-concurrency=1', ...unitFiles] },
    { name: 'http-integration', args: ['--test', '--test-concurrency=1', ...integrationFiles] },
  ];
  if (suite === 'browser') return [{ name: 'chromium-contracts', args: ['node_modules/@playwright/test/cli.js', 'test', ...browserFiles] }];
  if (suite === 'reference') return [{ name: 'independent-saas', args: ['tests/reference/run.mjs'] }];
  const native = `target/release/prnext${process.platform === 'win32' ? '.exe' : ''}`;
  return [
    { name: 'package-hoisted', args: ['scripts/test-package.mjs', '--out', 'artifacts/node26-qualification/package-archives', '--binary', native] },
    { name: 'package-nested', args: ['scripts/test-package.mjs', '--out', 'artifacts/node26-qualification/package-archives', '--binary', native, '--nested'] },
    { name: 'packaged-lifecycle', args: ['scripts/test-release-lifecycle.mjs', 'artifacts/node26-qualification/package-archives'] },
  ];
}

export function assertQualificationNode(version) {
  if (version !== `v${qualificationNode}`) throw new Error(`Qualification requires exact Node ${qualificationNode}; received ${version}.`);
}

export function parseQualificationArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--suite', '--output', '--list'].includes(flag) || Object.hasOwn(options, flag)) throw new Error('Unknown or duplicate qualification argument.');
    options[flag] = flag === '--list' ? true : argv[++i];
    if (!options[flag] || String(options[flag]).startsWith('--')) throw new Error('Missing qualification argument.');
  }
  qualificationPlan(options['--suite']);
  if (!options['--list'] && !options['--output']) throw new Error('A fresh --output receipt is required.');
  if (options['--list'] && options['--output']) throw new Error('--list does not write qualification receipts.');
  return { suite: options['--suite'], output: options['--output'], list: options['--list'] === true };
}

export async function verifyQualificationFiles(suite, directory = root) {
  const files = qualificationPlan(suite).flatMap(step => step.args.filter(value => /\.(?:mjs|js)$/.test(value)));
  const hashes = {};
  for (const file of files) hashes[file] = hash(await readFile(path.join(directory, file)));
  return hashes;
}

async function runStep(step) {
  const child = spawn(process.execPath, step.args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

export async function cleanQualificationSource(directory = root) {
  const result = await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: directory, timeout: 10000 });
  assert.equal(result.stdout.trim(), '', 'Commit the candidate before producing a Node qualification receipt.');
  const source = (await execute('git', ['rev-parse', 'HEAD'], { cwd: directory, timeout: 10000 })).stdout.trim();
  assert.match(source, /^[a-f0-9]{40}$/);
  return source;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseQualificationArgs(argv), commands = qualificationPlan(options.suite);
  if (options.list) { console.log(JSON.stringify({ node: qualificationNode, suite: options.suite, commands }, null, 2)); return; }
  assertQualificationNode(process.version);
  const output = await prepareOutputPath(root, options.output);
  const native = path.join(root, 'target/release', process.platform === 'win32' ? 'prnext.exe' : 'prnext');
  const files = await verifyQualificationFiles(options.suite);
  const source = await cleanQualificationSource();
  const receipt = { version: 1, complete: false, passed: false, source, suite: options.suite,
    harnessSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    node: process.version, nodeSha256: hash(await readFile(process.execPath)), platform: process.platform, arch: process.arch,
    binarySha256: hash(await readFile(native)), lockSha256: hash(await readFile(path.join(root, 'package-lock.json'))),
    files, commands: [], startedAt: new Date().toISOString(),
    limits: ['Functional qualification, not a performance or endurance result.', 'Browser coverage is Chromium on this Node host; other engines/platforms retain the existing CI coverage.', 'No production Node default is changed.'] };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const persist = () => writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  try {
    for (const step of commands) {
      const row = { ...step, startedAt: new Date().toISOString(), passed: false };
      receipt.commands.push(row); await persist();
      Object.assign(row, await runStep(step), { endedAt: new Date().toISOString() });
      row.passed = row.code === 0 && row.signal === null; await persist();
      if (!row.passed) throw new Error(`Node26 qualification command failed: ${step.name}.`);
    }
    assert.deepEqual(await verifyQualificationFiles(options.suite), files);
    assert.equal(hash(await readFile(native)), receipt.binarySha256);
    assert.equal(hash(await readFile(path.join(root, 'package-lock.json'))), receipt.lockSha256);
    assert.equal(hash(await readFile(process.execPath)), receipt.nodeSha256);
    assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), receipt.harnessSha256);
    assert.equal(await cleanQualificationSource(), source);
    receipt.complete = receipt.passed = true;
  } catch (error) {
    receipt.failure = { name: error.name, message: String(error.message).slice(0, 1000) }; throw error;
  } finally { receipt.endedAt = new Date().toISOString(); await persist(); }
}

if (isMainModule(import.meta.url)) await main();
