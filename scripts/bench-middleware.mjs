import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { middlewareFixture } from '../tests/middleware-fixture.mjs';
import { startServer } from '../tests/support.mjs';

const concurrency = 4, secondsPerEndpoint = 3, maxRequestsPerEndpoint = 100_000;
const warmupRequests = 20, middlewareIdleSeconds = 31;
const decoder = new TextDecoder();
const fixture = await middlewareFixture();
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
    childProcesses: descendants.length, nodeProcesses: nodes.length,
  };
}

function cachedPage(response, text) {
  return response.headers.get('x-nextjs-cache') === 'HIT' &&
    response.headers.get('content-type')?.startsWith('text/html') &&
    text.includes('data-testid="static-title">Cached application page</h1>');
}

const endpoints = [
  { label: 'Cached App page without middleware', pathname: '/static', status: 200, expectedNodes: 0, expectedBoots: 0,
    check: (response, text) => cachedPage(response, text) && !response.headers.has('x-proxy-seen-path') },
  { label: 'Middleware redirect', pathname: '/mw/redirect', status: 307, expectedNodes: 1, expectedBoots: 1,
    check(response) {
      const target = new URL(response.headers.get('location'), server.url);
      return target.origin === server.url && target.pathname === '/static' &&
        target.search === '?redirect=middleware' && response.headers.get('x-config') === 'yes';
    } },
  { label: 'Middleware direct JSON', pathname: '/mw/inspect', status: 200, expectedNodes: 1, expectedBoots: 1,
    check(response, text) {
      const value = JSON.parse(text);
      return response.headers.get('content-type')?.startsWith('application/json') &&
        value.url === server.url + '/mw/inspect' && value.headers['x-bench'] === 'middleware' &&
        Array.isArray(value.cookies) && value.cookies.length === 0 && response.headers.get('x-config') === 'yes';
    } },
  { label: 'Middleware rewrite to cached App page', pathname: '/mw/static', status: 200, expectedNodes: 1, expectedBoots: 1,
    check: (response, text) => cachedPage(response, text) &&
      response.headers.get('x-proxy-seen-path') === '/mw/static' && response.headers.get('x-shared') === 'middleware' &&
      text.includes('__PRNEXT_REWRITE__') },
  { label: 'Middleware then dynamic Route Handler', pathname: '/mw/next', status: 200, expectedNodes: 2, expectedBoots: 2,
    check(response, text) {
      const value = JSON.parse(text);
      return response.headers.get('content-type')?.startsWith('application/json') &&
        response.headers.get('x-proxy-seen-path') === '/mw/next' && response.headers.get('x-own') === 'handler' &&
        value.url === server.url + '/mw/next' && value.method === 'GET' && value.body === '' &&
        value.headers['x-added'] === 'added' && value.headers['x-shared'] === 'middleware' &&
        value.ambientHeaders['x-added'] === 'added' && JSON.stringify(value.params) === '{"segments":["next"]}';
    } },
];

async function read(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Benchmark request timed out')), 5000);
  try {
    const response = await fetch(server.url + endpoint.pathname, {
      redirect: 'manual', headers: { 'accept-encoding': 'identity', 'x-bench': 'middleware' }, signal: controller.signal,
    });
    const bytes = await response.arrayBuffer();
    const text = decoder.decode(bytes);
    if (response.status !== endpoint.status || !endpoint.check(response, text)) {
      throw new Error(`${endpoint.label}: invalid response (HTTP ${response.status}, ${text.slice(0, 160)})`);
    }
    return { bytes: bytes.byteLength, cacheState: response.headers.get('x-nextjs-cache') };
  } finally { clearTimeout(timeout); }
}

