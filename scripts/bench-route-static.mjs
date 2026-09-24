import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { routeStaticFixture } from '../tests/route-static-fixture.mjs';
import { startServer } from '../tests/support.mjs';

const concurrency = 4, secondsPerEndpoint = 3, originDelayMs = 10;
const maxRequestsPerEndpoint = 100_000, warmupRequests = 20, maintenanceIdleSeconds = 31;
const decoder = new TextDecoder();
const fixture = await routeStaticFixture({ originDelayMs });
let server;

async function memory() {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
  const rows = stdout.trim().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: +match[1], parent: +match[2], rss: +match[3], executable: path.basename(match[4]) }] : [];
  });
  const native = rows.find(row => row.pid === server.child.pid);
  if (!native) throw new Error('Native benchmark process exited before RSS could be measured.');
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
    childProcesses: descendants.length,
    nodeProcesses: nodes.length,
  };
}

const endpoints = [
  { label: 'Build-generated Route Handler', pathname: '/static/json', originKey: 'json', cached: true, firstCacheState: 'HIT', expectedNodeProcesses: 0 },
  { label: 'Runtime-generated Route Handler', pathname: '/implicit/benchmark', originKey: 'implicit/benchmark', cached: true, firstCacheState: 'MISS', expectedNodeProcesses: 1, methodField: 'GET' },
  { label: 'Uncached Route Handler', pathname: '/dynamic/default', originKey: 'default', cached: false, firstCacheState: null, expectedNodeProcesses: 1 },
];

async function read(endpoint, expectedCacheState = endpoint.cached ? 'HIT' : null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Benchmark request timed out')), 5000);
  try {
    const response = await fetch(server.url + endpoint.pathname, {
      redirect: 'manual', headers: { 'accept-encoding': 'identity' }, signal: controller.signal,
    });
    const bytes = await response.arrayBuffer();
    const text = decoder.decode(bytes);
    const value = JSON.parse(text);
    const cacheState = response.headers.get('x-nextjs-cache');
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json') ||
        value.key !== endpoint.originKey || value.value !== 0 || value.mode !== 'ok' ||
        !Number.isInteger(value.count) || value.count < 1 ||
        (endpoint.cached && value.count !== 1) ||
        (endpoint.methodField && value.method !== endpoint.methodField) || cacheState !== expectedCacheState) {
      throw new Error(`${endpoint.label}: invalid response (HTTP ${response.status}, cache ${cacheState}, ${text.slice(0, 100)})`);
    }
    return { bytes: bytes.byteLength, cacheState };
  } finally { clearTimeout(timeout); }
}

