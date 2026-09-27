import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { startServer, repositoryRoot } from '../tests/support.mjs';

const exec = promisify(execFile);
const concurrency = Number(process.env.BENCH_CONCURRENCY || 4);
const duration = Number(process.env.BENCH_SECONDS || 3);
const project = path.resolve(repositoryRoot, process.env.BENCH_PROJECT || 'examples/basic');
const endpoints = process.env.BENCH_ENDPOINTS ? JSON.parse(process.env.BENCH_ENDPOINTS) : project === path.join(repositoryRoot, 'examples/app')
  ? [{ path: '/', label: 'App HTML' }, { path: '/api/echo', label: 'App API' }, { path: '/items/alpha?tag=benchmark', label: 'App Flight', headers: { RSC: '1' } }]
  : [{ path: '/', label: 'Pages static' }, { path: '/api/hello', label: 'Pages API' }, { path: '/server?name=benchmark', label: 'Pages SSR' }];
if (!Array.isArray(endpoints) || !endpoints.length || endpoints.some(endpoint => !endpoint || typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/') || endpoint.path.startsWith('//'))) throw new Error('BENCH_ENDPOINTS must be a non-empty JSON array of {path, label?, headers?}');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 512 || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid BENCH_CONCURRENCY or BENCH_SECONDS');
await exec(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', project]);
const server = await startServer(project);
async function memory() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([server.child.pid]);
  for (let i = 0; i < 5; i++) for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  return { rustRssMiB: (rows.find(row => row[0] === server.child.pid)?.[2] || 0) / 1024, totalRssMiB: rows.reduce((total, [pid, , rss]) => total + (pids.has(pid) ? rss : 0), 0) / 1024 };
}
try {
  const results = [];
  for (const endpoint of endpoints) {
    const options = { headers: endpoint.headers };
    for (let i = 0; i < 20; i++) await (await fetch(server.url + endpoint.path, options)).arrayBuffer();
    const samples = [];
    let errors = 0;
    const start = performance.now();
    const until = start + duration * 1000;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < until) {
        const tick = performance.now();
        try { const response = await fetch(server.url + endpoint.path, options); await response.arrayBuffer(); if (!response.ok) errors++; }
        catch { errors++; }
        samples.push(performance.now() - tick);
      }
    }));
    const elapsedSeconds = (performance.now() - start) / 1000;
    samples.sort((a, b) => a - b);
    const rss = await memory();
    results.push({ endpoint: endpoint.path, label: endpoint.label, requestHeaders: endpoint.headers, requests: samples.length, errors, requestsPerSecond: Math.round(samples.length / elapsedSeconds), p50Ms: +samples[Math.floor(samples.length * .5)].toFixed(2), p95Ms: +samples[Math.floor(samples.length * .95)].toFixed(2), ...Object.fromEntries(Object.entries(rss).map(([key, value]) => [key, +value.toFixed(1)])) });
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), project: path.relative(repositoryRoot, project), platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, node: process.version, concurrency, secondsPerEndpoint: duration, workers: 1, memory: 'RSS sampled after each workload; total includes native server and Node children, including their RSC worker threads. Client/build excluded. Not peak memory.', limitations: 'Local HTTP microbenchmark with client on same machine; no Next.js comparison; not a production capacity claim.', results }, null, 2));
} finally { await server.close(); }
