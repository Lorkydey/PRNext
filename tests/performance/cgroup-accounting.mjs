import * as filesystem from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mapCgroupV2Hierarchy } from './release-regression-controls.mjs';
import { MAX_PROCESS_PIDS, MAX_PROCESS_SAMPLES, parseLinuxProcessStat } from './process-tree.mjs';

const limits = ['Cgroup CPU includes exited descendants that remained in the owned group; it is distinct from sampled per-process CPU.', 'memory.current includes charged anonymous, cache and kernel memory; its sampled maximum is neither summed RSS nor an exact interval peak.', 'The verified fixture must not migrate processes out of its owned cgroup. Namespace-hidden limits and unrelated host contention remain unknown.'];
const code = error => ['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EIO', 'EBUSY', 'EEXIST'].includes(error?.code) ? error.code : 'INVALID';
const integer = value => /^(?:0|[1-9]\d{0,19})$/.test(value || '') && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const pid = value => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (root, file) => file.startsWith(root + '/');
const kernelKey = value => typeof value==='string'&&value.length<=64&&/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(value);
const counterFiles=['cpu.stat','memory.current','cgroup.events','memory.events','cgroup.procs'];
const counterReasons=['unreadable-counter-file','invalid-counter-line','invalid-counter-key','duplicate-counter','invalid-counter-value','missing-required-counter','invalid-process-membership','identity-unverified','membership-unverified','read-failed'];
function counterError(reason,file,key){
  return Object.assign(Error('Invalid kernel cgroup counters.'),{counterReason:reason,counterFile:file,...(kernelKey(key)?{counterKey:key}:{})});
}
function inspectionFailure(error,operation){
  const reason=counterReasons.includes(error?.counterReason)?error.counterReason:operation==='identity'?'identity-unverified':operation==='membership'?'membership-unverified':'read-failed';
  return {operation,code:code(error),reason,...(counterFiles.includes(error?.counterFile)?{file:error.counterFile}:{}),...(kernelKey(error?.counterKey)?{key:error.counterKey}:{})};
}

export function parseCgroupCounters({ cpu, memory, events, memoryEvents, processes }) {
  function keyed(source,file) {
    if (typeof source !== 'string' || source.length > 16384) throw counterError('unreadable-counter-file',file);
    const result = Object.create(null);
    for (const line of source.trim().split('\n')) {
      const match = /^(\S+) ([0-9]+)$/.exec(line);
      if(!match)throw counterError('invalid-counter-line',file,line.split(' ',1)[0]);
      if(!kernelKey(match[1]))throw counterError('invalid-counter-key',file);
      if(Object.hasOwn(result,match[1]))throw counterError('duplicate-counter',file,match[1]);
      if(!integer(match[2]))throw counterError('invalid-counter-value',file,match[1]);
      result[match[1]] = match[2];
    }
    return result;
  }
  const cpuValues = keyed(cpu,'cpu.stat'), eventValues = keyed(events,'cgroup.events'), memoryValues = keyed(memoryEvents,'memory.events');
  for(const [values,keys,file]of [[cpuValues,['usage_usec','user_usec','system_usec'],'cpu.stat'],[eventValues,['populated'],'cgroup.events'],[memoryValues,['oom','oom_kill'],'memory.events']])for(const key of keys)if(!Object.hasOwn(values,key))throw counterError('missing-required-counter',file,key);
  if(!['0','1'].includes(eventValues.populated))throw counterError('invalid-counter-value','cgroup.events','populated');
  if(typeof memory!=='string'||!integer(memory.trim()))throw counterError('invalid-counter-value','memory.current');
  if(typeof processes!=='string'||processes.length>131072)throw counterError('unreadable-counter-file','cgroup.procs');
  const pids = processes.trim() ? processes.trim().split(/\s+/).map(Number) : [];
  if (pids.length > MAX_PROCESS_PIDS || pids.some(value => !pid(value)) || new Set(pids).size !== pids.length) throw counterError('invalid-process-membership','cgroup.procs');
  return { cpuUsageUsec: cpuValues.usage_usec, memoryCurrentBytes: Number(memory.trim()), populated: Number(eventValues.populated), oom: memoryValues.oom, oomKill: memoryValues.oom_kill, pids: pids.sort((a, b) => a - b) };
}

