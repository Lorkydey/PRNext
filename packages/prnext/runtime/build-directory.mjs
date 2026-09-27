import { open, realpath, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const OUTPUT_POINTER = '.prnext-output.json';
const reserved = new Set(['public','node_modules','app','pages','src','components','lib','packages','target','.git','.prnext-output.json']);
export function validateDistDir(value = '.prnext') {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || path.isAbsolute(value) || /[\\\x00-\x1f\x7f:]/.test(value)) throw new TypeError('distDir must be a relative directory inside the project');
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..') || reserved.has(segments[0])) throw new TypeError('distDir cannot traverse or replace project source, public, dependency or repository directories');
  return value;
}

/** Starting a published artifact never evaluates application configuration. */
export async function readBuildDirectory(root) {
  let file;
  try {
    file = await open(path.join(root, OUTPUT_POINTER), 'r');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error('Invalid PRNext output pointer: exceeds 4 KiB');
    const pointer = JSON.parse(buffer.subarray(0, bytesRead).toString());
    if (typeof pointer?.distDir !== 'string') throw new Error('Invalid PRNext output pointer: missing distDir');
    return validateDistDir(pointer.distDir);
  } catch (error) { if (error.code === 'ENOENT') return '.prnext'; throw error; }
  finally { await file?.close(); }
}

/** Refuse symlink destinations or ancestors before any build can replace them. */
export async function prepareBuildDirectory(root, relative) {
  const canonical = await realpath(root);
  let current = canonical;
  for (const part of validateDistDir(relative).split('/')) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('distDir must contain only real directories, not symbolic links or files');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    await lstat(current);
    const manifest = JSON.parse(await readFile(path.join(current, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.routes)) throw new Error('invalid manifest');
  } catch (error) {
    if (error.code !== 'ENOENT' || await lstat(current).then(() => true, () => false)) throw new Error('distDir already exists without a PRNext manifest; refusing to replace unrelated files');
  }
  await mkdir(path.dirname(current), {recursive:true});
  return current;
}
