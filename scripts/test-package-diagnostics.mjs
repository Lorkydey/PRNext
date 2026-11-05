// Failure-only package harness diagnostics. Never writes raw npm output or config.
import { performance } from 'node:perf_hooks';
import { opendir, open, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const diagnosticLimits = Object.freeze({ requests: 64, commands: 24, logs: 3, logBytes: 48 * 1024, timingBytes: 256 * 1024, timings: 24, fetches: 24, outputBytes: 64 * 1024 });
const phases = new Set(['preparing', 'npm-pack', 'npm-install', 'npm-exec', 'npm-run', 'npm-command']);
const codes = new Set(['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ERR_ASSERTION', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EINTEGRITY', 'ERESOLVE', 'ETARGET', 'E404', 'E403', 'E500', 'E503', 'ERR_SOCKET_TIMEOUT']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBREAK', 'SIGHUP', 'SIGQUIT']);
const timings = new Set(['npm', 'command:install', 'idealTree', 'idealTree:init', 'idealTree:userRequests', 'idealTree:buildDeps', 'idealTree:fixDepFlags', 'idealTree:inflate', 'reify', 'reify:loadTrees', 'reify:diffTrees', 'reify:retireShallow', 'reify:createSparse', 'reify:loadBundles', 'reify:unpack', 'reify:unretire', 'reify:build', 'reify:trash', 'reify:save', 'reify:copy', 'reify:rollback:retireShallow', 'reify:rollback:createSparse', 'reify:rollback:unretire']);
const version = value => typeof value === 'string' && /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const milliseconds = value => Math.round(Math.min(finite(value) ? value : 0, 86400000) * 1000) / 1000;
const get = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
const outputBytes = value => typeof value === 'string' || Buffer.isBuffer(value) ? Buffer.byteLength(value) : 0;
const push = (array, record, maximum) => { if (array.length === maximum) array.shift(); array.push(record); };

export function safeExecFailure(error) {
  const code = get(error, 'code'), signal = get(error, 'signal'), name = get(error, 'name');
  return {
    name: ['Error', 'TypeError', 'RangeError', 'AssertionError'].includes(name) ? name : 'Error',
    code: Number.isSafeInteger(code) && Math.abs(code) <= 2147483647 ? code : codes.has(code) ? code : null,
    signal: signals.has(signal) ? signal : null,
    killed: get(error, 'killed') === true,
    stdoutBytes: outputBytes(get(error, 'stdout')),
    stderrBytes: outputBytes(get(error, 'stderr')),
  };
}

// Parse only known numerical npm timings, versions, error codes and HTTP origin
// categories. Paths, URLs, package/config text and arbitrary messages are omitted.
export function summarizeNpmLog(text) {
  const summary = { node: null, npm: null, codes: [], timings: [], fetches: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const using = /\binfo using (node|npm)@([^\s]+)\s*$/.exec(line);
    if (using && version(using[2])) summary[using[1]] = using[2];
    const timing = /\btiming (\S+) Completed in (\d{1,10})ms\s*$/.exec(line);
    if (timing && timings.has(timing[1])) push(summary.timings, { phase: timing[1], elapsedMs: milliseconds(Number(timing[2])) }, diagnosticLimits.timings);
    const failure = /\berror code (\S+)\s*$/.exec(line);
    if (failure && codes.has(failure[1]) && !summary.codes.includes(failure[1])) summary.codes.push(failure[1]);
    const fetch = /\bhttp fetch (GET|HEAD) ([1-5]\d\d) (\S+) (\d{1,10})ms(?:\s|$)/.exec(line);
    if (fetch) {
      try {
        const url = new URL(fetch[3]);
        if (url.username || url.password || url.search || url.hash) continue;
        const origin = url.origin === 'https://registry.npmjs.org' ? 'public-npm' : url.protocol === 'http:' && url.hostname === '127.0.0.1' ? 'loopback' : null;
        if (origin) push(summary.fetches, { method: fetch[1], status: Number(fetch[2]), origin, elapsedMs: milliseconds(Number(fetch[4])) }, diagnosticLimits.fetches);
      } catch {}
    }
  }
  return summary;
}

// Reads at most three regular files: 48 KiB debug tails or whole timing JSON
// bounded to 256 KiB. Only complete allowlisted metadata is returned.
export async function collectNpmLogMetadata(cache) {
  const directory = path.join(cache, '_logs'), candidates = [];
  let entries;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    entries = await opendir(directory);
    for await (const entry of entries) {
      if (!entry.isFile() || !/^[0-9TZ_.-]+-(?:debug-\d+\.log|timing\.json)$/.test(entry.name)) continue;
      candidates.push(entry.name); candidates.sort();
      if (candidates.length > diagnosticLimits.logs) candidates.shift();
    }
  } catch { return []; }
  const result = [];
  for (const name of candidates) {
    let handle;
    try {
      const file = path.join(directory, name), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      handle = await open(file, 'r');
      const size = (await handle.stat()).size;
      if (!Number.isSafeInteger(size) || size < 0) continue;
      const maximum = name.endsWith('timing.json') ? diagnosticLimits.timingBytes : diagnosticLimits.logBytes;
      if (name.endsWith('timing.json') && size > maximum) continue;
      const bytes = Buffer.alloc(Math.min(size, maximum));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      const text = bytes.subarray(0, bytesRead).toString('utf8');
      let summary;
      if (name.endsWith('timing.json')) {
        summary = { timings: [], unfinished: [] };
        const value = JSON.parse(text);
        for (const phase of timings) {
          const elapsed = get(get(value, 'timers'), phase);
          if (finite(elapsed)) push(summary.timings, { phase, elapsedMs: milliseconds(elapsed) }, diagnosticLimits.timings);
          const unfinished = get(value, 'unfinishedTimers');
          if ((Array.isArray(unfinished) && unfinished.includes(phase)) || (unfinished && typeof unfinished === 'object' && !Array.isArray(unfinished) && Object.hasOwn(unfinished, phase))) push(summary.unfinished, phase, diagnosticLimits.timings);
        }
      } else summary = summarizeNpmLog(text);
      result.push({ kind: name.endsWith('timing.json') ? 'timing' : 'debug', totalBytes: size, inspectedBytes: bytesRead, tailOnly: size > bytesRead, summary });
    } catch {} finally { try { await handle?.close(); } catch {} }
  }
  return result;
}

