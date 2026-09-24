// Production A/B benchmark. No framework implementation is changed by this script.
// RUSTYX_NEXT_REFERENCE=/path/to/node_modules/next node scripts/bench-next-comparison.mjs
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), '..');
const exec = promisify(execFile);
const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;

// A separate load generator lets the driver sample memory without blocking HTTP.
async function load(options) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: options.concurrency });
  const latencies = [];
  let issued = 0, bytes = 0, errors = 0;
  const errorStatuses = {};
  const endpointCounts = {};
  const cpuStart = process.cpuUsage(), started = performance.now();
  const deadline = started + (options.durationMs || Infinity);
  try {
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (performance.now() < deadline && issued < (options.requests || 200_000)) {
        const nonce = `bench-${++issued}`;
        const scenario = options.workloads ? options.workloads[(issued - 1) % options.workloads.length] : options;
        endpointCounts[scenario.endpoint] = (endpointCounts[scenario.endpoint] || 0) + 1;
        const url = new URL(scenario.endpoint, options.base);
        if (scenario.dynamic) url.searchParams.set('nonce', nonce);
        const before = performance.now();
        await new Promise((resolve, reject) => {
          const request = http.get(url, { agent, headers: { 'accept-encoding': options.encoding || 'identity' } }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
              const buffer = Buffer.concat(chunks);
              let decoded;
              try { decoded = response.headers['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer; }
              catch (error) { reject(error); return; }
              const body = decoded.toString();
              if (options.tolerateErrors && response.statusCode !== 200) {
                errors++;
                errorStatuses[response.statusCode] = (errorStatuses[response.statusCode] || 0) + 1;
                resolve();
                return;
              }
              if (response.statusCode !== 200 || !body.includes(scenario.marker) ||
                  (scenario.dynamic && !body.includes(nonce)) ||
                  (scenario.exactBytes && decoded.length !== scenario.exactBytes)) {
                reject(new Error(`Invalid response ${url}: ${response.statusCode} ${body.slice(0, 200)}`));
                return;
              }
              bytes += buffer.length;
              latencies.push(performance.now() - before);
              resolve();
            });
          });
          request.setTimeout(10_000, () => request.destroy(new Error('HTTP timeout')));
          request.on('error', reject);
        });
      }
    }));
  } finally { agent.destroy(); }
  const elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuStart);
  latencies.sort((a, b) => a - b);
  return { requests: latencies.length, elapsedMs, requestsPerSecond: latencies.length * 1000 / elapsedMs,
    p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99),
    meanBodyBytes: bytes / latencies.length, clientCpuMs: (cpu.user + cpu.system) / 1000,
    reachedRequestCap: !options.requests && issued >= 200_000, attempts: issued, errors, errorStatuses, endpointCounts };
}

export { client, processTree, sample, start };

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--load') {
    console.log(JSON.stringify(await load(JSON.parse(process.argv[3]))));
  } else {
    await benchmark();
  }
}

