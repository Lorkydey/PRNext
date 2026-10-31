import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

// ps output contains only numeric identities and state, never command arguments.
// A zombie has exited; its remaining entry must be reaped by its own parent.
export function referenceGroupIsTerminated(snapshot, pgid, uid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || !Number.isSafeInteger(uid) || uid < 0) throw new Error('Invalid reference process group identity.');
  let observed = false;
  for (const line of snapshot.split('\n')) {
    if (!line.trim()) continue;
    const row = /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>=-]+)\s*$/.exec(line);
    if (!row || !Number.isSafeInteger(Number(row[1])) || !Number.isSafeInteger(Number(row[2]))) throw new Error('Could not inspect reference process group state.');
    observed = true;
    if (Number(row[1]) === pgid && (Number(row[2]) !== uid || !row[3].startsWith('Z'))) return false;
  }
  if (!observed) throw new Error('Could not inspect reference process group state.');
  return true;
}

// Every process group below belongs to one fixture invocation. Never terminate
// by executable name: another test or the developer may use the same binary.
export function spawnReferenceProcess(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', windowsHide: true });
  let ended = false, stopping;
  const closed = new Promise(resolve => {
    child.once('error', error => { ended = true; resolve({ error }); });
    child.once('close', (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  const stop = () => stopping ||= (async () => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // taskkill cannot reconstruct a tree after its root has disappeared.
      // The Windows checks cover shutdown while this owned root is alive.
      if (ended) return;
      // Windows terminates a Node wrapper on SIGTERM before its JS handler can
      // close the native server. taskkill /T applies only to this owned tree.
      await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, maxBuffer: 16000 }).catch(error => {
        if (!ended) throw new Error('Could not close the reference process tree.', { cause: { code: error.code } });
      });
    } else {
      const signalGroup = async signal => {
        try { process.kill(-child.pid, signal); return true; }
        catch (error) {
          if (error.code === 'ESRCH') return false;
          if (process.platform === 'darwin' && error.code === 'EPERM') {
            // XNU killpg1 filters SZOMB before permission checks, so a group
            // containing only zombies can return EPERM. Never equate EPERM
            // with exit: independently require no live member and our UID.
            // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c
            try {
              const { stdout } = await execute('/bin/ps', ['-ax', '-o', 'pgid=,uid=,stat='], { timeout: 1000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
              if (referenceGroupIsTerminated(stdout, child.pid, process.getuid())) return false;
            } catch { /* An unavailable or invalid snapshot proves nothing. */ }
          }
          throw error;
        }
      };
      const waitForGroup = async timeout => {
        const deadline = performance.now() + timeout;
        while (await signalGroup(0)) {
          if (performance.now() >= deadline) return false;
          await delay(25);
        }
        return true;
      };
      // A detached group's identity outlives its leader while descendants
      // remain. Parent 'close' (especially with ignored stdio) is therefore
      // insufficient evidence that this fixture's group has disappeared.
      if (await signalGroup('SIGTERM') && !await waitForGroup(5000)) {
        await signalGroup('SIGKILL');
        if (!await waitForGroup(10000)) throw new Error('Reference process group did not close within its shutdown deadline.');
      }
    }
    const result = await Promise.race([closed.then(() => true), delay(10000, false, { ref: false })]);
    if (!result) throw new Error('Reference process tree did not close within its shutdown deadline.');
  })();
  return { child, closed, stop };
}

export async function runReferenceCommand(command, args, { timeout = 180000, maxBuffer = 8e6, ...options } = {}) {
  const owned = spawnReferenceProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, failure, expire;
  const deadline = new Promise(resolve => { expire = resolve; });
  const capture = (stream, append) => stream.on('data', data => {
    bytes += data.length;
    if (bytes > maxBuffer) { failure ||= 'Reference command exceeded its output budget.'; expire({}); }
    else append(data.toString());
  });
  capture(owned.child.stdout, value => { stdout += value; });
  capture(owned.child.stderr, value => { stderr += value; });
  const timer = setTimeout(() => { failure ||= 'Reference command exceeded its execution deadline.'; expire({}); }, timeout);
  try {
    const result = await Promise.race([owned.closed, deadline]);
    if (failure || result.error || result.code !== 0) {
      const error = new Error(failure || 'Reference command exited unsuccessfully.');
      Object.assign(error, { stdout, stderr, code: result.error?.code || result.code });
      throw error;
    }
    return { stdout, stderr };
  } finally { clearTimeout(timer); await owned.stop(); }
}
