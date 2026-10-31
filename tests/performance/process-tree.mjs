import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const MAX_PROCESS_PIDS = 8192;
export const MAX_PROCESS_SAMPLES = 2048;
const commandOptions = { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 };
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const identity = row => `${row.pid}:${row.startId}`;
const genericLimitations = ['Point-in-time descendant observations can miss processes created and exited between samples.', 'Summed RSS includes shared resident pages in each process; it is not unique physical memory or a leak proof.'];

function requirePid(pid) { if (!validPid(pid)) throw new TypeError('A positive integer root PID is required.'); }
function unknown(rootPid, reason) {
  return { state: 'unknown', at: new Date().toISOString(), rootPid, processes: [], rssSumBytes: null, cpuSeconds: null, limitations: [reason, ...genericLimitations] };
}

/** Only numeric identities/counters survive parsing; command names are discarded. */
export function parseLinuxProcessStat(source, { clockTicks, pageSize }) {
  if (!nonnegative(clockTicks) || !clockTicks || !Number.isSafeInteger(pageSize) || pageSize <= 0 || source.length > 65536) throw Error('Invalid Linux process counters.');
  const prefix = /^(\d+) \(/.exec(source), end = source.lastIndexOf(')');
  const fields = source.slice(end + 2).trim().split(/\s+/);
  const pid = Number(prefix?.[1]), parent = Number(fields[1]), user = Number(fields[11]), system = Number(fields[12]), startId = fields[19], rss = Number(fields[21]);
  if (!prefix || end < prefix[0].length || !validPid(pid) || !Number.isSafeInteger(parent) || parent < 0 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(startId || '') || !Number.isSafeInteger(user) || user < 0 || !Number.isSafeInteger(system) || system < 0 || !Number.isSafeInteger(user + system) || !Number.isSafeInteger(rss) || rss < 0 || !Number.isSafeInteger(rss * pageSize)) throw Error('Invalid Linux process counters.');
  return { pid, parent, startId, cpuSeconds: (user + system) / clockTicks, rssBytes: rss * pageSize };
}

function cpuTime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw Error('Invalid process CPU time.');
  const result = Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
  if (!nonnegative(result)) throw Error('Invalid process CPU time.');
  return result;
}

export function parseMacProcessTable(source) {
  const rows = [];
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!match || rows.length >= MAX_PROCESS_PIDS) throw Error('Invalid or oversized macOS process table.');
    const pid = Number(match[1]), parent = Number(match[2]), rssBytes = Number(match[5]) * 1024;
    if (pid === 0 && parent === 0) continue; // The kernel task cannot descend from an owned userspace root.
    if (!validPid(pid) || !Number.isSafeInteger(parent) || parent < 0 || !Number.isSafeInteger(rssBytes)) throw Error('Invalid macOS process counters.');
    rows.push({ pid, parent, startId: match[3].replace(/\s+/g, ' '), cpuSeconds: cpuTime(match[4]), rssBytes });
  }
  if (!rows.length) throw Error('Empty macOS process table.');
  return rows;
}

/** Select the owned root and descendants from a bounded metadata-only snapshot. */
export function selectProcessTree(rows, rootPid) {
  requirePid(rootPid);
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_PROCESS_PIDS) throw Error('Incomplete process table.');
  const byPid = new Map(), children = new Map();
  for (const row of rows) {
    if (!validPid(row.pid) || !Number.isSafeInteger(row.parent) || row.parent < 0 || row.parent === row.pid || byPid.has(row.pid)) throw Error('Invalid process identity.');
    byPid.set(row.pid, row);
    if (!children.has(row.parent)) children.set(row.parent, []);
    children.get(row.parent).push(row);
  }
  if (!byPid.has(rootPid)) throw Error('Root process is not present.');
  const selected = [byPid.get(rootPid)], visited = new Set([rootPid]);
  for (let i = 0; i < selected.length; i++) for (const child of children.get(selected[i].pid) || []) {
    if (visited.has(child.pid)) throw Error('Cyclic process ancestry.');
    // Parent PIDs can outlive their original owner in stale metadata. A child
    // created before this incarnation of its alleged parent is not a proved
    // descendant. Linux ticks and Windows creation microseconds are ordered IDs.
    if (/^\d+$/.test(child.startId || '') && /^\d+$/.test(selected[i].startId || '') && BigInt(child.startId) < BigInt(selected[i].startId)) throw Error('A parent PID was reused.');
    visited.add(child.pid); selected.push(child);
  }
  if (selected.some(row => typeof row.startId !== 'string' || !row.startId.length || row.startId.length > 96)) throw Error('Incomplete owned process identity.');
  return selected.sort((a, b) => a.pid - b.pid);
}