export function createPackageDiagnostics({ strategy, platform, nodeVersion = process.version, allowedPackages = [], now = () => performance.now() }) {
  const started = now(), commands = [], requests = [], allowed = new Set(allowedPackages);
  let completedChecks = 0, requestCount = 0, commandCount = 0, currentPhase = 'preparing';
  const elapsed = () => milliseconds(now() - started);
  return {
    completed(count) { if (Number.isSafeInteger(count) && count >= 0 && count <= 100) { completedChecks = count; currentPhase = 'after-check-' + count; } },
    beginCommand(phase, options = {}) {
      const record = { phase: phases.has(phase) ? phase : 'npm-command', startedMs: elapsed(), timeoutMs: finite(options.timeout) ? milliseconds(options.timeout) : null, maxBuffer: Number.isSafeInteger(options.maxBuffer) && options.maxBuffer > 0 ? Math.min(options.maxBuffer, 16 * 1024 ** 2) : null, state: 'running' };
      currentPhase = record.phase; commandCount++; push(commands, record, diagnosticLimits.commands);
      return error => { record.elapsedMs = milliseconds(elapsed() - record.startedMs); record.state = error ? 'failed' : 'completed'; if (error) record.failure = safeExecFailure(error); };
    },
    registry(method, packageName) {
      const record = { method: ['GET', 'HEAD'].includes(method) ? method : 'other', package: allowed.has(packageName) ? packageName : 'other', startedMs: elapsed(), state: 'pending' };
      requestCount++; push(requests, record, diagnosticLimits.requests);
      return (event, status) => {
        if (record.state !== 'pending') return;
        if (!['finished', 'closed', 'aborted'].includes(event)) return;
        record.state = event; record.elapsedMs = milliseconds(elapsed() - record.startedMs);
        record.status = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
      };
    },
    async persistFailure({ error, cache, directory }) {
      try {
        const report = {
          schemaVersion: 1, outcome: 'failed', strategy: ['hoisted', 'nested'].includes(strategy) ? strategy : 'unknown',
          platform: /^(?:darwin|linux|win32)-(?:x64|arm64)(?:-(?:gnu|msvc))?$/.test(platform) ? platform : 'unknown',
          node: version(nodeVersion), phase: currentPhase, elapsedMs: elapsed(), completedChecks, failure: safeExecFailure(error),
          commandCount, commandsOmitted: Math.max(0, commandCount - commands.length), commands,
          registryRequestCount: requestCount, registryRequestsOmitted: Math.max(0, requestCount - requests.length), registryRequests: requests,
          npmLogs: await collectNpmLogMetadata(cache),
        };
        const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
        if (bytes.length > diagnosticLimits.outputBytes) return false;
        await mkdir(directory, { recursive: true });
        const target = await mkdtemp(path.join(directory, `${report.platform}-${report.strategy}-`));
        await writeFile(path.join(target, 'diagnostic.json'), bytes, { flag: 'wx' });
        return true;
      } catch { return false; }
    },
  };
}

// Observation must never change a command's result or replace its original error.
export async function observePackageCommand(diagnostics, phase, options, operation) {
  let finish;
  try { finish = diagnostics.beginCommand(phase, options); } catch {}
  try {
    const result = await operation();
    try { finish?.(); } catch {}
    return result;
  } catch (error) {
    try { finish?.(error); } catch {}
    throw error;
  }
}
