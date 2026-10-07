import { watch as watchDirectory, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { shouldWatchProjectFile } from './env.mjs';

const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

// On Linux Node implements recursive fs.watch by scanning every descendant,
// including ignored build trees. Atomic build swaps can delete a descendant
// during that scan. Watch only source directories, and handle removal races
// in our own traversal. No file contents or node_modules watches are retained.
export async function watchProject(root, { onChange, onError, ignore = () => false, watch = watchDirectory, maxDirectories = 8192, nativeRecursive = process.platform === 'darwin' || process.platform === 'win32' }) {
  // macOS and Windows have native recursive backends. Separate directory
  // subscriptions can lose coalesced events during rapid renames.
  if (nativeRecursive) {
    const watcher = watch(root, { recursive: true }, (event, filename) => {
      const relative = filename && String(filename).replaceAll(path.sep, '/');
      if (!relative || ignore(relative) || !shouldWatchProjectFile(relative)) return;
      if (process.platform === 'win32' && event === 'change') {
        // ReadDirectoryChangesW reports directory metadata changes while the
        // compiler reads sources. Creation/removal still arrives as rename.
        // Rebuilding on those reads restarts the server (and its SSE stream).
        try { if (statSync(path.join(root, relative)).isDirectory()) return; } catch {}
      }
      onChange(relative);
    });
    watcher.on('error', error => { watcher.close(); onError(error); });
    return { close: () => watcher.close(), async refresh() {} };
  }
  const directories = new Map();
  const pending = new Set();
  let closed = false, ready = false, timer, running, refreshAll = false;
  const allowedDirectory = relative => !relative || (!ignore(relative) && (relative === '.contentlayer' || shouldWatchProjectFile(relative)));
  const allowedFile = relative => relative && !ignore(relative) && shouldWatchProjectFile(relative);
  function remove(relative) {
    for (const [name, watcher] of directories) if (name === relative || name.startsWith(relative + '/')) {
      directories.delete(name);
      watcher.close();
    }
  }
  function close() {
    closed = true;
    clearTimeout(timer);
    pending.clear();
    for (const watcher of directories.values()) watcher.close();
    directories.clear();
  }
  function fail(error) {
    if (closed) return;
    close();
    onError(error);
  }
  function queue(relative) {
    if (closed) return;
    pending.add(relative);
    clearTimeout(timer);
    timer = setTimeout(() => { void drain().catch(fail); }, 20);
  }
  function disappeared(relative) {
    remove(relative);
    // A rapid rename can be coalesced by macOS. If a scheduled scan observes
    // the old path disappearing, reconcile its parent to discover the new one.
    queue(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
  }
  async function scan(relative, recursive = false) {
    if (closed) return;
    if (!allowedDirectory(relative)) { remove(relative); return; }
    if (!directories.has(relative)) {
      if (directories.size >= maxDirectories) throw new Error(`Development watcher exceeds ${maxDirectories} source directories. Narrow the application directory.`);
      let watcher;
      try {
        watcher = watch(path.join(root, relative), { recursive: false }, (event, filename) => {
          if (closed) return;
          if (relative && event === 'rename' && String(filename) === path.posix.basename(relative)) {
            // inotify subscriptions follow an inode. Reopen this subtree even
            // when an atomic source replacement already recreated its path.
            disappeared(relative);
            return;
          }
          const changed = filename ? path.posix.join(relative, String(filename).replaceAll(path.sep, '/')) : relative;
          if (allowedFile(changed)) onChange(changed);
          // The .contentlayer container itself is ignored as a source, but
          // its generated directory may be created after the watcher starts.
          // Platforms can coalesce a directory rename into a change event.
          // Rescan only this directory, rather than relying on the event name.
          if (allowedDirectory(changed) || allowedFile(changed)) queue(relative);
        });
      } catch (error) { if (relative && missing(error)) { disappeared(relative); return; } throw error; }
      directories.set(relative, watcher);
      // Files may already exist by the time a newly created directory is
      // subscribed. Its discovery must also invalidate the source snapshot.
      if (ready && allowedFile(relative)) onChange(relative);
      watcher.on('error', error => {
        if (closed) return;
        if (relative && missing(error)) disappeared(relative);
        else fail(error);
      });
    }
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (missing(error) && relative) { disappeared(relative); return; } throw error; }
    if (closed) return;
    const children = new Set();
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (!entry.isDirectory() || !allowedDirectory(child)) continue;
      children.add(child);
      if (recursive || !directories.has(child)) await scan(child, recursive);
    }
    for (const name of directories.keys()) {
      if (name && (path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name)) === relative && !children.has(name)) remove(name);
    }
  }
  function drain() {
    if (running) return running;
    running = (async () => {
      while (!closed && pending.size) {
        const batch = [...pending]; pending.clear();
        const recursive = refreshAll; refreshAll = false;
        for (const relative of batch) await scan(relative, recursive);
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  try { await scan('', true); }
  catch (error) { close(); throw error; }
  ready = true;
  return {
    close,
    async refresh() {
      if (closed) return;
      refreshAll = true;
      pending.add('');
      await drain();
    },
  };
}
