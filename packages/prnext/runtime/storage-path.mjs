import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

const normalized = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
export const sameStoragePath = (left, right) => normalized(left) === normalized(right);
const ordinary = info => info?.isDirectory() && !info.isSymbolicLink();
const identity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

/** Callers supply canonical roots and explicit descendants, never glob results. */
export async function captureStorageDirectory(directory) {
  try {
    directory = path.resolve(directory);
    const info = await lstat(directory);
    if (!ordinary(info) || !sameStoragePath(await realpath(directory), directory)) return null;
    const current = await lstat(directory);
    if (!ordinary(current) || !identity(info, current)) return null;
    return {directory, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs};
  } catch { return null; }
}

/** Recheck ancestors around each filesystem operation. Node does not expose an
 * atomic openat/unlinkat boundary: these guards reject observed replacements,
 * but are not isolation from a malicious process with the same filesystem rights. */
export async function verifyStorageDirectories(snapshots) {
  if (!Array.isArray(snapshots) || !snapshots.length) return false;
  for (const snapshot of snapshots) {
    if (!snapshot) return false;
    try {
      const info = await lstat(snapshot.directory);
      if (!ordinary(info) || !identity(info, snapshot) || !sameStoragePath(await realpath(snapshot.directory), snapshot.directory)) return false;
      const current = await lstat(snapshot.directory);
      if (!ordinary(current) || !identity(current, snapshot)) return false;
    } catch { return false; }
  }
  return true;
}
