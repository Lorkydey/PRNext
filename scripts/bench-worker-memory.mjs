import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { appFixture, repositoryRoot, startServer } from '../tests/support.mjs';

const exec = promisify(execFile);
const repetitions = Number(process.env.BENCH_REPETITIONS || 3);
const requests = Number(process.env.BENCH_REQUESTS || 20_000);
const concurrency = 4;
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 ||
    !Number.isInteger(requests) || requests < 100 || requests > 100_000) throw new Error('Invalid benchmark repetitions or request count');
const fixture = await appFixture();
const dist = path.join(fixture.root, '.rustyx');
const baseline = process.env.BENCH_BASELINE_PACKAGE && path.resolve(process.env.BENCH_BASELINE_PACKAGE);
const current = path.join(fixture.root, 'benchmark-runtime');
let server;

// Diagnostics run only before/after the timed workload, never on its hot path.
const diagnostics = String.raw`import {createRequire} from 'node:module';
import {getHeapSpaceStatistics} from 'node:v8';
const require=createRequire(import.meta.url);let calls=0;
export function next(){return ++calls}
export function inspect(){const modules=Object.keys(require.cache);return {
  pid:process.pid,calls,memory:process.memoryUsage(),
  react:modules.some(p=>/[\\/]react[\\/]/.test(p)),
  reactDom:modules.some(p=>/[\\/]react-dom[\\/]/.test(p)),
  heapSpaces:getHeapSpaceStatistics().map(s=>({name:s.space_name,size:s.space_size,used:s.space_used_size}))
}}`;

async function write(file, source) {
  const target = path.join(fixture.root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source);
}

async function snapshot(source, target, { sourceFiles = false } = {}) {
  for (const directory of ['runtime', 'compat']) {
    await mkdir(path.join(target, directory), { recursive: true });
    for (const name of await readdir(path.join(source, directory))) {
      if (!/\.(?:mjs|cjs)$/.test(name) || name.endsWith('.test.mjs')) continue;
      // Build bundles dotenv into env.mjs. Preserve that identical build output
      // when a historical package source tree supplies the baseline runtime.
      if (sourceFiles && directory === 'runtime' && name === 'env.mjs') continue;
      await cp(path.join(source, directory, name), path.join(target, directory, name));
    }
  }
}

async function fingerprint(source) {
  const hash = createHash('sha256');
  for (const directory of ['runtime', 'compat']) {
    for (const name of (await readdir(path.join(source, directory))).sort()) {
      if (!/\.(?:mjs|cjs)$/.test(name) || name.endsWith('.test.mjs') || name === 'env.mjs') continue;
      hash.update(directory + '/' + name + '\0');
      hash.update(await readFile(path.join(source, directory, name)));
    }
  }
  return hash.digest('hex');
}

async function memory() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([server.child.pid]);
  for (;;) {
    const size = pids.size;
    for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
    if (pids.size === size) break;
  }
  const native = rows.find(row => row[0] === server.child.pid);
  if (!native) throw new Error('Benchmark server exited');
  const total = rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0);
  return { rustRssMiB: +(native[2] / 1024).toFixed(1), totalRssMiB: +(total / 1024).toFixed(1), childProcesses: pids.size - 1 };
}