async function benchmark() {
  if (!process.env.RUSTYX_NEXT_REFERENCE) throw new Error('Set RUSTYX_NEXT_REFERENCE to an installed Next package');
  const next = path.resolve(process.env.RUSTYX_NEXT_REFERENCE);
  const referenceRoot = path.dirname(path.dirname(next));
  const nextVersion = JSON.parse(await readFile(path.join(next, 'package.json'), 'utf8')).version;
  const reactVersion = JSON.parse(await readFile(path.join(next, '../react/package.json'), 'utf8')).version;
  const binary = path.join(repo, 'target/release/rustyx');
  const root = await mkdtemp(path.join(referenceRoot, 'rustyx-benchmark-'));
  const repetitions = Number(process.env.BENCH_REPETITIONS || 3);
  const durationMs = Number(process.env.BENCH_DURATION_MS || 4000);
  const concurrency = Number(process.env.BENCH_CONCURRENCY || 4);
  const output = path.resolve(process.env.BENCH_OUTPUT || path.join(repo, 'docs/benchmark-next-comparison-local.json'));
  const nextCli = path.join(next, 'dist/bin/next');
  const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
  const files = {
    'package.json': JSON.stringify({ name: 'rustyx-next-benchmark', private: true, type: 'module', dependencies: { next: nextVersion, react: reactVersion, 'react-dom': reactVersion } }),
    'next.config.mjs': 'export default {}',
    'components/counter.jsx': `'use client';import{useState}from'react';export default function Counter(){const[n,set]=useState(0);return <button onClick={()=>set(n+1)}>counter {n}</button>}`,
    'components/content.jsx': `import Counter from './counter';export default function Content({nonce='static'}){return <main><h1>Rustyx benchmark</h1><p>{nonce}</p><Counter/><ul>{Array.from({length:100},(_,i)=><li key={i}>Row {i}: identical content for both frameworks</li>)}</ul></main>}`,
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/app-static/page.jsx': `import Content from '../../components/content';export default function Page(){return <Content/>}`,
    'app/app-ssr/page.jsx': `import Content from '../../components/content';export const dynamic='force-dynamic';export default async function Page({searchParams}){return <Content nonce={(await searchParams).nonce||'none'}/>}`,
    'pages/pages-static.jsx': `import Content from '../components/content';export function getStaticProps(){return {props:{nonce:'static'}}}export default Content;`,
    'pages/pages-ssr.jsx': `import Content from '../components/content';export function getServerSideProps({query}){return {props:{nonce:query.nonce||'none'}}}export default Content;`,
    'pages/api/pages.js': `export default function handler(req,res){res.json({ok:true,marker:'benchmark-api',nonce:req.query.nonce||'none',values:Array.from({length:20},(_,i)=>i*i)})}`,
    'app/api/app/route.js': `export const dynamic='force-dynamic';export function GET(request){return Response.json({ok:true,marker:'benchmark-api',nonce:new URL(request.url).searchParams.get('nonce')||'none',values:Array.from({length:20},(_,i)=>i*i)})}`,
    'public/ready.txt': 'benchmark-ready',
    'public/payload.txt': 'rustyx-public-benchmark\n'.padEnd(32768, 'x'),
  };
  const scenarios = [
    { name: 'public-32k', endpoint: '/payload.txt', marker: 'rustyx-public-benchmark', exactBytes: 32768 },
    { name: 'pages-static', endpoint: '/pages-static', marker: 'Rustyx benchmark' },
    { name: 'app-static', endpoint: '/app-static', marker: 'Rustyx benchmark' },
    { name: 'pages-ssr', endpoint: '/pages-ssr', marker: 'Rustyx benchmark', dynamic: true },
    { name: 'app-ssr', endpoint: '/app-ssr', marker: 'Rustyx benchmark', dynamic: true },
    { name: 'pages-api', endpoint: '/api/pages', marker: 'benchmark-api', dynamic: true },
    { name: 'app-api', endpoint: '/api/app', marker: 'benchmark-api', dynamic: true },
  ];
  const mixedWorkloads = [...scenarios];
  if (process.env.BENCH_SKIP_STRESS !== '1') scenarios.push(
    ...scenarios.filter(s => s.name === 'pages-ssr' || s.name === 'app-ssr').map(s => ({ ...s, name: s.name + '-c8', concurrency: 8, tolerateErrors: true, durationMs: Math.min(durationMs, 2000) })),
  );
  if (process.env.BENCH_GZIP === '1') scenarios.push(
    ...scenarios.filter(s => ['public-32k', 'pages-static', 'app-static'].includes(s.name))
      .map(s => ({ ...s, name: s.name + '-gzip', encoding: 'gzip' })),
  );
  if (process.env.BENCH_MIXED === '1') scenarios.push({
    name: 'mixed-total', workloads: mixedWorkloads, requests: 70_000, warmupRequests: 1400,
  });
  const data = {
    startedAt: new Date().toISOString(), status: 'running',
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramGiB: os.totalmem() / 1024 ** 3, node: process.version },
    versions: { next: nextVersion, react: reactVersion, rustyx: JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version },
    binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    sourceSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    fixtureFiles: files,
    method: { repetitions, durationMs, concurrency, fixedWarmupRequests: 1000, sampleIntervalMs: 150,
      mixedWorkload: process.env.BENCH_MIXED === '1' ? { requests: 70_000, warmupRequests: 1400, distribution: '10,000 requests per each of the seven base endpoints, interleaved on one server', concurrency } : undefined,
      compression: process.env.BENCH_GZIP === '1' ? 'identity; gzip for scenarios ending in -gzip' : 'identity', nextBuilder: 'default (Turbopack)', rustyxWorkers: 1, freshServerPerScenario: true,
      memory: 'Sum of RSS of server and all descendant processes; shared pages may be counted twice. Browser/client excluded.',
      cpu: 'ps cumulative CPU delta across process tree during load, excluding load generator',
      build: 'Remove framework output before each build; OS disk cache not cleared; excludes toolchain/dependency installation.',
      limitations: 'Synthetic local microbenchmark, one machine, no CDN/TLS/database, short runs, client shares CPU with server; no universal production speedup.' },
    builds: [], runs: [], browser: [],
  };
  const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(data, null, 2) + '\n'); };
  const commands = {
    next: { build: [process.execPath, [nextCli, 'build', root]], start: port => [process.execPath, [nextCli, 'start', root, '--hostname', '127.0.0.1', '--port', String(port)]] },
    rustyx: { build: [process.execPath, [path.join(repo, 'packages/rustyx/cli.mjs'), 'build', root]], start: port => [binary, ['start', root, '--hostname', '127.0.0.1', '--port', String(port), '--workers', '1']] },
  };
  const engines = ['next', 'rustyx'];
  const runtimeOverrides = new Map();
  if (process.env.BENCH_BASELINE_BINARY) {
    const baseline = path.resolve(process.env.BENCH_BASELINE_BINARY);
    commands['rustyx-before'] = { start: port => [baseline, ['start', root, '--hostname', '127.0.0.1', '--port', String(port), '--workers', '1']] };
    engines.splice(1, 0, 'rustyx-before');
    data.baseline = { binary: baseline, sha256: createHash('sha256').update(await readFile(baseline)).digest('hex'),
      note: 'Native binary comparison; both Rustyx binaries serve the same current app build and JavaScript runtime.' };
    if (process.env.BENCH_BASELINE_RUNTIME_DIR) {
      const directory = path.resolve(process.env.BENCH_BASELINE_RUNTIME_DIR);
      data.baseline.runtimeOverrides = {};
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.mjs')) continue;
        const before = await readFile(path.join(directory, name));
        runtimeOverrides.set(name, { before });
        data.baseline.runtimeOverrides[name] = createHash('sha256').update(before).digest('hex');
      }
      data.baseline.note = 'Same app build; baseline binary uses the explicitly recorded old runtime modules. Current runtime is restored before every other engine.';
    }
  }
  const selectRuntime = async engine => {
    for (const [name, versions] of runtimeOverrides) {
      const file = path.join(root, '.rustyx/runtime', name);
      versions.current ??= await readFile(file);
      await writeFile(file, engine === 'rustyx-before' ? versions.before : versions.current);
    }
  };
  data.engines = engines;
  data.commands = commands;
  let server;
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
    await mkdir(path.join(root, 'node_modules'));
    for (const name of ['react', 'react-dom', 'scheduler', 'next']) await symlink(path.join(referenceRoot, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    await cp(path.join(repo, 'node_modules/react-server-dom-webpack'), path.join(root, 'node_modules/react-server-dom-webpack'), { recursive: true });
    await save();
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const engine of repetition % 2 ? ['next', 'rustyx'] : ['rustyx', 'next']) {
        console.log(`Build ${repetition}/${repetitions}: ${engine}`);
        await rm(path.join(root, engine === 'next' ? '.next' : '.rustyx'), { force: true, recursive: true });
        const [command, args] = commands[engine].build;
        const child = launch(command, args, root, env);
        const monitor = sample(child.pid);
        const started = performance.now();
        const code = await child.done;
        const elapsedMs = performance.now() - started;
        const samples = await monitor.stop();
        if (code !== 0) throw new Error(`${engine} build failed:\n${child.output()}`);
        data.builds.push({ engine, repetition, elapsedMs, peakRssMiB: Math.max(0, ...samples.map(s => s.rssMiB)),
          lastSampleCpuMs: Math.max(0, ...samples.map(s => s.cpuMs)), outputBytes: await directoryBytes(path.join(root, engine === 'next' ? '.next' : '.rustyx')),
          log: child.output() });
        await save();
      }
    }
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const scenario of scenarios) {
        const clients = scenario.concurrency || concurrency;
        for (const engine of repetition % 2 ? engines : [...engines].reverse()) {
          await selectRuntime(engine);
          server = await start(commands[engine], root, env);
          const idle = await processTree(server.child.pid);
          const cold = await client({ ...scenario, base: server.base, concurrency: 1, requests: 1, durationMs: undefined });
          await client({ ...scenario, base: server.base, concurrency, requests: scenario.warmupRequests || 1000, durationMs: undefined });
          await delay(200);
          const afterEqualWarmup = await processTree(server.child.pid);
          const monitor = sample(server.child.pid);
          const before = await processTree(server.child.pid);
          const result = await client({ ...scenario, base: server.base, concurrency: clients,
            durationMs: scenario.requests ? undefined : scenario.durationMs || durationMs });
          const after = await processTree(server.child.pid);
          const samples = await monitor.stop();
          const rss = samples.map(s => s.rssMiB).sort((a, b) => a - b);
          const serverCpuMs = after.cpuMs - before.cpuMs;
          const row = { engine, repetition, scenario: scenario.name, encoding: scenario.encoding || 'identity', concurrency: clients, startupMs: server.startupMs,
            coldRequestMs: cold.p50Ms, idle, afterEqualWarmup, afterLoad: after,
            loadMedianRssMiB: percentile(rss, .5), loadPeakRssMiB: Math.max(...rss), memorySamples: samples.length,
            serverCpuMs, cpuMsPerRequest: serverCpuMs / result.requests, ...result };
          data.runs.push(row);
          console.log(`${repetition}/${repetitions} ${engine.padEnd(6)} ${scenario.name.padEnd(12)} ${Math.round(result.requestsPerSecond)} valid req/s, RSS ${row.loadMedianRssMiB.toFixed(1)} MiB, p95 ${result.p95Ms.toFixed(2)} ms, ${result.errors} errors`);
          await server.close(); server = undefined;
          await save();
        }
      }
    }
    // Browser checks are outside all server throughput/memory measurements.
    if (process.env.BENCH_SKIP_BROWSER !== '1') {
      const { chromium } = await import('@playwright/test');
      const browser = await chromium.launch();
      try {
        for (const engine of engines) {
          await selectRuntime(engine);
          server = await start(commands[engine], root, env);
          for (const endpoint of ['/pages-static', '/app-static']) {
            const context = await browser.newContext();
            try {
              const page = await context.newPage();
              const errors = [];
              page.on('pageerror', error => errors.push(error.message));
              await page.goto(server.base + endpoint, { waitUntil: 'networkidle' });
              await page.getByRole('button', { name: 'counter 0', exact: true }).click();
              await page.getByRole('button', { name: 'counter 1', exact: true }).waitFor();
              const resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script' || /\.js(?:\?|$)/.test(r.name)).map(r => ({ path: new URL(r.name).pathname, encodedBytes: r.encodedBodySize, decodedBytes: r.decodedBodySize })));
              if (errors.length) throw new Error(`${engine} browser errors: ${errors.join('; ')}`);
              data.browser.push({ engine, endpoint, hydrationPassed: true, scriptCount: resources.length,
                scriptEncodedBytes: resources.reduce((sum, r) => sum + r.encodedBytes, 0),
                scriptDecodedBytes: resources.reduce((sum, r) => sum + r.decodedBytes, 0), resources });
              console.log(`Browser ${engine} ${endpoint}: hydration OK, JS ${(data.browser.at(-1).scriptEncodedBytes / 1024).toFixed(1)} KiB compressed`);
            } finally { await context.close(); }
          }
          await server.close(); server = undefined;
        }
      } finally { await browser.close(); }
    }
    data.status = 'complete'; data.finishedAt = new Date().toISOString();
    await save();
    console.log(`Results: ${output}`);
  } catch (error) {
    data.status = 'failed'; data.error = error.stack; await save(); throw error;
  } finally {
    if (server) await server.close();
    if (process.env.BENCH_KEEP_FIXTURE === '1') console.log(`Fixture: ${root}`);
    else await rm(root, { force: true, recursive: true });
  }
}