export function processTreeObservation(rootPid, before, after, metrics = before, limitations = []) {
  requirePid(rootPid);
  const at = new Date().toISOString();
  try {
    const first = selectProcessTree(before, rootPid), last = selectProcessTree(after, rootPid);
    const byPid = new Map();
    if (!Array.isArray(metrics) || metrics.length > MAX_PROCESS_PIDS) throw Error('Incomplete process counters.');
    for (const row of metrics) {
      if (byPid.has(row.pid)) throw Error('Duplicate process counters.');
      byPid.set(row.pid, row);
    }
    const processes = [], reasons = [...limitations];
    if (first.length !== last.length || first.some((row, i) => identity(row) !== identity(last[i]) || row.parent !== last[i].parent)) reasons.push('Process membership or identity changed during observation.');
    for (const row of first) {
      const counter = byPid.get(row.pid);
      if (!counter || counter.startId !== row.startId || counter.parent !== row.parent || !nonnegative(counter.cpuSeconds) || !Number.isSafeInteger(counter.rssBytes) || counter.rssBytes < 0) {
        reasons.push('An owned process counter was missing, reused or unreadable.'); continue;
      }
      processes.push({ pid: row.pid, parent: row.parent, startId: row.startId, cpuSeconds: counter.cpuSeconds, rssBytes: counter.rssBytes });
    }
    const verified = !reasons.length;
    const rss = processes.reduce((sum, row) => sum + row.rssBytes, 0), cpu = processes.reduce((sum, row) => sum + row.cpuSeconds, 0);
    if (!Number.isSafeInteger(rss) || !nonnegative(cpu)) return unknown(rootPid, 'Process counters exceeded the numeric range.');
    return { state: verified ? 'verified' : 'unknown', at, rootPid, processes, rssSumBytes: verified ? rss : null, cpuSeconds: verified ? cpu : null, limitations: [...new Set([...reasons, ...genericLimitations])] };
  } catch { return unknown(rootPid, 'Process metadata was incomplete, invalid or the owned root disappeared.'); }
}

let linuxUnits;
async function linuxTable(units) {
  const ids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
  if (!ids.length || ids.length > MAX_PROCESS_PIDS) throw Error('Process snapshot limit exceeded.');
  const rows = [], failures = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(32, ids.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= ids.length) return;
      try { rows.push(parseLinuxProcessStat(await readFile(`/proc/${ids[index]}/stat`, 'utf8'), units)); }
      catch (error) { failures.push({ pid: Number(ids[index]), code: ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'INVALID' }); }
    }
  }));
  return { rows, failures };
}

export function linuxInspectionLimitations(rootPid, before, after) {
  let owned;
  try { owned = new Set(selectProcessTree(before.rows, rootPid).map(value => value.pid)); }
  catch { return ['The first Linux snapshot could not prove the owned ancestry.']; }
  const known = new Set(before.rows.map(value => value.pid));
  // An initial failed read has no trustworthy parent/start identity. It could
  // conceal an owned child, so never dismiss it as unrelated host churn.
  if (before.failures.length) return ['A Linux PID disappeared or was unreadable before its parent identity could be classified.'];
  if (after.failures.some(failure => !['ENOENT', 'ESRCH'].includes(failure.code) || !known.has(failure.pid) || owned.has(failure.pid))) return ['A Linux PID with owned or unclassified ancestry disappeared or could not be read.'];
  // Only an exit of a PID already proved outside the first owned tree can be
  // ignored. Owned membership/start identity is still compared independently
  // between both complete sets of readable rows by processTreeObservation.
  return [];
}

