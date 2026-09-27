import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { repositoryRoot, startServer } from '../tests/support.mjs';

const help = `Usage: node scripts/bench-node-heap.mjs [--smoke]
Compares Node's adaptive default with --max-semi-space-size=4 and =8.
Requires installed npm dependencies, the release PRNext binary, and ps (macOS/Linux).
Builds and removes a temporary App project; stdout is the result JSON.
BENCH_REPETITIONS=3 BENCH_SECONDS=3 BENCH_CONCURRENCY=4 override the defaults.
--smoke uses one repetition, 0.1 seconds and two warmups per workload.
Run with NODE_OPTIONS unset; production worker flags are never modified.`;
if (process.argv.includes('--help')) { console.log(help); process.exit(0); }
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error(help);
const smoke = process.argv.includes('--smoke');
const repetitions = Number(process.env.BENCH_REPETITIONS || (smoke ? 1 : 3));
const seconds = Number(process.env.BENCH_SECONDS || (smoke ? 0.1 : 3));
const concurrency = Number(process.env.BENCH_CONCURRENCY || 4);
const warmups = smoke ? 2 : 10;
const originalOptions = process.env.NODE_OPTIONS;
if (originalOptions?.trim()) throw new Error('Run with NODE_OPTIONS unset for an unmodified adaptive baseline.');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 ||
    !Number.isFinite(seconds) || seconds <= 0 || seconds > 60 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid benchmark options');
if (!['darwin', 'linux'].includes(os.platform())) throw new Error('This benchmark requires macOS or Linux ps.');

const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'rustyx-node-heap-'));
const preload = path.join(root, 'heap-probe.cjs');
const results = [];
let server;
const variants = ['default', '4', '8'];
const orders = [['default', '4', '8'], ['8', 'default', '4'], ['4', '8', 'default']];
const endpoints = [
  { id: 'json', path: '/api/echo', description: '4096 new nested objects, sort and JSON serialization' },
  { id: 'ssr', path: '/', description: '1400 React/clsx table rows through App HTML rendering' },
  { id: 'flight', path: '/', headers: { RSC: '1' }, description: 'The same React table through Flight' },
];
const round = value => +value.toFixed(3);

async function write(file, value) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
}

async function fingerprint() {
  const hash = createHash('sha256');
  for (const directory of ['runtime', 'compat', 'server']) {
    for (const file of (await readdir(path.join(root, '.prnext', directory))).sort()) {
      if (!/\.(?:mjs|cjs)$/.test(file)) continue;
      hash.update(`${directory}/${file}\0`);
      hash.update(await readFile(path.join(root, '.prnext', directory, file)));
    }
  }
  return hash.digest('hex');
}

async function residentMemory() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const pids = new Set([server.child.pid]);
  for (;;) {
    const before = pids.size;
    for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
    if (pids.size === before) break;
  }
  const native = rows.find(([pid]) => pid === server.child.pid);
  if (!native || pids.size !== 2) throw new Error('Expected one native server and one persistent Node child');
  return {
    rustRssMiB: round(native[2] / 1024),
    nodeRssMiB: round(rows.filter(([pid]) => pid !== server.child.pid && pids.has(pid)).reduce((sum, row) => sum + row[2], 0) / 1024),
  };
}

function latestDiagnostics(endpoint) {
  const latest = new Map(), processes = new Set();
  for (const line of server.output().split('\n')) {
    if (!line.startsWith('PRNEXT_HEAP ')) continue;
    const record = JSON.parse(line.slice('PRNEXT_HEAP '.length));
    processes.add(record.pid);
    latest.set(record.threadId, record);
  }
  if (processes.size !== 1 || !latest.has(0) || latest.size !== (endpoint === 'json' ? 1 : 2) ||
      (endpoint !== 'json' && !latest.has(1))) {
    throw new Error('Missing heap diagnostics or Node worker restarted during the workload');
  }
  return [...latest.values()].map(({ threadId, heapUsed, heapTotal, external, arrayBuffers, newSpace, gc }) => ({
    threadId, heapUsedMiB: round(heapUsed / 1048576), heapTotalMiB: round(heapTotal / 1048576),
    externalMiB: round(external / 1048576), arrayBuffersMiB: round(arrayBuffers / 1048576),
    newSpaceMiB: round(newSpace / 1048576), gc: { ...gc, ms: round(gc.ms) },
  }));
}

