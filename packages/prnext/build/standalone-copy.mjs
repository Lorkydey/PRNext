import {lstat, realpath, mkdir, copyFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {mapConcurrent} from './concurrent.mjs';

const within = (root, file) => file === root || file.startsWith(root + path.sep);
const version = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
const unchanged = (left, right) => version(left).every((value, index) => value === version(right)[index]);

/** Materialize a finite trace, keeping links deferred until all file writes settle. */
export async function copyStandaloneTrace(files, {tracingRoot, relocate, maxFiles, maxBytes, concurrency = 8}, io = {lstat, realpath, mkdir, copyFile, stat}) {
  const sources = Array.from(files);
  if (sources.length > maxFiles) throw new Error('Standalone output exceeds 100000 files / 2 GiB. Narrow tracing includes.');
  // Metadata can overlap, but admission and destination ordering remain exactly
  // the trace's order. No bytes are copied before the whole budget is admitted.
  const metadata = await mapConcurrent(sources, async source => {
    const info = await io.lstat(source);
    if (info.isSymbolicLink()) return {source, info, destination: await io.realpath(source)};
    return {source, info};
  }, concurrency);
  let copiedFiles = 0, copiedBytes = 0;
  const pendingLinks = [], groups = new Map();
  for (const {source, info, destination} of metadata) {
    if (info.isSymbolicLink() && !within(tracingRoot, source) && within(destination, tracingRoot)) continue;
    const target = relocate(source);
    if (++copiedFiles > maxFiles || (copiedBytes += info.size) > maxBytes) throw new Error('Standalone output exceeds 100000 files / 2 GiB. Narrow tracing includes.');
    if (info.isSymbolicLink()) { pendingLinks.push([target, relocate(destination)]); continue; }
    if (!info.isFile()) continue;
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({source, target, info});
  }
  const directories = new Map();
  await mapConcurrent(groups.values(), async entries => {
    // Alias collisions retain the old serial last-writer order. Unrelated files
    // share a small I/O worker set and one mkdir promise per destination parent.
    for (const {source, target, info} of entries) {
      const before = await io.lstat(source);
      if (!before.isFile() || !unchanged(info, before)) throw new Error('Standalone input changed before copying.');
      const directory = path.dirname(target);
      if (!directories.has(directory)) directories.set(directory, io.mkdir(directory, {recursive: true}));
      await directories.get(directory);
      await io.copyFile(source, target);
      const [after, copied] = await Promise.all([io.lstat(source), io.stat(target)]);
      if (!after.isFile() || !unchanged(before, after) || !copied.isFile() || copied.size !== before.size) throw new Error('Standalone input changed while copying.');
    }
  }, concurrency);
  return {copiedFiles, copiedBytes, pendingLinks};
}
