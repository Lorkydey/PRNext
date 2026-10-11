'use strict';
// Run only after the parent releases the HTTP benchmark window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const observer = path.resolve(__dirname, 'gc-observer-v5.cjs');

function probe(source, environment = {}, before) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prnext-gc-observer-v5-'));
  try {
    before?.(directory);
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', source], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
      env: { ...process.env, ...environment, PRNEXT_GC_OBSERVER_DIR: directory,
        NODE_OPTIONS: `--require "${observer.replaceAll('\\', '/')}"` },
    });
    const traces = fs.readdirSync(directory).filter(file => file.endsWith('.jsonl')).map(file => {
      const bytes = fs.readFileSync(path.join(directory, file));
      return { file, bytes: bytes.length, rows: bytes.toString().trim().split('\n').map(line => JSON.parse(line)) };
    });
    return { child, traces };
  } finally {
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(absolute.startsWith(temporary) && path.basename(absolute).startsWith('prnext-gc-observer-v5-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}

test('observer timer does not keep a finished Node process alive', () => {
  const { child, traces } = probe('process.stdout.write("completed");');
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'completed');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].rows.at(-1).reason, 'isolate-exit');
});

test('NODE_OPTIONS preload records the host and an explicit-execArgv RSC-style worker independently', () => {
  const source = `
    const {Worker}=require('node:worker_threads');
    function allocate(){for(let n=0;n<20;n++){let a=Array.from({length:10000},(_,i)=>({i}));global.gc?.();}}
    const worker=new Worker('('+allocate.toString()+')();setTimeout(()=>{},1250)', {
      eval:true,execArgv:['--conditions=react-server'],env:{...process.env}
    });
    worker.once('error',error=>{console.error(error);process.exitCode=1;});
    allocate();
    setTimeout(()=>{},1250);
  `;
  const { child, traces } = probe(source);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(traces.length, 2);
  const starts = traces.map(trace => trace.rows[0]);
  assert.equal(new Set(starts.map(row => row.pid)).size, 1);
  assert.equal(new Set(starts.map(row => row.threadId)).size, 2);
  assert.equal(starts.filter(row => row.isMainThread).length, 1);
  assert.ok(starts.find(row => !row.isMainThread).execArgv.includes('--conditions=react-server'));
  let gcCount = 0;
  for (const trace of traces) {
    assert.ok(trace.bytes <= trace.rows[0].limits.maxBytes);
    assert.ok(trace.rows.length <= trace.rows[0].limits.maxRecords);
    assert.ok(trace.rows.some(row => row.event === 'sample' && row.heap.heapUsed > 0 && row.heap.heapTotal >= row.heap.heapUsed));
    assert.ok(trace.rows.every(row => !row.heap || !Object.hasOwn(row.heap, 'rss')));
    for (const entry of Object.values(trace.rows.at(-1).gc)) {
      assert.ok(entry.count >= 0 && entry.durationMs >= 0);
      gcCount += entry.count;
    }
  }
  assert.ok(gcCount > 0, 'real GC PerformanceEntries must reach the counters');
});

test('trace record cap stops observation with a durable explicit reason', () => {
  const { child, traces } = probe('setTimeout(()=>{},2300)', { PRNEXT_GC_MAX_RECORDS: '4' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(traces[0].rows.length, 4);
  assert.equal(traces[0].rows.at(-1).reason, 'trace-limit');
});

test('duration cap stops the unref sampler without terminating legitimate work', () => {
  const { child, traces } = probe('setTimeout(()=>process.stdout.write("late work completed"),1300)', { PRNEXT_GC_MAX_MILLIS: '1000' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'late work completed');
  assert.equal(traces[0].rows.at(-1).reason, 'duration-limit');
});

test('shared file quota refuses more isolates without overwriting prior claims', () => {
  const { child, traces } = probe('', { PRNEXT_GC_MAX_FILES: '2' }, directory => {
    fs.writeFileSync(path.join(directory, 'slot-0.claim'), 'prior-isolate-0', { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'slot-1.claim'), 'prior-isolate-1', { flag: 'wx' });
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /trace-file limit reached/);
  assert.equal(traces.length, 0);
});