async function request(endpoint, validateContent = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Benchmark request timed out')), 30_000);
  try {
    const response = await fetch(server.url + endpoint.path, {
      headers: { 'accept-encoding': 'identity', ...endpoint.headers }, signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    if (response.status !== 200 || body.byteLength < 500_000) throw new Error(`Unexpected ${endpoint.id} response: ${response.status}, ${body.byteLength} bytes`);
    if (validateContent) {
      const text = new TextDecoder().decode(body);
      if (endpoint.id === 'json') {
        const value = JSON.parse(text);
        if (value.total !== 4096 || value.rows?.length !== 4096 ||
            value.rows.some((row, index) => !Number.isInteger(row.id) || !row.description?.startsWith('Description ') ||
              (index > 0 && row.metrics.score > value.rows[index - 1].metrics.score))) {
          throw new Error('JSON workload did not construct and sort all 4096 objects');
        }
      } else if (!text.includes('Allocation benchmark') || !text.includes('Product 1399') ||
          (endpoint.id === 'ssr' && (text.match(/<tr\b/g) || []).length !== 1400)) {
        throw new Error(`${endpoint.id} workload did not render the complete table`);
      }
    }
    return body.byteLength;
  } finally { clearTimeout(timer); }
}

try {
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await write('package.json', JSON.stringify({ name: 'rustyx-node-heap-fixture', private: true, type: 'module' }));
  await write('app/layout.jsx', 'export default function Layout({children}){return <html lang="en"><body>{children}</body></html>}');
  await write('app/api/echo/route.js', `export const dynamic='force-dynamic';
export function GET(){
  const rows=Array.from({length:4096},(_,id)=>({id,label:'Item '+id,group:'group-'+(id%37),active:id%3===0,
    tags:['tag-'+id%7,'region-'+id%13,'stock-'+id%17],metrics:{price:id*1.17,quantity:id%100,score:(id*37)%101},
    description:('Description '+id+' ').repeat(7)}));
  rows.sort((a,b)=>b.metrics.score-a.metrics.score);return Response.json({rows,total:rows.length});
}`);
  await write('app/page.jsx', `import React from 'react';import clsx from 'clsx';
export const dynamic='force-dynamic';const h=React.createElement;
function Row({row}){return h('tr',{className:clsx('row',row.id%2&&'alternate',{'available':row.active})},
  h('td',null,h('a',{href:'/items/'+row.id},row.label)),h('td',null,h('strong',null,row.group)),
  h('td',null,row.tags.map(tag=>h('span',{key:tag,className:'tag'},tag))),
  h('td',null,h('span',null,row.metrics.price.toFixed(2))),h('td',null,h('em',null,row.description)));}
export default function LargeTree(){
  const rows=Array.from({length:1400},(_,id)=>({id,label:'Product '+id,group:'group-'+id%37,active:id%3===0,
    tags:['tag-'+id%7,'region-'+id%13,'stock-'+id%17],metrics:{price:id*1.17,quantity:id%100,score:(id*37)%101},
    description:('Description '+id+' ').repeat(4)}));
  return h('main',null,h('h1',null,'Allocation benchmark'),h('table',null,h('tbody',null,rows.map(row=>h(Row,{key:row.id,row})))));
}`);
  await write('heap-probe.cjs', `const v8=require('node:v8'),{threadId}=require('node:worker_threads');
const{PerformanceObserver}=require('node:perf_hooks'),{writeSync}=require('node:fs');
const gc={count:0,ms:0,minor:0,major:0};
new PerformanceObserver(list=>{for(const item of list.getEntries()){gc.count++;gc.ms+=item.duration;
  if(item.detail.kind===1)gc.minor++;if(item.detail.kind===4)gc.major++;}}).observe({entryTypes:['gc']});
function snapshot(){const m=process.memoryUsage();writeSync(2,'PRNEXT_HEAP '+JSON.stringify({
  pid:process.pid,threadId,heapUsed:m.heapUsed,heapTotal:m.heapTotal,external:m.external,arrayBuffers:m.arrayBuffers,
  newSpace:v8.getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_size,gc:{...gc}})+'\\n');}
snapshot();setInterval(snapshot,500).unref();`);
  await exec(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', root], { maxBuffer: 4 * 1024 * 1024 });
  const sourceHash = await fingerprint();
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const variant of orders[(repetition - 1) % orders.length]) {
      process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}${variant === 'default' ? '' : ` --max-semi-space-size=${variant}`}`;
      server = await startServer(root, ['--workers', '1']);
      try {
        for (const endpoint of endpoints) {
          for (let index = 0; index < warmups; index++) await request(endpoint, index === 0);
          const samples = [], sizes = new Set();
          const started = performance.now(), until = started + seconds * 1000;
          let errors = 0;
          await Promise.all(Array.from({ length: concurrency }, async () => {
            while (performance.now() < until) {
              const tick = performance.now();
              try { sizes.add(await request(endpoint)); } catch (error) { errors++; console.error(error.message); }
              samples.push(performance.now() - tick);
            }
          }));
          const elapsedMs = performance.now() - started;
          await delay(550);
          samples.sort((a, b) => a - b);
          results.push({ repetition, variant, workload: endpoint.id, requests: samples.length, errors,
            requestsPerSecond: round(samples.length * 1000 / elapsedMs), p95Ms: round(samples[Math.floor(samples.length * 0.95)]),
            bodyBytes: [...sizes].sort((a, b) => a - b), ...await residentMemory(), isolates: latestDiagnostics(endpoint.id) });
          console.error(`Completed repetition ${repetition}, ${variant}, ${endpoint.id}`);
        }
      } finally { await server.close(); server = undefined; }
    }
  }
  const summary = endpoints.flatMap(endpoint => variants.map(variant => {
    const rows = results.filter(row => row.variant === variant && row.workload === endpoint.id);
    const metrics = {};
    for (const key of ['requestsPerSecond', 'p95Ms', 'rustRssMiB', 'nodeRssMiB']) {
      const values = rows.map(row => row[key]);
      metrics[key] = { mean: round(values.reduce((a, b) => a + b, 0) / values.length), min: Math.min(...values), max: Math.max(...values) };
    }
    return { workload: endpoint.id, variant, ...metrics };
  }));
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), smoke, platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, memoryGiB: round(os.totalmem() / 1073741824), node: process.version, sourceHash,
    repetitions, secondsPerEndpoint: seconds, concurrency, warmups, workers: 1, orders, endpoints,
    instrumentation: '500 ms V8/process heap samples and GC PerformanceObserver per isolate; ps RSS 550 ms after load; no forced GC.',
    memory: 'RSS is resident memory after each workload, not peak/live objects; Node RSS includes RSC threads once. Heap/external diagnostics are per-isolate; arrayBuffers is included in external.',
    gc: 'Counters are cumulative since each isolate started. Workloads share the server in JSON, SSR, Flight order; later counters include previous workloads and warmups. GC milliseconds are not a sum of process wall-clock pauses.',
    limitations: 'Local client and server share one host. Three-second microbenchmarks do not predict all npm applications or container memory limits. Content validation occurs during warmup; timed requests check HTTP status, minimum size and consume the full body. Current compiler may add framework bytes relative to the historical hand-assembled fixture. Smoke validates execution only.',
    checksPassed: results.every(row => row.errors === 0), summary, results }, null, 2));
  if (results.some(row => row.errors)) process.exitCode = 1;
} finally {
  if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalOptions;
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