function validateSnapshot(value) {
  if (!value || !['verified', 'unknown'].includes(value.state) || !Number.isFinite(Date.parse(value.at)) || !pid(value.rootPid) || typeof value.group !== 'string' || value.group.length > 4096 || !/^\d+:\d+$/.test(value.groupIdentity || '')) throw Error('Invalid retained cgroup identity.');
  if (value.state === 'unknown') {
    if (value.cpuUsageUsec !== null || value.memoryCurrentBytes !== null || !['read', 'identity', 'membership', 'counters'].includes(value.failure?.operation) || !['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EIO', 'EBUSY', 'EEXIST', 'INVALID'].includes(value.failure.code)) throw Error('Invalid incomplete cgroup observation.');
    if(value.failure.reason!==undefined&&!counterReasons.includes(value.failure.reason)||value.failure.file!==undefined&&!counterFiles.includes(value.failure.file)||value.failure.key!==undefined&&!kernelKey(value.failure.key))throw Error('Invalid retained cgroup inspection diagnostics.');
    return;
  }
  if (!integer(value.cpuUsageUsec) || !Number.isSafeInteger(value.memoryCurrentBytes) || value.memoryCurrentBytes < 0 || value.populated !== 1 || !integer(value.oom) || !integer(value.oomKill) || !/^\d+$/.test(value.rootStartId || '') || !Array.isArray(value.pids) || value.pids.length > MAX_PROCESS_PIDS || value.pids.some((item, index) => !pid(item) || index > 0 && item <= value.pids[index - 1]) || !value.pids.includes(value.rootPid)) throw Error('Invalid retained cgroup counters or membership.');
}

/** Recompute only kernel cgroup counters; never upgrade incomplete PID/RSS data. */
export function summarizeCgroupSamples(samples, { limitReached = false } = {}) {
  if (!Array.isArray(samples) || samples.length > MAX_PROCESS_SAMPLES || typeof limitReached !== 'boolean') throw Error('Invalid cgroup sample count.');
  samples.forEach(validateSnapshot);
  const first = samples[0], reasons = [];
  if (samples.length < 2) reasons.push('At least two complete cgroup observations are required.');
  if (limitReached) reasons.push('The cgroup observation limit was reached.');
  let processSetChanged = false;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index], previous = samples[index - 1];
    if (value.state !== 'verified') reasons.push('A cgroup observation was incomplete.');
    if (value.group !== first.group || value.groupIdentity !== first.groupIdentity || value.rootPid !== first.rootPid || value.rootStartId !== first.rootStartId) reasons.push('The owned cgroup or root identity changed.');
    if (previous && Date.parse(value.at) < Date.parse(previous.at)) reasons.push('The cgroup observation clock regressed.');
    if (value.state === 'verified' && previous?.state === 'verified') {
      if (BigInt(value.cpuUsageUsec) < BigInt(previous.cpuUsageUsec)) reasons.push('The kernel cgroup CPU counter regressed.');
      if (value.oom !== first.oom || value.oomKill !== first.oomKill) reasons.push('The owned cgroup encountered an OOM event.');
      processSetChanged ||= !same(value.pids, previous.pids);
    }
    if(value.state==='verified'&&(value.oom!=='0'||value.oomKill!=='0'))reasons.push('The owned cgroup encountered an OOM event.');
  }
  const verified = !reasons.length;
  return { version: 1, state: verified ? 'verified' : 'unknown', samples, limitReached, processSetChanged,
    cpuSeconds: verified ? Number(BigInt(samples.at(-1).cpuUsageUsec) - BigInt(first.cpuUsageUsec)) / 1e6 : null,
    peakObservedMemoryCurrentBytes: verified ? Math.max(...samples.map(value => value.memoryCurrentBytes)) : null,
    limitations: [...new Set([...reasons, ...limits])] };
}

export function startCgroupSampling(group, { intervalMs = 1000 } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000 || typeof group?.observe !== 'function') throw Error('Invalid cgroup sampler.');
  const samples = []; let timer, stopping, stopped = false, limitReached = false;
  const sample = async () => {
    if (samples.length >= MAX_PROCESS_SAMPLES) { limitReached = true; return; }
    const value = await group.observe(); samples.push(value); return value;
  };
  let pending = sample();
  function schedule() {
    if (stopped) return;
    if (samples.length >= MAX_PROCESS_SAMPLES) { limitReached = true; return; }
    timer = setTimeout(() => { pending = sample(); pending.then(schedule,()=>{}); }, intervalMs); timer.unref?.();
  }
  pending.then(schedule,()=>{});
  return { ready: pending, stop() {
    if (!stopping) { stopped = true; clearTimeout(timer); stopping = (async () => { await pending; await sample(); return { ...summarizeCgroupSamples(samples, { limitReached }), intervalMs }; })(); }
    return stopping;
  } };
}

