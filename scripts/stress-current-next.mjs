// Deliberately exceed the Rustyx admission budget, then verify recovery.
// Run only after audit-current-next.mjs has completed; do not aggregate these
// rejected responses with the normal, successfully validated performance runs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {binary, freePort, repositoryRoot} from '../tests/support.mjs';
import {benchmarkWorkload} from './migration-load.mjs';

const output = path.resolve(process.env.AUDIT_REPORT_DIR || 'reports/current-comparison');
const reference = process.env.RUSTYX_NEXT_REFERENCE;
assert.ok(reference, 'Set RUSTYX_NEXT_REFERENCE');
const base = JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8'));
assert.equal(base.completed, true, 'Complete the sequential main campaign first');
const sha = value => createHash('sha256').update(value).digest('hex');
async function files(directory) {
  let found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.next') || entry.name.startsWith('.rustyx')) continue;
    const file = path.join(directory, entry.name);
    found.push(...entry.isDirectory() ? await files(file) : [file]);
  }
  return found.sort();
}
async function digest(directory) {
  const hash = createHash('sha256');
  for (const file of await files(directory)) {hash.update(path.relative(directory, file)); hash.update(await readFile(file));}
  return hash.digest('hex');
}
assert.equal(sha(await readFile(binary)), base.binarySha256);
assert.equal(await digest(path.join(repositoryRoot, 'packages/rustyx')), base.frameworkSourceSha256);
assert.equal(sha(await readFile(new URL('./migration-load.mjs', import.meta.url))), base.loadScriptSha256);
assert.equal(JSON.parse(await readFile(path.join(reference, 'package.json'), 'utf8')).version, base.versions.next);
const report = {date: new Date().toISOString(), versions: base.versions, binarySha256: base.binarySha256,
  runnerSha256: sha(await readFile(new URL(import.meta.url))), method: {repetitions: 3, concurrency: 512, durationMs: 5000, site: 'portail', endpoint: '/api/slow', waitMs: 30,
    note: 'Deliberate overload, closed loop with immediate reissue even after HTTP 503. No Retry-After behavior. This models an aggressive client and exposes the bounded admission policy; successful-response latency excludes failures. CPU per success includes work on rejected requests and is not comparable as equal useful work.'}, runs: []};
const workloads = [{endpoint: '/api/slow', marker: 'orion-slow', queryNonce: 'q'}];
const save = () => writeFile(path.join(output, 'stress.json'), JSON.stringify(report, null, 2) + '\n');
async function server(engine) {
  const root = path.join(output, 'projects/portail', engine);
  assert.equal(await digest(root), base.sites.find(site => site.name === 'portail').sourceSha256);
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const args = engine === 'next' ? [path.join(reference, 'dist/bin/next'), 'start', root, '--hostname', '127.0.0.1', '--port', String(port)] : ['start', root, '--hostname', '127.0.0.1', '--port', String(port), '--workers', '1'];
  const child = spawn(engine === 'next' ? process.execPath : binary, args, {cwd: root, env: {...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => log = (log + chunk).slice(-1024 * 1024));
  const done = new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', resolve);});
  const close = async () => {if (child.exitCode !== null || child.signalCode) return; const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); try {await done;} finally {clearTimeout(timer);}};
  try {
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error(log);
      try {const response = await fetch(url + '/health.txt', {signal: AbortSignal.timeout(1000)}); if (response.status === 200) {await response.arrayBuffer(); return {url, child, close, log: () => log};}} catch {}
      await delay(25);
    }
    throw new Error('Readiness timeout');
  } catch (error) {await close(); throw error;}
}
for (let repetition = 1; repetition <= 3; repetition++) {
  for (const engine of repetition % 2 ? ['next', 'rustyx'] : ['rustyx', 'next']) {
    const row = {engine, repetition}; let active;
    try {
      console.log('OVERLOAD', engine, repetition);
      active = await server(engine);
      Object.assign(row, await benchmarkWorkload(active, workloads, {durationMs: 5000, concurrency: 512, warmupRequests: 40, warmupConcurrency: 4, maxRequests: 2000000}));
      await delay(1000);
      row.recovery = await benchmarkWorkload(active, workloads, {durationMs: 2000, concurrency: 4, warmupRequests: 16, warmupConcurrency: 4, maxRequests: 100000});
      console.log('RESULT', engine, row.requestsPerSecond, row.errors, row.failures, 'recovery', row.recovery.errors);
    } catch (error) {row.error = error.stack;}
    finally {if (active) {await active.close(); await writeFile(path.join(output, `overload-${engine}-${repetition}.log`), active.log());}}
    report.runs.push(row); await save();
  }
}
report.finishedAt = new Date().toISOString(); await save();
if (report.runs.some(row => row.error || !row.cpuValid || row.reachedCap || row.recovery?.errors || row.engine === 'next' && row.errors || Object.keys(row.failures || {}).some(key => key !== 'HTTP 503'))) process.exitCode = 1;
