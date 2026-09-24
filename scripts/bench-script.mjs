import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scriptFixture } from '../tests/script-fixture.mjs';
import { startServer } from '../tests/support.mjs';

const checkOnly = process.argv.includes('--check');
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const concurrency = Number(process.env.BENCH_CONCURRENCY || 4);
const secondsPerEndpoint = Number(process.env.BENCH_SECONDS || 3);
const maxRequestsPerEndpoint = 100_000;
const warmupRequests = checkOnly ? 0 : 20;
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
    !Number.isFinite(secondsPerEndpoint) || secondsPerEndpoint <= 0 || secondsPerEndpoint > 30) {
  throw new Error('BENCH_CONCURRENCY must be 1–16 and BENCH_SECONDS must be greater than zero and at most 30.');
}
const decoder = new TextDecoder();
const fixture = await scriptFixture();
let server;
const originRequests = () => [...fixture.counts.values()].reduce((sum, count) => sum + count, 0);

async function memory() {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
  const rows = stdout.trim().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: +match[1], parent: +match[2], rss: +match[3], executable: path.basename(match[4]) }] : [];
  });
  const native = rows.find(row => row.pid === server.child.pid);
  if (!native) throw new Error('Native benchmark process exited before its RSS could be measured.');
  const pids = new Set([native.pid]);
  for (;;) {
    const size = pids.size;
    for (const row of rows) if (pids.has(row.parent)) pids.add(row.pid);
    if (pids.size === size) break;
  }
  const descendants = rows.filter(row => row.pid !== native.pid && pids.has(row.pid));
  const nodes = descendants.filter(row => /^(?:node|nodejs)(?:\.exe)?$/.test(row.executable));
  return {
    rustRssMiB: +(native.rss / 1024).toFixed(1),
    nodeRssMiB: +(nodes.reduce((sum, row) => sum + row.rss, 0) / 1024).toFixed(1),
    totalRssMiB: +((native.rss + descendants.reduce((sum, row) => sum + row.rss, 0)) / 1024).toFixed(1),
    childProcesses: descendants.length, nodeProcesses: nodes.length,
  };
}

const endpoints = [
  { label: 'Cached Pages HTML with Script', pathname: '/docs/pages', contentType: 'text/html', check(text) {
    return text.includes('Pages scripts</h1>') && text.includes('data-nscript="beforeInteractive"') &&
      text.includes('/before-first.js') && text.includes('inline-first:exec') && text.includes('/resources/_rustyx/assets/');
  } },
  { label: 'Cached App HTML with Script', pathname: '/docs/app', contentType: 'text/html', check(text) {
    return text.includes('App scripts</h1>') && text.includes('__RUSTYX_SCRIPTS__') &&
      text.includes('/before-first.js') && text.includes('inline-first:exec') && text.includes('/resources/_rustyx/assets/');
  } },
  { label: 'Cached App Flight with Script', pathname: '/docs/app', headers: { RSC: '1' }, contentType: 'text/x-component', check(text) {
    return text.includes('App scripts') && text.includes('beforeInteractive') && text.includes('/before-first.js') &&
      text.includes('inline-first:exec') && text.includes('client-');
  } },
];

async function read(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Benchmark request timed out')), 5000);
  try {
    const response = await fetch(server.url + endpoint.pathname, { redirect: 'manual',
      headers: { 'accept-encoding': 'identity', ...endpoint.headers }, signal: controller.signal });
    const bytes = await response.arrayBuffer();
    const text = decoder.decode(bytes);
    const state = response.headers.get('x-nextjs-cache');
    if (response.status !== 200 || state !== 'HIT' || !response.headers.get('content-type')?.startsWith(endpoint.contentType) || !endpoint.check(text)) {
      throw new Error(`${endpoint.label}: invalid response (HTTP ${response.status}, cache ${state}, ${text.slice(0, 100)})`);
    }
    return bytes.byteLength;
  } finally { clearTimeout(timeout); }
}

