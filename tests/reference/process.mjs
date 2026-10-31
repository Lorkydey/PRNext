import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

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
      const signalGroup = signal => {
        try { process.kill(-child.pid, signal); return true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
      };
      const waitForGroup = async timeout => {
        const deadline = performance.now() + timeout;
        while (signalGroup(0)) {
          if (performance.now() >= deadline) return false;
          await delay(25);
        }
        return true;
      };
      // A detached group's identity outlives its leader while descendants
      // remain. Parent 'close' (especially with ignored stdio) is therefore
      // insufficient evidence that this fixture's group has disappeared.
      if (signalGroup('SIGTERM') && !await waitForGroup(5000)) {
        signalGroup('SIGKILL');
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