async function request(endpoint, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Benchmark request timed out')), 5000);
  try {
    const response = await fetch(server.url + endpoint, {
      headers: { 'accept-encoding': 'identity' }, signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`${endpoint}: HTTP ${response.status}`);
    return await consume(response);
  } finally { clearTimeout(timer); }
}

async function read(endpoint, inspect = false) {
  return request(endpoint + (inspect ? '?inspect=1' : ''), async response => {
    const value = await response.json();
    if (inspect ? !Number.isInteger(value.pid) : value.ok !== true) throw new Error(`Invalid benchmark response for ${endpoint}`);
    return value;
  });
}

try {
  for (const name of ['app', 'pages', 'components']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
  await write('diagnostics.js', diagnostics);
  await write('rustyx.config.mjs', 'export default {compress:false}');
  await write('app/layout.jsx', 'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await write('app/render/page.jsx', 'export const dynamic="force-dynamic";export default function Page(){return <h1>App memory render</h1>}');
  await write('pages/render-pages.jsx', 'export const getServerSideProps=()=>({props:{}});export default function Page(){return <h1>Pages memory render</h1>}');
  await write('app/api/app/route.js', `import {next,inspect} from '../../../diagnostics.js';export function GET(request){next();return Response.json(new URL(request.url).searchParams.has('inspect')?inspect():{ok:true})}`);
  await write('pages/api/pages.js', `import {next,inspect} from '../../diagnostics.js';export default function handler(req,res){next();res.json(req.query.inspect?inspect():{ok:true})}`);
  await write('proxy.ts', `import {next,inspect} from './diagnostics.js';export const config={matcher:'/middleware'};export function proxy(request){next();return Response.json(request.nextUrl.searchParams.has('inspect')?inspect():{ok:true})}`);
  await exec(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root]);
  await snapshot(dist, current);
  const modes = [{ label: 'current', source: current }];
  if (baseline) modes.unshift({ label: 'baseline', source: baseline, sourceFiles: true });
  const sourceHashes = Object.fromEntries(await Promise.all(modes.map(async mode => [mode.label, await fingerprint(mode.source)])));
  const results = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    // Alternate A/B order between repetitions to reduce order bias.
    for (const mode of repetition % 2 ? modes : [...modes].reverse()) {
      await snapshot(current, dist);
      await snapshot(mode.source, dist, mode);
      for (const endpoint of ['/middleware', '/api/app', '/api/pages']) {
        server = await startServer(fixture.root, ['--workers', '1']);
        try {
          const coldStarted = performance.now();
          const first = await read(endpoint, true);
          const firstRequestMs = +(performance.now() - coldStarted).toFixed(2);
          const afterFirst = await memory();
          for (let index = 0; index < 20; index++) await read(endpoint);
          const latencies = [];
          let issued = 0;
          const started = performance.now();
          await Promise.all(Array.from({ length: concurrency }, async () => {
            while (issued < requests) {
              issued++;
              const tick = performance.now();
              await read(endpoint);
              latencies.push(performance.now() - tick);
            }
          }));
          const elapsedMs = performance.now() - started;
          const after = await read(endpoint, true);
          const afterLoad = await memory();
          latencies.sort((a, b) => a - b);
          if (first.pid !== after.pid || after.calls !== first.calls + 20 + requests + 1 || afterLoad.childProcesses !== 1) {
            throw new Error('A worker restarted or failed to preserve its module state');
          }
          if (mode.label === 'current' && [first, after].some(probe => probe.react || probe.reactDom)) {
            throw new Error('Middleware/API unexpectedly loaded React before rendering a page');
          }
          const transitions = [];
          if (endpoint !== '/middleware') {
            for (const [url, marker] of [['/render-pages', 'Pages memory render'], ['/render', 'App memory render']]) {
              if (!(await request(url, response => response.text())).includes(marker)) throw new Error(`Failed mixed-worker rendering: ${url}`);
              const probe = await read(endpoint, true);
              if (probe.pid !== after.pid || !probe.react || !probe.reactDom || probe.calls !== after.calls + transitions.length + 1) {
                throw new Error('Rendering failed to share the existing API worker and module state');
              }
              transitions.push({ path: url, probe, ...(await memory()) });
            }
          }
          results.push({ mode: mode.label, repetition, endpoint, firstRequestMs, first, afterFirst,
            requests: latencies.length, elapsedMs: +elapsedMs.toFixed(1), requestsPerSecond: Math.round(requests * 1000 / elapsedMs),
            p50Ms: +latencies[Math.floor(latencies.length * .5)].toFixed(2), p95Ms: +latencies[Math.floor(latencies.length * .95)].toFixed(2),
            after, afterLoad, transitions, checksPassed: true });
        } finally { await server.close(); server = undefined; }
      }
    }
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, node: process.version, concurrency, repetitions, requestsPerWorkload: requests,
    sourceHashes, checksPassed: results.every(result => result.checksPassed),
    memory: 'RSS after first request and after a fixed request count; not peak. Native plus descendant Node processes, including RSC threads. Excludes client and build. Internal Node heap statistics are separate diagnostics, not additive RSS.',
    limitations: 'Local HTTP microbenchmark, no Next.js comparison. Each workload starts a fresh server; four clients share one worker. No forced GC or worker restart during a workload. Historical source runtime/compat can be supplied with BENCH_BASELINE_PACKAGE; build/compiler and bundled env.mjs remain current. A/B order alternates between repetitions. Diagnostic probes and mixed API-to-Pages-to-App transitions are excluded from timed throughput.',
    results }, null, 2));
} finally { await server?.close(); await fixture.remove(); }