try {
  // Keep the integration fixture's Script tree and Document. Explicit GSP puts
  // this Pages route in the same observable HIT cache path as the App routes.
  await appendFile(path.join(fixture.root, 'pages/pages.jsx'), '\nexport const getStaticProps=()=>({props:{},revalidate:false});\n');
  const manifest = await fixture.build();
  for (const pathname of ['/pages', '/app']) {
    const route = manifest.routes.find(route => route.pattern === pathname);
    if (!route?.ssg || !manifest.prerendered.some(seed => seed.path === pathname)) throw new Error(`${pathname} must be generated at build time.`);
  }
  const buildOriginRequests = originRequests();
  if (buildOriginRequests !== 0) throw new Error('Rendering Script must not fetch or execute third-party scripts on the server.');
  server = await startServer(fixture.root, ['--workers', '1']);
  const initialMemory = await memory();
  const results = [];
  for (const endpoint of endpoints) {
    const tick = performance.now();
    const firstResponseBytes = await read(endpoint);
    const firstRequestMs = performance.now() - tick;
    for (let index = 0; index < warmupRequests; index++) await read(endpoint);
    const samples = [], errorSamples = [];
    let issued = 0, errors = 0, bytes = 0;
    const started = performance.now(), deadline = started + secondsPerEndpoint * 1000;
    if (!checkOnly) await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline && issued < maxRequestsPerEndpoint) {
        issued++;
        const tick = performance.now();
        try {
          const received = await read(endpoint);
          bytes += received;
        }
        catch (error) { errors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        samples.push(performance.now() - tick);
      }
    }));
    const elapsedMs = performance.now() - started;
    samples.sort((a, b) => a - b);
    const rss = await memory();
    const thirdPartyOriginRequests = originRequests();
    const noNodeWorkers = rss.nodeProcesses === 0 && rss.childProcesses === 0;
    const responseBytesMatch = bytes === firstResponseBytes * samples.length;
    const checksPassed = errors === 0 && responseBytesMatch && thirdPartyOriginRequests === 0 && noNodeWorkers && (checkOnly || samples.length > 0);
    results.push({ label: endpoint.label, endpoint: endpoint.pathname, expectedStatus: 200, expectedCacheState: 'HIT',
      ...(endpoint.headers ? { requestHeaders: endpoint.headers } : {}),
      firstRequestMs: +firstRequestMs.toFixed(2), firstResponseBytes,
      requests: samples.length, errors, ...(errorSamples.length ? { errorSamples } : {}),
      ...(!checkOnly ? { elapsedMs: +elapsedMs.toFixed(1), requestsPerSecond: Math.round(samples.length * 1000 / elapsedMs),
        p50Ms: +(samples[Math.floor(samples.length * .5)] || 0).toFixed(2),
        p95Ms: +(samples[Math.floor(samples.length * .95)] || 0).toFixed(2),
        p99Ms: +(samples[Math.floor(samples.length * .99)] || 0).toFixed(2),
        measuredResponseBytes: bytes,
        meanResponseBytes: samples.length ? Math.round(bytes / samples.length) : 0 } : {}),
      requestCapReached: issued === maxRequestsPerEndpoint, responseBytesMatch, thirdPartyOriginRequests, noNodeWorkers, checksPassed, ...rss,
    });
  }
  const checksPassed = initialMemory.childProcesses === 0 && results.every(result => result.checksPassed);
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), mode: checkOnly ? 'validation-only' : 'benchmark',
    platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, node: process.version,
    requestWorkers: 1, concurrency, secondsPerEndpoint, warmupRequests, maxRequestsPerEndpoint,
    encoding: 'identity', redirects: 'manual', buildOriginRequests,
    fixture: 'scriptFixture: real next/script and rustyx/script trees, Pages custom Document and App layout, basePath /docs, assetPrefix /resources. Pages route adds explicit getStaticProps for observable native cache HIT.',
    memory: 'RSS sampled after startup and each workload, not peak. Includes native server and all descendants; excludes the benchmark client, local script origin and build. These cached scenarios must not start a Node worker.',
    limitations: 'Local HTTP microbenchmark, three workloads sequentially on one instance. No browser execution timing, third-party performance measurement, Next.js comparison or production capacity claim. The client and idle third-party origin share this machine and process. Body, MIME type and cache HIT validation are included in elapsed time. At most 100000 timed requests plus 21 first/warmup requests per workload.',
    checksPassed, initialMemory, results }, null, 2));
  if (!checksPassed) process.exitCode = 1;
} finally { await server?.close(); await fixture.remove(); }
