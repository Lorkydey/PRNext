import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { cacheFixture } from '../tests/cache-fixture.mjs';
import { startServer } from '../tests/support.mjs';

const samplesPerEndpoint = 200;
const concurrency = 4;
const originDelayMs = 10;
const fixture = await cacheFixture({ originDelayMs });
let server;
try {
  server = await startServer(fixture.root, ['--workers', '1']);
  const results = [];
  for (const [label, endpoint, key] of [
    ['Uncached fetch', '/api/raw?key=uncached', 'uncached'],
    ['Cached function', '/api/data?key=function', 'function'],
    ['Cached fetch', '/api/fetch?key=fetch', 'fetch'],
  ]) {
    const firstStart = performance.now();
    await (await fetch(server.url + endpoint)).arrayBuffer();
    const coldMs = performance.now() - firstStart;
    const before = fixture.counts.get(key) || 0;
    const samples = [];
    let issued = 0, errors = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (issued++ < samplesPerEndpoint) {
        const start = performance.now();
        try {
          const response = await fetch(server.url + endpoint);
          await response.arrayBuffer();
          if (!response.ok) errors++;
        } catch { errors++; }
        samples.push(performance.now() - start);
      }
    }));
    const elapsedMs = performance.now() - started;
    samples.sort((a, b) => a - b);
    results.push({ label, requests: samples.length, errors, coldMs: +coldMs.toFixed(2),
      requestsPerSecond: Math.round(samples.length * 1000 / elapsedMs),
      p50Ms: +samples[Math.floor(samples.length * .5)].toFixed(2),
      p95Ms: +samples[Math.floor(samples.length * .95)].toFixed(2),
      warmOriginRequests: (fixture.counts.get(key) || 0) - before });
  }
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([server.child.pid]);
  for (let pass = 0; pass < 5; pass++) for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  const memory = {
    rustRssMiB: +((rows.find(row => row[0] === server.child.pid)?.[2] || 0) / 1024).toFixed(1),
    totalRssMiB: +(rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0) / 1024).toFixed(1),
  };
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, node: process.version, workers: 1, concurrency, originDelayMs,
    limitations: 'Local microbenchmark with a deliberately delayed 10 ms origin. Measures avoided work, not a Next.js comparison. Client/origin/build excluded from RSS; sampled after workloads, not peak. First endpoint cold time includes starting the Node worker.',
    memory, results }, null, 2));
} finally { await server?.close(); await fixture.remove(); }
