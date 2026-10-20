import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rename } from '../runtime/fs.mjs';
import { OUTPUT_POINTER, prepareBuildDirectory, readBuildDirectory, validateDistDir } from '../runtime/build-directory.mjs';
import { writeBuildOutput } from './output-contract.mjs';

const MAX_FILES = 20000, MAX_BYTES = 512 * 1024 * 1024;
const inside = (root, file) => file.startsWith(root + path.sep);
const urlFor = file => '/' + file.split('/').map(encodeURIComponent).join('/');

/** Import an already-built public directory. Never evaluate its config or code. */
export async function buildStatic(directory, { from = 'dist', spa = false, distDir, dev = false } = {}) {
  if (dev) throw new Error('The static adapter imports production files; use the source framework for development.');
  if (typeof spa !== 'boolean') throw new TypeError('spa must be a boolean');
  const root = await realpath(directory);
  // Reuse the output-directory restrictions to keep imports within this project
  // and away from source/dependency/repository trees.
  const relative = validateDistDir(from);
  const output = distDir === undefined ? await readBuildDirectory(root) : validateDistDir(distDir);
  const source = path.join(root, relative), destination = await prepareBuildDirectory(root, output);
  if (source === destination || inside(source, destination) || inside(destination, source)) throw new Error('Static input and PRNext output directories must not overlap.');
  let ancestor = root;
  for (const part of relative.split('/')) {
    ancestor = path.join(ancestor, part);
    const entry = await lstat(ancestor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Static input must use real directories, not symbolic links.');
  }
  if (!inside(root, await realpath(source))) throw new Error('Static input must stay inside the project.');
  const index = await lstat(path.join(source, 'index.html')).catch(() => null);
  if (!index?.isFile() || index.isSymbolicLink()) throw new Error('Static input needs index.html. Run your framework build first and select its public output with --from.');

  const id = randomUUID(), stage = path.join(root, `.prnext-build-${id}`);
  const backup = path.join(root, `.prnext-backup-${id}`), pointer = path.join(root, `.prnext-output-${id}.tmp`);
  const manifest = { version: 1, buildId: id, config: { staticOnly: true, staticFallback: spa, compress: true, poweredByHeader: true }, routes: [], prerendered: [] };
  const paths = new Set();
  let count = 0, bytes = 0, previous = false, published = false;
  const add = (url, file) => {
    if (paths.has(url)) throw new Error(`Ambiguous static URL ${url}; remove the conflicting file or HTML alias.`);
    paths.add(url);
    manifest.prerendered.push({ path: url, file: `static/${file}`, revalidate: false });
  };
  async function copy(folder = '', depth = 0) {
    if (depth > 64) throw new Error('Static input exceeds 64 directory levels.');
    for (const name of (await readdir(path.join(source, folder))).sort()) {
      if (name.includes('\\') || /[\x00-\x1f\x7f:]/.test(name) ||
          name.startsWith('.') && !(folder === '' && name === '.well-known') ||
          ['node_modules', '_prnext', '_next'].includes(name) || folder === '' && name === 'server') {
        throw new Error(`Static input contains a private, reserved or server path: ${folder ? folder + '/' : ''}${name}. Select only browser-ready files.`);
      }
      const file = folder ? `${folder}/${name}` : name;
      const entry = await lstat(path.join(source, file));
      if (entry.isSymbolicLink()) throw new Error(`Static input cannot contain symbolic links: ${file}`);
      if (entry.isDirectory()) { await copy(file, depth + 1); continue; }
      if (!entry.isFile()) throw new Error(`Static input must contain regular files: ${file}`);
      if (++count > MAX_FILES || (bytes += entry.size) > MAX_BYTES) throw new Error('Static input exceeds 20,000 files or 512 MiB.');
      const target = path.join(stage, 'static', file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, file), target, constants.COPYFILE_EXCL);
      const after = await lstat(path.join(source, file));
      if (!after.isFile() || after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || (await stat(target)).size !== entry.size) throw new Error(`Static input changed while being imported: ${file}. Retry after its build finishes.`);
      add(urlFor(file), file);
      if (file === 'index.html') add('/', file);
      else if (file.endsWith('/index.html')) add(urlFor(file.slice(0, -11)), file);
      else if (file.endsWith('.html')) add(urlFor(file.slice(0, -5)), file);
    }
  }
  try {
    await mkdir(stage);
    await copy();
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeBuildOutput(stage, manifest, { adapter: 'static', spa });
    // A failed import leaves the previously published build and pointer intact.
    previous = await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    await writeFile(pointer, JSON.stringify({ distDir: output }) + '\n', { flag: 'wx' });
    if (previous) await rename(destination, backup);
    try {
      await rename(stage, destination);
      published = true;
      await rename(pointer, path.join(root, OUTPUT_POINTER));
    } catch (error) {
      if (published) await rename(destination, stage);
      if (previous) await rename(backup, destination);
      throw error;
    }
    if (previous) await rm(backup, { recursive: true, force: true });
    return { ...manifest, outputDirectory: destination, files: count, bytes };
  } finally {
    await rm(pointer, { force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
