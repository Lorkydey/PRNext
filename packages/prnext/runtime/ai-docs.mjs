import fs, {constants} from 'node:fs';
import {lstat, open, realpath, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultPackageRoot = fileURLToPath(new URL('../', import.meta.url));
const maxDocumentBytes = 256 * 1024;
const maxInstructionsBytes = 1024 * 1024;
const startMarker = '<!-- prnext-ai-docs:start -->';
const endMarker = '<!-- prnext-ai-docs:end -->';
const noFollow = constants.O_NOFOLLOW || 0;

const help = `Usage: prnext docs --ai [topic] [--json]
       prnext docs --ai --list [--json]
       prnext docs --ai --init [directory] [--json]

Read the AI documentation shipped with the installed PRNext package.
With no topic, print the short documentation index. --list shows available topics.
--init explicitly appends a short documentation pointer to a project's AGENTS.md.
Existing instructions are preserved; no files are changed by documentation reads.
For initialization, use a physical directory path without symbolic links or junctions.
No native binary, project configuration, network access, or installation is needed.
`;

function parseArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Documentation arguments must be strings.');
  if (args.includes('--help') || args.includes('-h')) {
    if (args.every(arg => ['--ai', '--help', '-h'].includes(arg))) return {help: true};
    throw new Error('Use prnext docs --help without other documentation options.');
  }
  const flags = new Set(), positional = [];
  for (const arg of args) {
    if (['--ai', '--list', '--json', '--init'].includes(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate documentation option: ${arg}`);
      flags.add(arg);
    } else if (arg.startsWith('-')) throw new Error(`Unknown documentation option: ${arg}`);
    else positional.push(arg);
  }
  if (!flags.has('--ai')) throw new Error('Use prnext docs --ai to read the installed AI documentation.');
  if (positional.length > 1) throw new Error('Provide only one documentation topic or initialization directory.');
  if (flags.has('--list') && (flags.has('--init') || positional.length)) throw new Error('--list cannot be combined with a topic or --init.');
  return {list: flags.has('--list'), json: flags.has('--json'), init: flags.has('--init'), value: positional[0]};
}

async function readBounded(handle, limit, label) {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error(`${label} must be a regular file.`);
  if (info.size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`);
  const buffer = Buffer.alloc(limit + 1);
  let size = 0;
  while (size < buffer.length) {
    const {bytesRead} = await handle.read(buffer, size, buffer.length - size, size);
    if (!bytesRead) break;
    size += bytesRead;
  }
  if (size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`);
  return buffer.subarray(0, size);
}

function decodeUtf8(buffer, label) {
  try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer); }
  catch { throw new Error(`${label} must contain UTF-8 text.`); }
}

async function readPackageFile(root, relative, limit = maxDocumentBytes) {
  const file = path.resolve(root, relative);
  const canonicalRoot = await realpath(root), canonicalFile = await realpath(file);
  const inside = path.relative(canonicalRoot, canonicalFile);
  if (inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) throw new Error(`Documentation file escapes the installed package: ${relative}`);
  const handle = await open(file, constants.O_RDONLY);
  try { return decodeUtf8(await readBounded(handle, limit, relative), relative); }
  finally { await handle.close(); }
}

async function readCatalog(root) {
  const metadata = JSON.parse(await readPackageFile(root, 'package.json', 64 * 1024));
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw new Error('The installed package metadata has no name or version.');
  const manifest = JSON.parse(await readPackageFile(root, 'docs/ai/manifest.json', 64 * 1024));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.topics) || manifest.topics.length > 64) throw new Error('The AI documentation manifest must use schemaVersion 1 and contain a bounded topics array.');
  const topics = [{id: 'index', title: 'AI documentation index', file: 'AI.md'}], ids = new Set(['index']);
  for (const topic of manifest.topics) {
    if (!topic || !/^[a-z][a-z0-9-]*$/.test(topic.id) || ids.has(topic.id)
      || typeof topic.title !== 'string' || !topic.title.trim() || /[\r\n\x00-\x1f]/.test(topic.title)
      || topic.file !== `docs/ai/${topic.id}.md`) throw new Error('The AI documentation manifest contains an invalid or duplicate topic.');
    ids.add(topic.id);
    topics.push({id: topic.id, title: topic.title, file: topic.file});
  }
  return {name: metadata.name, version: metadata.version, topics};
}

function instructionBlock(newline) {
  return [startMarker, '## PRNext documentation', '',
    'Before changing PRNext configuration, routes, data fetching, or deployment, read the documentation shipped with the installed package:', '',
    '`npx --no-install prnext docs --ai`', '',
    'Use `npx --no-install prnext docs --ai --list` to find topics, then read only the relevant topic with `npx --no-install prnext docs --ai <topic>`.',
    'With pnpm or Yarn, use `pnpm exec prnext docs --ai` or `yarn prnext docs --ai` instead. The installed package documentation is the version-specific reference; do not assume full Next.js compatibility.',
    endMarker, ''].join(newline);
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function checkDirectory(directory) {
  const parts = path.relative(path.parse(directory).root, directory).split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing to initialize through a symbolic link or junction: ${current}`);
    if (!info.isDirectory()) throw new Error(`Initialization directory is not a directory: ${current}`);
  }
  if (!samePath(await realpath(directory), directory)) throw new Error('Initialization directory resolves outside its requested path.');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyTarget(directory, file, handle) {
  await checkDirectory(directory);
  const actual = await lstat(file), opened = await handle.stat();
  if (actual.isSymbolicLink() || !actual.isFile() || !sameFile(actual, opened) || opened.nlink !== 1) {
    throw new Error('AGENTS.md changed identity or is linked; no instructions were appended.');
  }
}

function hasPointer(content) {
  const starts = content.split(startMarker).length - 1, ends = content.split(endMarker).length - 1;
  if (!starts && !ends) return false;
  if (starts !== 1 || ends !== 1 || content.indexOf(startMarker) > content.indexOf(endMarker)) {
    throw new Error('AGENTS.md contains incomplete or duplicate PRNext documentation markers; preserve and fix those markers before initializing again.');
  }
  return true;
}

async function initializeInstructions(directory) {
  await checkDirectory(directory);
  const file = path.join(directory, 'AGENTS.md'), lockFile = path.join(directory, '.prnext-ai-docs.lock');
  let lock;
  try { lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another initialization or an existing lock prevents changes: ${lockFile}`);
    throw error;
  }
  let handle;
  try {
    await checkDirectory(directory);
    let existing;
    try { existing = await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) throw new Error('AGENTS.md must be a regular file with no symbolic or hard links.');
    handle = await open(file, existing
      ? constants.O_RDWR | constants.O_APPEND | noFollow
      : constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollow, 0o644);
    await verifyTarget(directory, file, handle);
    const before = await readBounded(handle, maxInstructionsBytes, 'AGENTS.md');
    const content = decodeUtf8(before, 'AGENTS.md');
    if (hasPointer(content)) return {path: file, changed: false};
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const separator = !content ? '' : content.endsWith(newline + newline) ? '' : content.endsWith(newline) ? newline : newline + newline;
    const addition = Buffer.from(separator + instructionBlock(newline));
    if (before.length + addition.length > maxInstructionsBytes) throw new Error('Appending the PRNext pointer would exceed the AGENTS.md size limit.');
    // Append through the verified handle: concurrent appends never get replaced by
    // a stale full-file write. Refuse observed edits or target replacement.
    if (!before.equals(await readBounded(handle, maxInstructionsBytes, 'AGENTS.md'))) throw new Error('AGENTS.md changed during initialization; retry without overwriting those edits.');
    await verifyTarget(directory, file, handle);
    await handle.writeFile(addition);
    // Yarn PnP wraps FileHandle.sync() with an unimplemented method, even for
    // physical project files. Its descriptor still supports callback fsync.
    await new Promise((resolve, reject) => fs.fsync(handle.fd, error => error ? reject(error) : resolve()));
    return {path: file, changed: true};
  } finally {
    await handle?.close();
    // Only remove the lock we created, never a replacement supplied by another process.
    try {
      const opened = await lock.stat(), actual = await lstat(lockFile);
      if (sameFile(opened, actual) && !actual.isSymbolicLink()) await unlink(lockFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await lock.close(); }
  }
}

/** Read bundled docs or explicitly append a project pointer. Never launches native code. */
export async function executeAiDocs(args, {cwd = process.cwd(), packageRoot = defaultPackageRoot} = {}) {
  const options = parseArguments(args);
  if (options.help) return {output: help};
  const catalog = await readCatalog(packageRoot);
  if (options.init) {
    const initialized = await initializeInstructions(path.resolve(cwd, options.value || '.'));
    const result = {name: catalog.name, version: catalog.version, initialized};
    return {initialized, output: options.json ? JSON.stringify(result, null, 2) + '\n'
      : `${initialized.changed ? 'Added the PRNext documentation pointer to' : 'Kept the existing PRNext documentation pointer in'} ${initialized.path}\n`};
  }
  if (options.list) return {output: options.json ? JSON.stringify(catalog, null, 2) + '\n'
    : `${catalog.name} ${catalog.version}\n\n${catalog.topics.map(topic => `${topic.id.padEnd(18)} ${topic.title}`).join('\n')}\n`};
  const id = options.value || 'index';
  const topic = catalog.topics.find(item => item.id === id);
  if (!topic) throw new Error(`Unknown AI documentation topic: ${id}. Use prnext docs --ai --list.`);
  const content = await readPackageFile(packageRoot, topic.file);
  return {output: options.json ? JSON.stringify({...catalog, topic: topic.id, content}, null, 2) + '\n'
    : `${catalog.name} ${catalog.version} — ${topic.title}\n\n${content}${content.endsWith('\n') ? '' : '\n'}`};
}