// cgroup v2 documents inheritance and cumulative CPU for every descendant:
// https://docs.kernel.org/admin-guide/cgroup-v2.html . No children-file census
// is used as a substitute for kernel accounting. The only migrations below
// affect this driver or its not-yet-exec'd, owned server launcher.
export async function createCgroupAccounting({ scopeName = process.env.PRNEXT_PERFORMANCE_SCOPE, io = filesystem, selfPid = process.pid } = {}) {
  if (!/^prnext-performance-\d+-\d+(?:-probe)?\.scope$/.test(scopeName || '') || !pid(selfPid)) throw Error('An explicitly owned performance scope is required.');
  const read = file => io.readFile(file, 'utf8');
  const hierarchy = mapCgroupV2Hierarchy(await read('/proc/self/cgroup'), await read('/proc/self/mountinfo'));
  if (hierarchy.state !== 'mapped' || posix.basename(hierarchy.membership) !== scopeName) throw Error('The driver is not in its declared owned performance scope.');
  const root = hierarchy.directories[0].mountPath;
  if (await io.realpath(root) !== root || (await read(posix.join(root, 'cgroup.type'))).trim() !== 'domain' || (await read(posix.join(root, 'cgroup.subtree_control'))).trim()) throw Error('Use a canonical, exclusive, undelegated performance scope.');
  const controllers = (await read(posix.join(root, 'cgroup.controllers'))).trim().split(/\s+/);
  if (!['cpu', 'memory'].every(item => controllers.includes(item)) || (await read(posix.join(root, 'cgroup.procs'))).trim() !== String(selfPid)) throw Error('The performance scope must contain only this driver and expose CPU/memory controllers.');
  for (const entry of await io.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) throw Error('The owned performance scope already contains child groups.');
  const driver = posix.join(root, `driver-${randomUUID()}`), groups = new Set();
  let moved = false, enabled = false, closed = false,createdGroups=0;
  const close = async () => {
    if (closed) return;
    if (groups.size) throw Error('Owned server cgroups must be empty and closed before the driver scope.');
    if(moved&&(await read(posix.join(driver,'cgroup.procs'))).trim()!==String(selfPid))throw Error('The owned driver still contains other live processes.');
    if (enabled) { await io.writeFile(posix.join(root, 'cgroup.subtree_control'), '-cpu -memory'); enabled = false; }
    if (moved) { await io.writeFile(posix.join(root, 'cgroup.procs'), String(selfPid)); moved = false; }
    await io.rmdir(driver); closed = true;
  };
  await io.mkdir(driver);
  try {
    await io.writeFile(posix.join(driver, 'cgroup.procs'), String(selfPid)); moved = true;
    if ((await read(posix.join(root, 'cgroup.procs'))).trim()) throw Error('Another process entered the exclusive performance scope.');
    await io.writeFile(posix.join(root, 'cgroup.subtree_control'), '+cpu +memory'); enabled = true;
    const enabledControllers=(await read(posix.join(root, 'cgroup.subtree_control'))).trim().split(/\s+/);
    if (!['cpu', 'memory'].every(item => enabledControllers.includes(item))) throw Error('The kernel did not enable owned cgroup accounting.');
  } catch (error) { try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; error.message += ' Owned cgroup cleanup also failed.'; } throw error; }
  return { provenance: { version: 1, scope: hierarchy.membership, driver: posix.basename(driver), controllers: ['cpu', 'memory'] }, close,
    async createServerGroup(label) {
      if (closed || !/^\d{1,2}-(?:baseline|candidate)$/.test(label) || createdGroups >= 40) throw Error('Invalid owned server cgroup request.');
      const directory = posix.join(root, `server-${label}-${randomUUID()}`);
      if (!within(root, directory)) throw Error('Server cgroup escaped its owned scope.');
      await io.mkdir(directory);
      createdGroups++;
      let metadata;
      try{metadata=await io.lstat(directory,{bigint:true});}catch(error){try{await io.rmdir(directory);}catch(cleanupError){error.cleanupError=cleanupError;error.message+=' Owned cgroup cleanup also failed.';}throw error;}
      const groupIdentity = `${metadata.dev}:${metadata.ino}`;
      const membership = posix.join(hierarchy.membership, posix.basename(directory));
      let rootPid, rootStartId, groupClosed = false;
      const owned = { directory }; groups.add(owned);
      const readIdentity = async () => { const value = await io.lstat(directory,{bigint:true}); if (`${value.dev}:${value.ino}` !== groupIdentity || !value.isDirectory() || value.isSymbolicLink()) throw Error('The owned cgroup identity changed.'); };
      const group = {
        launch(binary, args) {
          if (groupClosed || rootPid || typeof binary !== 'string' || !Array.isArray(args)) throw Error('Invalid cgroup server launch.');
          // Static shell program, structured positional arguments, no eval.
          // exec preserves the root PID and stdin EOF shutdown contract.
          return { command: '/bin/sh', args: ['-c', 'printf "%s" "$$" > "$1/cgroup.procs" && shift && exec "$@"', 'prnext-cgroup-launcher', directory, binary, ...args] };
        },
        async bind(pidValue) {
          if (rootPid || !pid(pidValue)) throw Error('An owned server root PID is required.');
          await readIdentity();
          const stat = parseLinuxProcessStat(await read(`/proc/${pidValue}/stat`), { clockTicks: 1, pageSize: 1 });
          const actual = mapCgroupV2Hierarchy(await read(`/proc/${pidValue}/cgroup`), await read('/proc/self/mountinfo'));
          if (actual.state !== 'mapped' || actual.membership !== membership) throw Error('The server was not launched in its owned cgroup.');
          rootPid = pidValue; rootStartId = stat.startId;
        },
        async observe() {
          let operation = 'read';
          try {
            if (groupClosed || !rootPid) throw Error('The owned cgroup root was not bound.');
            operation = 'identity'; await readIdentity();
            operation = 'membership';
            const stat = parseLinuxProcessStat(await read(`/proc/${rootPid}/stat`), { clockTicks: 1, pageSize: 1 });
            const actual = mapCgroupV2Hierarchy(await read(`/proc/${rootPid}/cgroup`), await read('/proc/self/mountinfo'));
            if (stat.startId !== rootStartId || actual.state !== 'mapped' || actual.membership !== membership) throw Error('The owned root exited, was reused or migrated.');
            for (const entry of await io.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) throw Error('Unexpected nested server cgroups.');
            operation = 'counters';
            const names = ['cpu.stat', 'memory.current', 'cgroup.events', 'memory.events', 'cgroup.procs'];
            const values = await Promise.all(names.map(name => read(posix.join(directory, name))));
            const counters = parseCgroupCounters(Object.fromEntries(['cpu', 'memory', 'events', 'memoryEvents', 'processes'].map((name, index) => [name, values[index]])));
            if (!counters.pids.includes(rootPid) || counters.populated !== 1) throw Error('The owned root is absent from its cgroup.');
            operation = 'identity'; await readIdentity();
            return { state: 'verified', at: new Date().toISOString(), rootPid, rootStartId, group: membership, groupIdentity, ...counters };
          } catch (error) { return { state: 'unknown', at: new Date().toISOString(), rootPid: rootPid || selfPid, group: membership, groupIdentity, cpuUsageUsec: null, memoryCurrentBytes: null, failure: inspectionFailure(error,operation) }; }
        },
        async close() {
          if (groupClosed) return;
          await readIdentity();
          // Process close and recursive populated notifications need not become
          // visible in the same event-loop turn. This bounded drain is teardown,
          // never a retry/replacement of a measured workload or failed sample.
          const deadline=Date.now()+5000;
          while((await read(posix.join(directory, 'cgroup.procs'))).trim() || !/^populated 0$/m.test(await read(posix.join(directory, 'cgroup.events')))){
            if(Date.now()>=deadline)throw Error('The owned server cgroup is still populated.');
            await delay(25);await readIdentity();
          }
          await io.rmdir(directory); groupClosed = true; groups.delete(owned);
        },
      };
      return group;
    },
  };
}
