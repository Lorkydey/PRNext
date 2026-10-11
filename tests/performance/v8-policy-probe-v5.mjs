// Diagnostic only. Run in a quiet, authorized window, never during HTTP measurements.
// No application build, HTTP request, GC forcing, or old-generation limit is used.
// --print-flag-values runs after V8's implication resolution (Node v24.19.0).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { Worker, isMainThread, parentPort, resourceLimits, threadId, workerData } from 'node:worker_threads';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '../..');
const marker = 'PRNEXT_V8_POLICY_RESULT ';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const variants = [
  { name: 'size-8', flags: ['--optimize-for-size', '--max-semi-space-size=8'] },
  { name: 'no-size-8', flags: ['--max-semi-space-size=8'] },
  { name: 'no-size-4', flags: ['--max-semi-space-size=4'] },
  { name: 'no-size-2', flags: ['--max-semi-space-size=2'] },
];

function snapshot(phase) {
  return {
    phase, unixMs: Date.now(), pid: process.pid, threadId, isMainThread,
    node: process.version, v8: process.versions.v8,
    execArgv: process.execArgv, resourceLimits,
    cachedDataVersionTag: v8.cachedDataVersionTag(),
    heap: v8.getHeapStatistics(), spaces: v8.getHeapSpaceStatistics(),
    code: v8.getHeapCodeStatistics(),
  };
}

async function observe(rounds) {
  const samples = [snapshot('startup')];
  // Optional finite nursery exercise, with at most four batches held at once.
  // Current space_size is committed capacity, not an API for the configured max.
  const retained = [];
  let checksum = 0;
  for (let round = 0; round < rounds; round++) {
    const batch = Array.from({ length: 16384 }, (_, i) => ({ i, round, a: i + 1, b: i + 2, c: i + 3 }));
    retained[round % 4] = batch;
    checksum += batch[(round * 17) % batch.length].a;
    samples.push(snapshot('allocation-' + (round + 1)));
    await new Promise(resolve => setImmediate(resolve));
  }
  samples.push(snapshot('finished'));
  return { samples, checksum, allocationRounds: rounds, retainedBatches: retained.length };
}

async function inspectChild() {
  const profilePath = path.join(root, 'packages/prnext/runtime/profiles.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8')).balanced;
  const rounds = Number(process.argv[3] ?? 0);
  assert(Number.isSafeInteger(rounds) && rounds >= 0 && rounds <= 32, 'Allocation rounds must be 0..32');
  assert.equal(process.version, 'v24.19.0', 'Use the exact isolated Node binary');
  const main = await observe(rounds);
  const requestedLimits = { maxYoungGenerationSizeMb: profile.youngGenerationMiB };
  const worker = new Worker(new URL(import.meta.url), {
    // Match app-render.mjs, deliberately not copying the host's V8 execArgv.
    execArgv: ['--conditions=react-server'],
    resourceLimits: requestedLimits,
    env: { ...process.env, NODE_ENV: 'production', PRNEXT_PROFILE: 'balanced' },
    workerData: { policyProbe: true, rounds },
  });
  let observed;
  try {
    observed = await new Promise((resolve, reject) => {
      let report;
      const timer = setTimeout(() => reject(new Error('Worker probe timed out')), 10000);
      worker.on('message', message => { report = message; });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => {
        clearTimeout(timer);
        if (code !== 0 || !report) reject(new Error('Worker exited without a successful report: ' + code));
        else resolve(report);
      });
    });
  } finally {
    await worker.terminate();
  }
  process.stdout.write(marker + JSON.stringify({ main, worker: observed, requestedLimits, profile }) + '\n');
}

function execute(node, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error;
    const timer = setTimeout(() => {
      error = new Error('Child probe exceeded 20 seconds');
      child.kill();
    }, 20000);
    function append(name, chunk) {
      if (name === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 1024 * 1024) {
        error = new Error('Probe output exceeded 1 MiB');
        child.kill();
      }
    }
    child.stdout.setEncoding('utf8').on('data', chunk => append('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => append('stderr', chunk));
    child.once('error', value => { error = value; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, error: error?.message ?? null });
    });
  });
}

