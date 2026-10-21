import { mkdir, writeFile, rename, rm, realpath, lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

const LOCK = '.prnext-build.lock';
const busy = message => Object.assign(new Error(message), { code: 'PRNEXT_BUILD_LOCKED' });
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function owner(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw busy('The build lock is not a real directory. Check .prnext-build.lock before retrying.');
  const file = await open(path.join(directory, 'owner.json'), 'r');
  try {
    if ((await file.stat()).size > 4096) throw new Error('oversized owner');
    const value = JSON.parse(await file.readFile('utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.host !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token)) throw new Error('invalid owner');
    return value;
  } finally { await file.close(); }
}

/** One publisher per canonical project, covering React and direct static imports. */
export async function withBuildLock(directory, action) {
  const root = await realpath(directory), lock = path.join(root, LOCK);
  const identity = { pid: process.pid, host: hostname(), token: randomUUID(), createdAt: new Date().toISOString() };
  const prepared = path.join(root, `.prnext-lock-${identity.token}`);
  await mkdir(prepared, { mode: 0o700 });
  try {
    await writeFile(path.join(prepared, 'owner.json'), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(prepared, lock); break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let previous;
        try { previous = await owner(lock); }
        catch (cause) {
          if (cause.code === 'ENOENT' && attempt < 8) continue;
          throw busy('Cannot verify the build lock. Check .prnext-build.lock before retrying.');
        }
        if (previous.host !== identity.host || alive(previous.pid)) throw busy(`A build is already running for this project (PID ${previous.pid}). Wait for it to finish.`);
        // Exactly one contender can recover this generation. Never delete a lock
        // merely because it is old: long builds and suspended processes are valid.
        let claim;
        try { claim = await open(path.join(lock, 'recovery'), 'wx', 0o600); }
        catch (cause) {
          if (cause.code === 'ENOENT' && attempt < 8) continue;
          throw busy('Build lock recovery is in progress. Retry shortly; if recovery was interrupted, check .prnext-build.lock manually.');
        }
        const retired = path.join(root, `.prnext-lock-retired-${identity.token}`);
        try {
          await claim.writeFile(JSON.stringify(identity)); await claim.close(); claim = null;
          const current = await owner(lock);
          if (current.token !== previous.token) {
            // Do not unlink through this path: the new owner can release and
            // another generation can appear between our read and the unlink.
            throw busy('The build lock changed during recovery. Retry the build.');
          }
          await rename(lock, retired);
          await rm(retired, { recursive: true });
        } finally { await claim?.close(); }
      }
    }
    try { return await action(root); }
    finally {
      // Ownership must still match before releasing a lock.
      if ((await owner(lock)).token === identity.token) await rm(lock, { recursive: true });
    }
  } finally { await rm(prepared, { recursive: true, force: true }); }
}