// Win32_Process supplies only parent/creation metadata. Counter reads are
// restricted to the owned tree; no command line, executable path or environment
// is queried. Recheck metadata after counters to catch exits/reuse during I/O.
function windowsScript(rootPid) {
  return `$ErrorActionPreference='Stop';$rootId=${rootPid};function Table{$all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate);if($all.Count -gt ${MAX_PROCESS_PIDS}){throw 'limit'};@($all|Where-Object{$_.ProcessId -gt 0}|ForEach-Object{$created=$null;if($_.CreationDate){$created=([decimal]::Truncate([decimal]$_.CreationDate.ToUniversalTime().Ticks/10)).ToString()};[pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;startId=$created}})};$before=@(Table);$owned=[System.Collections.Generic.HashSet[int]]::new();[void]$owned.Add($rootId);do{$added=$false;foreach($row in $before){if($owned.Contains($row.parent)-and $owned.Add($row.pid)){$added=$true}}}while($added);$rows=@();$failures=0;foreach($row in $before){if($owned.Contains($row.pid)){try{$p=Get-Process -Id $row.pid -ErrorAction Stop;$rows+=[pscustomobject]@{pid=$row.pid;parent=$row.parent;startId=([decimal]::Truncate([decimal]$p.StartTime.ToUniversalTime().Ticks/10)).ToString();cpuSeconds=[double]$p.TotalProcessorTime.TotalSeconds;rssBytes=[long]$p.WorkingSet64}}catch{$failures++}}};$after=@(Table);[pscustomobject]@{before=$before;after=$after;metrics=$rows;failures=$failures}|ConvertTo-Json -Depth 4 -Compress`;
}

/** Read-only sampling. No target process is signalled or modified. */
export async function observeProcessTree(rootPid) {
  requirePid(rootPid);
  try {
    if (process.platform === 'linux') {
      linuxUnits ||= Promise.all(['CLK_TCK', 'PAGESIZE'].map(name => execute('getconf', [name], commandOptions))).then(([ticks, pages]) => {
        const units = { clockTicks: Number(ticks.stdout.trim()), pageSize: Number(pages.stdout.trim()) };
        if (!Number.isSafeInteger(units.clockTicks) || units.clockTicks < 1 || !Number.isSafeInteger(units.pageSize) || units.pageSize < 1) throw Error('Unknown Linux counter units.');
        return units;
      });
      const units = await linuxUnits, before = await linuxTable(units), after = await linuxTable(units);
      return processTreeObservation(rootPid, before.rows, after.rows, before.rows, linuxInspectionLimitations(rootPid, before, after));
    }
    if (process.platform === 'win32') {
      const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsScript(rootPid)], commandOptions);
      const table = JSON.parse(stdout);
      return processTreeObservation(rootPid, table.before, table.after, table.metrics, table.failures ? ['An owned Windows process counter could not be read.'] : []);
    }
    if (process.platform === 'darwin') {
      const read = async () => parseMacProcessTable((await execute('/bin/ps', ['-ax', '-o', 'pid=,ppid=,lstart=,time=,rss='], { ...commandOptions, env: { ...process.env, LC_ALL: 'C' } })).stdout);
      return processTreeObservation(rootPid, await read(), await read(), undefined, ['macOS ps start identity has only one-second precision; same-second PID reuse cannot be excluded.']);
    }
    return unknown(rootPid, 'Process sampling is not implemented on this platform.');
  } catch { return unknown(rootPid, 'The bounded process inspection command or metadata read failed.'); }
}