async function run() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--node', '--output', '--allocation-rounds'].includes(args[i]) && args[i + 1], 'Expected --node, --output, or --allocation-rounds followed by a value');
    assert(!(args[i] in options), 'Duplicate option');
    options[args[i]] = args[i + 1];
  }
  const node = path.resolve(options['--node'] ?? path.join(root, 'artifacts/performance/node24/node.exe'));
  assert(options['--output'], '--output must name a new evidence directory');
  const output = path.resolve(options['--output']);
  const rounds = Number(options['--allocation-rounds'] ?? 0);
  assert(Number.isSafeInteger(rounds) && rounds >= 0 && rounds <= 32, 'Allocation rounds must be 0..32');
  // A fresh directory prevents accidental replacement of an earlier observation.
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const result = {
    complete: false, kind: 'V8 flag and heap-policy probe; not a throughput benchmark',
    startedAt: new Date().toISOString(), node, nodeSha256: sha(await readFile(node)),
    sourceSha256: sha(await readFile(here)), allocationRounds: rounds,
    profilesSha256: sha(await readFile(path.join(root, 'packages/prnext/runtime/profiles.json'))),
    appRenderSha256: sha(await readFile(path.join(root, 'packages/prnext/runtime/app-render.mjs'))),
    environment: { NODE_OPTIONS: null, NODE_ENV: 'production', PRNEXT_PROFILE: 'balanced' },
    note: 'resourceLimits reports requested constraints; heap spaces report committed capacity. Effective process-global flags are the post-implication printout.',
    variants: [],
  };
  const env = { ...process.env, NODE_ENV: 'production', PRNEXT_PROFILE: 'balanced' };
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  try {
    for (const variant of variants) {
      // Node's print-flag-values path exits before executing JS. Keep its
      // separate capture linked to the same executable and policy flags.
      const flagCommand = [...variant.flags, '--print-flag-values', '-e', ''];
      const printed = await execute(node, flagCommand, env);
      await writeFile(path.join(output, variant.name + '.flags.stdout.log'), printed.stdout, { flag: 'wx' });
      await writeFile(path.join(output, variant.name + '.flags.stderr.log'), printed.stderr, { flag: 'wx' });
      assert.equal(printed.error, null);
      assert.equal(printed.code, 0, printed.stderr);
      assert.equal(printed.signal, null);
      assert.equal(printed.stderr, '', 'Unexpected flag printer stderr retained in evidence');
      const command = [...variant.flags, here, '--child', String(rounds)];
      const captured = await execute(node, command, env);
      await writeFile(path.join(output, variant.name + '.stdout.log'), captured.stdout, { flag: 'wx' });
      await writeFile(path.join(output, variant.name + '.stderr.log'), captured.stderr, { flag: 'wx' });
      const item = { ...variant, command: [node, ...command], flagCommand: [node, ...flagCommand], flagExitCode: printed.code,
        flagStdoutSha256: sha(printed.stdout), flagStderrSha256: sha(printed.stderr),
        observationStdoutSha256: sha(captured.stdout), observationStderrSha256: sha(captured.stderr), ...captured };
      delete item.stdout;
      delete item.stderr;
      result.variants.push(item);
      assert.equal(captured.error, null);
      assert.equal(captured.code, 0, captured.stderr);
      assert.equal(captured.signal, null);
      assert.equal(captured.stderr, '', 'Unexpected child stderr retained in evidence');
      const reports = captured.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
      assert.equal(reports.length, 1, 'Expected exactly one complete observation');
      item.observation = JSON.parse(reports[0].slice(marker.length));
      const lines = printed.stdout.split(/\r?\n/).map(line => line.trim().replaceAll('_', '-'));
      const semi = lines.filter(line => /^--max-semi-space-size=\d+$/.test(line));
      assert.equal(semi.length, 1, 'Effective semi-space flag not found unambiguously');
      item.effectiveSemiSpaceMiB = Number(semi[0].split('=')[1]);
      item.effectiveFlags = lines.filter(line => /^--(?:no-)?(?:optimize-for-size|memory-saver-mode|jitless|turbofan|maglev|sparkplug|heap-growing-percent|max-semi-space-size|max-old-space-size|abort-on-contradictory-flags)(?:=|$)/.test(line));
    }
    result.complete = true;
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(result.variants.map(({ name, effectiveSemiSpaceMiB, effectiveFlags }) => ({ name, effectiveSemiSpaceMiB, effectiveFlags })), null, 2));
}

if (!isMainThread && workerData?.policyProbe) {
  parentPort.postMessage(await observe(workerData.rounds));
} else if (process.argv[2] === '--child') {
  await inspectChild();
} else {
  await run();
}