try {
  server = await startServer(fixture.root, ['--workers', '1']);
  const initialMemory = await memory();
  const buildOriginRequests = fixture.counts.get('json') || 0;
  if (buildOriginRequests !== 1) throw new Error('The static JSON fixture must fetch its origin exactly once during the build.');
  const results = [];
  let afterMaintenanceIdle;
  for (const endpoint of endpoints) {
    const originAtStart = fixture.counts.get(endpoint.originKey) || 0;
    const firstStarted = performance.now();
    const first = await read(endpoint, endpoint.firstCacheState);
    const firstRequestMs = performance.now() - firstStarted;
    const firstOriginRequests = (fixture.counts.get(endpoint.originKey) || 0) - originAtStart;
    const expectedFirstOriginRequests = endpoint.firstCacheState === 'HIT' ? 0 : 1;
    if (firstOriginRequests !== expectedFirstOriginRequests) throw new Error(`${endpoint.label}: unexpected first-request origin count ${firstOriginRequests}.`);
    for (let index = 0; index < warmupRequests; index++) await read(endpoint);
    const originBefore = fixture.counts.get(endpoint.originKey) || 0;
    const samples = [];
    const errorSamples = [];
    let issued = 0, errors = 0, totalBytes = 0;
    const started = performance.now(), deadline = started + secondsPerEndpoint * 1000;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline && issued < maxRequestsPerEndpoint) {
        issued++;
        const tick = performance.now();
        try {
          const result = await read(endpoint);
          totalBytes += result.bytes;
        } catch (error) { errors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        samples.push(performance.now() - tick);
      }
    }));
    const elapsedMs = performance.now() - started;
    samples.sort((a, b) => a - b);
    const rss = await memory();
    const warmOriginRequests = (fixture.counts.get(endpoint.originKey) || 0) - originBefore;
    const countMatches = warmOriginRequests === (endpoint.cached ? 0 : samples.length);
    const workersMatch = rss.nodeProcesses === endpoint.expectedNodeProcesses && rss.childProcesses === endpoint.expectedNodeProcesses;
    const checksPassed = errors === 0 && countMatches && workersMatch && samples.length > 0;
    results.push({ label: endpoint.label, endpoint: endpoint.pathname, expectedStatus: 200,
      requests: samples.length, errors, ...(errorSamples.length ? { errorSamples } : {}),
      firstRequestMs: +firstRequestMs.toFixed(2), firstCacheState: first.cacheState, firstOriginRequests,
      elapsedMs: +elapsedMs.toFixed(1), requestsPerSecond: Math.round(samples.length * 1000 / elapsedMs),
      p50Ms: +(samples[Math.floor(samples.length * .5)] || 0).toFixed(2),
      p95Ms: +(samples[Math.floor(samples.length * .95)] || 0).toFixed(2),
      meanResponseBytes: samples.length ? Math.round(totalBytes / samples.length) : 0,
      warmOriginRequests, warmOriginRequestsAvoided: samples.length - warmOriginRequests,
      originCountMatches: countMatches, workerCountMatches: workersMatch, checksPassed,
      requestCapReached: issued === maxRequestsPerEndpoint, ...rss,
    });
    if (endpoint.pathname === '/implicit/benchmark') {
      const originBeforeIdle = fixture.counts.get(endpoint.originKey) || 0;
      await delay(maintenanceIdleSeconds * 1000);
      const tick = performance.now();
      const cached = await read(endpoint);
      const requestMs = performance.now() - tick;
      const idleRss = await memory();
      const originRequests = (fixture.counts.get(endpoint.originKey) || 0) - originBeforeIdle;
      afterMaintenanceIdle = { idleSeconds: maintenanceIdleSeconds, cacheState: cached.cacheState,
        requestMs: +requestMs.toFixed(2), originRequests, ...idleRss,
        checksPassed: cached.cacheState === 'HIT' && originRequests === 0 && idleRss.childProcesses === 0 };
    }
  }
  const checksPassed = initialMemory.childProcesses === 0 && afterMaintenanceIdle?.checksPassed && results.every(result => result.checksPassed);
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, node: process.version, requestWorkers: 1, maintenanceWorkers: 1,
    concurrency, secondsPerEndpoint, originDelayMs, warmupRequests, maxRequestsPerEndpoint,
    encoding: 'identity', rscWorkerThreadsExpected: 0, buildOriginRequests,
    memory: 'RSS sampled after startup, each workload and a 31 s maintenance-idle interval; not peak. Includes the native server and descendant Node processes, excludes the benchmark client, local origin and build. Route Handlers execute without an RSC worker thread; threads are not individually measured.',
    limitations: 'Local HTTP microbenchmark with a delayed 10 ms origin, no Next.js comparison or production-capacity claim. Three workloads share one instance in order. Cold runtime generation starts a maintenance Node worker; after its idle retirement a cached HIT must avoid Node, then uncached requests start a request worker. Response status, JSON and cache-state validation are included in timings. At most 100000 timed requests plus 21 first/warmup requests per workload and one post-idle cache check.',
    checksPassed, initialMemory, afterMaintenanceIdle, results }, null, 2));
  if (!checksPassed) process.exitCode = 1;
} finally { await server?.close(); await fixture.remove(); }
