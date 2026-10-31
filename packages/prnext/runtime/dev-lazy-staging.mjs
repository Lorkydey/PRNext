import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

/** Delete only an unpublished direct-child stage created by our lazy compiler. */
export async function discardLazyBuild(root, built) {
  if (!built?.devLazyTemporary) return;
  const canonicalRoot = await realpath(root), directory = path.resolve(built.outputDirectory);
  if (path.dirname(directory) !== canonicalRoot ||
      !/^\.prnext-build-[a-f0-9-]{36}$/.test(path.basename(directory))) throw Error('Invalid deferred staging directory');
  const info = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw Error('Invalid deferred staging directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