function validateProcessSample(sample) {
  if (!sample || !['verified', 'unknown'].includes(sample.state) || !validPid(sample.rootPid) || typeof sample.at !== 'string' || !Number.isFinite(Date.parse(sample.at)) || !Array.isArray(sample.processes) || sample.processes.length > MAX_PROCESS_PIDS || !Array.isArray(sample.limitations) || sample.limitations.length > 32 || sample.limitations.some(value => typeof value !== 'string' || value.length > 512)) throw Error('Invalid retained process observation.');
  const pids = new Set(); let cpu = 0, rss = 0;
  for (const row of sample.processes) {
    if (!validPid(row.pid) || pids.has(row.pid) || !Number.isSafeInteger(row.parent) || row.parent < 0 || row.parent === row.pid || typeof row.startId !== 'string' || !row.startId.length || row.startId.length > 96 || !nonnegative(row.cpuSeconds) || !Number.isSafeInteger(row.rssBytes) || row.rssBytes < 0) throw Error('Invalid retained process counters.');
    pids.add(row.pid); cpu += row.cpuSeconds; rss += row.rssBytes;
  }
  if (!nonnegative(cpu) || !Number.isSafeInteger(rss)) throw Error('Retained process sums exceeded the numeric range.');
  if (sample.state === 'verified') {
    const owned = selectProcessTree(sample.processes, sample.rootPid);
    if (owned.length !== sample.processes.length || owned.some((row, i) => row.pid !== sample.processes[i].pid) || sample.cpuSeconds !== cpu || sample.rssSumBytes !== rss) throw Error('Retained owned ancestry or CPU/RSS sums do not match.');
  } else if (sample.cpuSeconds !== null || sample.rssSumBytes !== null) throw Error('Incomplete process observations cannot certify aggregate counters.');
}

export function summarizeProcessSamples(samples, { limitReached = false } = {}) {
  if (!Array.isArray(samples) || samples.length > MAX_PROCESS_SAMPLES || typeof limitReached !== 'boolean') throw Error('Invalid process sample count.');
  for (const sample of samples) validateProcessSample(sample);
  const first = samples[0], reasons = [];
  let stableProcessSet = samples.length >= 2;
  if (limitReached) reasons.push('The process sampling limit was reached; the interval is incomplete.');
  if (samples.length < 2) reasons.push('At least two complete observations are required.');
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i], previous = samples[i - 1];
    if (sample.state !== 'verified') { reasons.push('At least one process observation is incomplete.'); stableProcessSet = false; }
    if (sample.rootPid !== first.rootPid || sample.processes.length !== first.processes.length || sample.processes.some((row, j) => identity(row) !== identity(first.processes[j]) || row.parent !== first.processes[j].parent)) stableProcessSet = false;
    if (previous && sample.processes.some(row => { const before = previous.processes.find(value => identity(value) === identity(row)); return before && row.cpuSeconds < before.cpuSeconds; })) reasons.push('An owned CPU counter regressed.');
  }
  if (!stableProcessSet) reasons.push('The observed process set changed or was insufficient.');
  const verified = !reasons.length;
  return { state: verified ? 'verified' : 'unknown', samples, cpuSeconds: verified ? samples.at(-1).cpuSeconds - first.cpuSeconds : null, peakRssBytes: verified ? Math.max(...samples.map(value => value.rssSumBytes)) : null, stableProcessSet, limitations: [...new Set([...reasons, ...genericLimitations])] };
}

/** Serial observations, bounded storage, idempotent stop; no target cleanup. */
export function startProcessTreeSampling(rootPid, { intervalMs = 1000, observe = observeProcessTree } = {}) {
  requirePid(rootPid);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000 || typeof observe !== 'function') throw new TypeError('Invalid process sampling interval.');
  const samples = []; let timer, stopped = false, limitReached = false, stopping;
  const sample = async () => {
    if (samples.length >= MAX_PROCESS_SAMPLES) { limitReached = true; return; }
    let value;
    try { value = await observe(rootPid); } catch { value = unknown(rootPid, 'The process observer failed.'); }
    samples.push(value);
    return value;
  };
  let pending = sample();
  const schedule = () => {
    if (stopped) return;
    if (samples.length >= MAX_PROCESS_SAMPLES) { limitReached = true; return; }
    timer = setTimeout(() => { pending = sample(); pending.then(schedule); }, intervalMs);
    timer.unref?.();
  };
  pending.then(schedule);
  return { ready: pending, stop() {
    if (!stopping) {
      stopped = true; clearTimeout(timer);
      stopping = (async () => { await pending; await sample(); return { ...summarizeProcessSamples(samples, { limitReached }), rootPid, intervalMs, limitReached }; })();
    }
    return stopping;
  } };
}
