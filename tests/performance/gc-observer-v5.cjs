'use strict';

// Diagnostic preload only; never imported by production runtime modules.
// NODE_OPTIONS=--require loads this in both the host and RSC Worker isolates.
// GC entry durations are elapsed event durations, NOT process/thread CPU time.
const directory = process.env.PRNEXT_GC_OBSERVER_DIR;
if (directory && !globalThis[Symbol.for('prnext.gc-observer-v5')]) {
  globalThis[Symbol.for('prnext.gc-observer-v5')] = true;
  const fs = require('node:fs');
  const path = require('node:path');
  const v8 = require('node:v8');
  const { PerformanceObserver, performance, constants } = require('node:perf_hooks');
  const { isMainThread, threadId, resourceLimits } = require('node:worker_threads');
  function setting(name, fallback, minimum, maximum) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  }
  const maxBytes = setting('PRNEXT_GC_MAX_BYTES', 512 * 1024, 16 * 1024, 4 * 1024 * 1024);
  const maxRecords = setting('PRNEXT_GC_MAX_RECORDS', 120, 4, 3600);
  const maxMillis = setting('PRNEXT_GC_MAX_MILLIS', 120000, 1000, 3600000);
  const maxFiles = setting('PRNEXT_GC_MAX_FILES', 64, 2, 256);
  if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('GC observer requires an existing absolute output directory');
  if (!PerformanceObserver.supportedEntryTypes.includes('gc')) throw new Error('GC performance entries are unavailable');

  // Exclusive claims bound the entire run even if workers repeatedly restart.
  // Claims are deliberately retained: a later isolate cannot reuse its quota.
  let claimed = false;
  for (let slot = 0; slot < maxFiles; slot++) {
    let claim;
    try { claim = fs.openSync(path.join(directory, `slot-${slot}.claim`), 'wx'); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { fs.writeSync(claim, JSON.stringify({ pid: process.pid, threadId })); }
    finally { fs.closeSync(claim); }
    claimed = true;
    break;
  }
  if (!claimed) throw new Error('GC observer trace-file limit reached; diagnostic is incomplete');
  const filename = path.join(directory, `${process.pid}-${threadId}.jsonl`);
  const fd = fs.openSync(filename, 'wx');
  const started = performance.now();
  const identity = { schema: 1, runId: process.env.PRNEXT_GC_RUN_ID || '', pid: process.pid, threadId, isMainThread };
  const names = new Map(['MAJOR', 'MINOR', 'MINOR_MARK_SWEEP', 'INCREMENTAL', 'WEAKCB']
    .map(name => [constants[`NODE_PERFORMANCE_GC_${name}`], name.toLowerCase()]).filter(([value]) => value !== undefined));
  const counters = Object.fromEntries([...new Set([...names.values(), 'unknown'])]
    .map(name => [name, { count: 0, durationMs: 0, maxDurationMs: 0 }]));
  let invalidEntries = 0, lastGcEndMonotonicMs = null;
  let bytesWritten = 0, recordsWritten = 0, closed = false, timer;
  const observer = new PerformanceObserver(list => consume(list.getEntries()));
  function consume(entries) {
    for (const entry of entries) {
      if (entry.entryType !== 'gc') continue;
      if (!Number.isFinite(entry.duration) || entry.duration < 0) { invalidEntries++; continue; }
      const stats = counters[names.get(entry.detail?.kind) || 'unknown'];
      stats.count++;
      stats.durationMs += entry.duration;
      stats.maxDurationMs = Math.max(stats.maxDurationMs, entry.duration);
      lastGcEndMonotonicMs = Math.max(lastGcEndMonotonicMs ?? 0, entry.startTime + entry.duration);
    }
  }
  function line(event, extra) {
    return JSON.stringify({ ...identity, event, unixMs: Date.now(), monotonicMs: performance.now(), ...extra }) + '\n';
  }
  function write(value) {
    const encoded = Buffer.from(value);
    let offset = 0;
    while (offset < encoded.length) offset += fs.writeSync(fd, encoded, offset, encoded.length - offset);
    bytesWritten += encoded.length;
    recordsWritten++;
  }
  function finish(reason) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    consume(observer.takeRecords());
    observer.disconnect();
    process.removeListener('exit', onExit);
    const value = line('stop', { reason, bytesBeforeStop: bytesWritten, recordsBeforeStop: recordsWritten, gc: counters, invalidEntries, lastGcEndMonotonicMs });
    try {
      if (recordsWritten < maxRecords && bytesWritten + Buffer.byteLength(value) <= maxBytes) write(value);
    } finally { fs.closeSync(fd); }
  }
  function emit(event, extra) {
    if (closed) return;
    const value = line(event, extra);
    // Reserve space and one record for an explicit stop reason/counters.
    if (recordsWritten >= maxRecords - 1 || bytesWritten + Buffer.byteLength(value) > maxBytes - 4096) return finish('trace-limit');
    write(value);
  }
  function sample() {
    if (closed) return;
    consume(observer.takeRecords());
    if (performance.now() - started >= maxMillis) return finish('duration-limit');
    const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
    emit('sample', {
      heap: { heapUsed, heapTotal, external, arrayBuffers },
      spaces: v8.getHeapSpaceStatistics().map(({ space_name, space_size, space_used_size }) => ({ name: space_name, size: space_size, used: space_used_size })),
      gc: counters, invalidEntries, lastGcEndMonotonicMs,
    });
  }
  function onExit() { finish('isolate-exit'); }
  emit('start', {
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    execPath: process.execPath, execArgv: process.execArgv, argv: process.argv,
    timeOrigin: performance.timeOrigin, ppid: process.ppid, resourceLimits,
    v8CachedDataVersionTag: v8.cachedDataVersionTag(), heapSizeLimit: v8.getHeapStatistics().heap_size_limit,
    environment: Object.fromEntries(['NODE_ENV', 'NODE_OPTIONS', 'PRNEXT_PROFILE'].map(name => [name, process.env[name] ?? null])),
    gcKinds: Object.fromEntries(names), limits: { maxBytes, maxRecords, maxMillis, maxFiles, intervalMs: 1000 },
    gcDurationIsCpu: false, memoryScope: 'heap/external fields are isolate-local; shared process RSS intentionally omitted',
  });
  if (!closed) {
    observer.observe({ entryTypes: ['gc'] });
    process.once('exit', onExit);
    sample();
    if (!closed) timer = setInterval(sample, 1000).unref();
  }
}
