import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import { isrFixture } from '../tests/isr-fixture.mjs';
import { startServer } from '../tests/support.mjs';

const concurrency = 4, secondsPerEndpoint = 3, originDelayMs = 10;
const fixture = await isrFixture({ originDelayMs });
let server;
async function memory() {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([server.child.pid]);
  for (let pass = 0; pass < 5; pass++) for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  return {
    rustRssMiB: +((rows.find(row => row[0] === server.child.pid)?.[2] || 0) / 1024).toFixed(1),
    totalRssMiB: +(rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0) / 1024).toFixed(1),
    nodeProcesses: pids.size - 1,
  };
}
try {
  server = await startServer(fixture.root, ['--workers', '1']);
  const results = [];
  let afterMaintenanceIdle;
  for (const [label, endpoint, key] of [
    ['Build-generated HTML', '/seed', 'seed'],
    ['Runtime-generated HTML', '/blocking/benchmark', 'blocking/benchmark'],
    ['Runtime-generated data', `/_rustyx/data/${fixture.manifest.buildId}/blocking/benchmark.json`, 'blocking/benchmark'],
    ['Uncached SSR', '/server', 'server'],
  ]) {
    const firstStart = performance.now();
    await (await fetch(server.url + endpoint)).arrayBuffer();
    const coldMs = performance.now() - firstStart;
    const before = fixture.counts.get(key) || 0;
    const samples = [];
    let errors = 0;
    const started = performance.now(), until = started + secondsPerEndpoint * 1000;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < until) {
        const tick = performance.now();
        try {
          const response = await fetch(server.url + endpoint);
          await response.arrayBuffer();
          if (!response.ok) errors++;
        } catch { errors++; }
        samples.push(performance.now() - tick);
      }
    }));
    const elapsedMs = performance.now() - started;
    samples.sort((a, b) => a - b);
    results.push({ label, requests: samples.length, errors, coldMs: +coldMs.toFixed(2),
      requestsPerSecond: Math.round(samples.length * 1000 / elapsedMs),
      p50Ms: +samples[Math.floor(samples.length * .5)].toFixed(2), p95Ms: +samples[Math.floor(samples.length * .95)].toFixed(2),
      warmOriginRequests: (fixture.counts.get(key) || 0) - before, ...await memory() });
    if (label === 'Runtime-generated data') {
      await delay(31_000);
      const response = await fetch(server.url + '/blocking/benchmark');
      await response.arrayBuffer();
      afterMaintenanceIdle = { idleSeconds: 31, cacheState: response.headers.get('x-nextjs-cache'), ...await memory() };
    }
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, node: process.version, requestWorkers: 1, maintenanceWorkers: 1, concurrency, secondsPerEndpoint, originDelayMs,
    limitations: 'Local HTTP microbenchmark with a deliberately delayed 10 ms origin; no Next.js comparison. Workloads share one instance in order. Cold runtime generation starts a maintenance Node worker; a 31 s pause after the data workload measures its retirement before uncached SSR starts a request worker. RSS sampled after each workload, not peak; excludes client, origin and build.',
    afterMaintenanceIdle, results }, null, 2));
} finally { await server?.close(); await fixture.remove(); }