try {
  if ((fixture.counts.get('boot') || 0) !== 0) throw new Error('Middleware must not execute during the build.');
  server = await startServer(fixture.root, ['--workers', '1']);
  const initialMemory = await memory();
  const results = [];
  let afterMiddlewareIdle;
  for (const endpoint of endpoints) {
    const bootBefore = fixture.counts.get('boot') || 0;
    const firstStarted = performance.now();
    const first = await read(endpoint);
    const firstRequestMs = performance.now() - firstStarted;
    const firstBootRequests = (fixture.counts.get('boot') || 0) - bootBefore;
    for (let index = 0; index < warmupRequests; index++) await read(endpoint);
    const bootBeforeTimed = fixture.counts.get('boot') || 0;
    const samples = [], errorSamples = [];
    let issued = 0, errors = 0, totalBytes = 0;
    const started = performance.now(), deadline = started + secondsPerEndpoint * 1000;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline && issued < maxRequestsPerEndpoint) {
        issued++;
        const tick = performance.now();
        try { const result = await read(endpoint); totalBytes += result.bytes; }
        catch (error) { errors++; if (errorSamples.length < 3) errorSamples.push(error.message); }
        samples.push(performance.now() - tick);
      }
    }));
    const elapsedMs = performance.now() - started;
    samples.sort((a, b) => a - b);
    const rss = await memory();
    const bootOriginRequests = fixture.counts.get('boot') || 0;
    const warmBootRequests = bootOriginRequests - bootBeforeTimed;
    const workerCountMatches = rss.nodeProcesses === endpoint.expectedNodes && rss.childProcesses === endpoint.expectedNodes;
    const bootCountMatches = bootOriginRequests === endpoint.expectedBoots && warmBootRequests === 0;
    results.push({ label: endpoint.label, endpoint: endpoint.pathname, expectedStatus: endpoint.status,
      requests: samples.length, errors, ...(errorSamples.length ? { errorSamples } : {}),
      firstRequestMs: +firstRequestMs.toFixed(2), firstCacheState: first.cacheState, firstBootRequests,
      elapsedMs: +elapsedMs.toFixed(1), requestsPerSecond: Math.round(samples.length * 1000 / elapsedMs),
      p50Ms: +(samples[Math.floor(samples.length * .5)] || 0).toFixed(2),
      p95Ms: +(samples[Math.floor(samples.length * .95)] || 0).toFixed(2),
      meanResponseBytes: samples.length ? Math.round(totalBytes / samples.length) : 0,
      bootOriginRequests, warmBootRequests, bootCountMatches, workerCountMatches,
      checksPassed: errors === 0 && bootCountMatches && workerCountMatches && samples.length > 0,
      requestCapReached: issued === maxRequestsPerEndpoint, ...rss,
    });
    if (endpoint.pathname === '/mw/static') {
      await delay(middlewareIdleSeconds * 1000);
      const tick = performance.now();
      const cached = await read(endpoints[0]);
      const requestMs = performance.now() - tick;
      const idleRss = await memory();
      const boots = fixture.counts.get('boot') || 0;
      afterMiddlewareIdle = { idleSeconds: middlewareIdleSeconds, endpoint: '/static', cacheState: cached.cacheState,
        requestMs: +requestMs.toFixed(2), bootOriginRequests: boots, ...idleRss,
        checksPassed: cached.cacheState === 'HIT' && boots === 1 && idleRss.childProcesses === 0 };
    }
  }
  const checksPassed = initialMemory.childProcesses === 0 && afterMiddlewareIdle?.checksPassed && results.every(result => result.checksPassed);
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, node: process.version, requestWorkers: 1, middlewareWorkers: 1,
    concurrency, secondsPerEndpoint, warmupRequests, maxRequestsPerEndpoint, encoding: 'identity', redirects: 'manual',
    rscWorkerThreadsExpected: 0,
    memory: 'RSS sampled after startup, each workload and a 31 s middleware-idle interval; not peak. Includes the native server and descendant Node processes, excludes benchmark client, local origin and build. These workloads do not require RSC worker threads; threads are not individually measured.',
    limitations: 'Local HTTP microbenchmark, no Next.js comparison or production-capacity claim. Five workloads share one instance in order. Cached reads initially avoid Node; middleware starts one Node process, which retires before a verified static HIT; final passthrough starts middleware and API processes. The local origin records middleware module initialization only, not an artificial per-request I/O delay. Response validation is included in timing. At most 100000 timed requests plus 21 first/warmup requests per workload and one post-idle cache check.',
    checksPassed, initialMemory, afterMiddlewareIdle, results }, null, 2));
  if (!checksPassed) process.exitCode = 1;
} finally { await server?.close(); await fixture.remove(); }