async function client(options) {
  const { stdout } = await exec(process.execPath, [self, '--load', JSON.stringify(options)], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-30000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-30000); });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.output = () => output;
  return child;
}

async function start(commands, root, env) {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const began = performance.now();
  const child = launch(...commands.start(port), root, env);
  const base = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    try { await child.done; } finally { clearTimeout(timer); }
  };
  try {
    for (let i = 0; i < 400; i++) {
      if (child.exitCode !== null) throw new Error(child.output());
      try {
        const response = await fetch(base + '/ready.txt', { signal: AbortSignal.timeout(1000) });
        if (response.status === 200 && await response.text() === 'benchmark-ready') return { child, base, close, startupMs: performance.now() - began };
      } catch {}
      await delay(25);
    }
    throw new Error(`Server did not start: ${child.output()}`);
  } catch (error) { await close(); throw error; }
}

function cpuMilliseconds(value) {
  let days = 0;
  if (value.includes('-')) { const parts = value.split('-'); days = Number(parts[0]); value = parts[1]; }
  return (days * 86400 + value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)) * 1000;
}

async function processTree(rootPid) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=']);
  const rows = stdout.trim().split('\n').map(line => {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rssMiB: Number(rss) / 1024, cpuMs: cpuMilliseconds(time) };
  });
  const ids = new Set([rootPid]);
  for (;;) {
    const count = ids.size;
    for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
    if (ids.size === count) break;
  }
  const processes = rows.filter(row => ids.has(row.pid));
  return { rssMiB: processes.reduce((sum, row) => sum + row.rssMiB, 0), cpuMs: processes.reduce((sum, row) => sum + row.cpuMs, 0), processes };
}

function sample(pid) {
  const samples = [];
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const point = await processTree(pid);
      if (point.processes.length) samples.push(point);
      if (!stopped) await delay(150);
    }
  })();
  return { stop: async () => { stopped = true; await done; return samples; } };
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile()) bytes += (await stat(file)).size;
  }
  return bytes;
}
