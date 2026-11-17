import {
  open,
  lstat,
  readdir,
  realpath,
  readFile,
  writeFile,
  mkdir,
  rm,
  rename as move
} from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { rename } from '../fs.mjs';
import { sourcePath, sourceExcluded, validateSourcePaths } from './source-policy.mjs';
import { ignoreRules } from './archive.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const maxState = 64 * 1048576;
export const sourceStatePath = (root) => path.join(root, '.prnext-cloud', 'source.json');
export async function safeCache(root) {
  const dir = path.join(root, '.prnext-cloud');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw Error('Cloud sync state cannot be a link.');
  return dir;
}
async function regularBytes(file, maximum = maxState) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum)
    throw Error('Invalid source sync state file.');
  return readFile(file);
}
export function validateManifest(
  files,
  limits = { fileBytes: 64 * 1048576, sourceBytes: 500 * 1048576, maxFiles: 15000 }
) {
  if (!Array.isArray(files) || files.length > Math.min(15000, limits.maxFiles))
    throw Error('Invalid source manifest.');
  let total = 0;
  for (const file of files) {
    sourcePath(file.path);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > Math.min(64 * 1048576, limits.fileBytes) ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || '') ||
      (total += file.size) > Math.min(500 * 1048576, limits.sourceBytes)
    )
      throw Error('Source manifest exceeds safe limits.');
  }
  validateSourcePaths(files.map((f) => f.path));
  return files;
}
export async function readSourceState(root) {
  try {
    const cache = path.join(root, '.prnext-cloud'),
      s = await lstat(cache);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw Error('Cloud sync state cannot be a link.');
    const state = JSON.parse(await regularBytes(sourceStatePath(root)));
    if (
      state.version !== 1 ||
      (state.revision !== null && !uuid(state.revision)) ||
      !['prnext', 'github'].includes(state.provider)
    )
      throw Error('Invalid source sync state.');
    validateManifest(state.files);
    if (
      state.pendingPush &&
      (!uuid(state.pendingPush.requestId) ||
        (state.pendingPush.baseRevision !== null &&
          !uuid(state.pendingPush.baseRevision)) ||
        typeof state.pendingPush.message !== 'string' ||
        state.pendingPush.message.length > 200 ||
        !/^[a-f0-9]{64}$/.test(state.pendingPush.changesHash || ''))
    )
      throw Error('Invalid pending source push.');
    if (
      state.pendingDeployment &&
      (!uuid(state.pendingDeployment.requestId) ||
        !uuid(state.pendingDeployment.revision) ||
        (state.pendingDeployment.deploymentId &&
          !uuid(state.pendingDeployment.deploymentId)))
    )
      throw Error('Invalid pending deployment.');
    if (
      state.submission &&
      (!uuid(state.submission.requestId) ||
        !/^[a-f0-9]{64}$/.test(state.submission.changesHash || '') ||
        typeof state.submission.url !== 'string' ||
        !/^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/\d+$/.test(
          state.submission.url
        ))
    )
      throw Error('Invalid submitted source push.');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeSourceState(root, state) {
  await atomicState(sourceStatePath(root), state);
}
async function atomicState(file, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maxState) throw Error('Source state exceeds the safe size limit.');
  await safeCache(path.dirname(path.dirname(file)));
  try {
    await regularBytes(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function localFile(root, name, { missing = true } = {}) {
  sourcePath(name);
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const [index, part] of name.split('/').entries()) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && missing) return null;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (index < name.split('/').length - 1
        ? !stat.isDirectory()
        : !stat.isFile() || stat.nlink !== 1)
    )
      throw Error('Source file/directory or link conflict: ' + name);
  }
  const actual = await realpath(current),
    relative = path.relative(canonicalRoot, actual);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('Unsafe local source path.');
  const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1) {
    await handle.close();
    throw Error('Source links cannot be followed.');
  }
  return { handle, stat: before };
}
export async function localHash(root, name) {
  const file = await localFile(root, name);
  if (!file) return null;
  const hash = createHash('sha256');
  let size = 0;
  try {
    if (file.stat.size > 64 * 1048576)
      throw Error('Local source file exceeds safe limits: ' + name);
    for await (const bytes of file.handle.createReadStream({ autoClose: false })) {
      size += bytes.length;
      if (size > 64 * 1048576)
        throw Error('Local source file exceeds safe limits: ' + name);
      hash.update(bytes);
    }
    const after = await file.handle.stat();
    if (
      size !== file.stat.size ||
      after.size !== size ||
      after.mtimeMs !== file.stat.mtimeMs
    )
      throw Error('Local file changed while being read: ' + name);
  } finally {
    await file.handle.close();
  }
  return { path: name, size, sha256: hash.digest('hex') };
}
export async function scanLocalSource(root, limits, signal) {
  const ignored = await ignoreRules(root),
    files = [];
  let bytes = 0,
    visited = 0;
  async function walk(dir = '') {
    for (const entry of (
      await readdir(path.join(root, dir), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      signal?.throwIfAborted();
      if (++visited > 30000) throw Error('Too many local source entries.');
      if (sourceExcluded(entry.name)) continue;
      const name = dir ? dir + '/' + entry.name : entry.name;
      sourcePath(name);
      if (ignored(name) && (!entry.isDirectory() || !ignored.canReinclude(name)))
        continue;
      if (entry.isSymbolicLink()) throw Error('Source links cannot be followed: ' + name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const stat = await lstat(path.join(root, name));
        if (
          stat.size > limits.fileBytes ||
          (bytes += stat.size) > limits.sourceBytes ||
          files.length >= limits.maxFiles
        )
          throw Error('Local sources exceed the server limits.');
        files.push(await localHash(root, name));
      } else throw Error('Only regular source files are supported: ' + name);
    }
  }
  await walk();
  validateManifest(files, limits);
  return files;
}
export async function planPull(root, previous, next) {
  const before = new Map((previous?.files || []).map((f) => [f.path, f])),
    after = new Map(next.files.map((f) => [f.path, f])),
    operations = [],
    conflicts = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(name),
      remote = after.get(name),
      current = await localHash(root, name);
    if (remote && current?.sha256 === remote.sha256 && current.size === remote.size)
      continue;
    if (remote && old && old.sha256 === remote.sha256 && old.size === remote.size)
      continue;
    if (!remote) {
      if (!current) continue;
      if (current.sha256 !== old?.sha256 || current.size !== old?.size) {
        conflicts.push(name);
        continue;
      }
      operations.push({ path: name, oldHash: current.sha256, newHash: null });
      continue;
    }
    if (current && (!old || current.sha256 !== old.sha256 || current.size !== old.size)) {
      conflicts.push(name);
      continue;
    }
    if (!current && old && old.sha256 !== remote.sha256) {
      conflicts.push(name);
      continue;
    }
    // Preserve an intentional local deletion when upstream did not edit it.
    if (!current && old && old.sha256 === remote.sha256) continue;
    operations.push({
      path: name,
      oldHash: current?.sha256 || null,
      newHash: remote.sha256
    });
  }
  if (conflicts.length)
    throw Error(
      'Pull would overwrite local changes: ' +
        conflicts.slice(0, 12).join(', ') +
        '. Keep your changes or use a separate empty directory.'
    );
  return operations;
}
function validateJournal(journal) {
  if (
    journal?.version !== 1 ||
    !uuid(journal.id) ||
    !Array.isArray(journal.operations) ||
    journal.operations.length > 30000
  )
    throw Error('Invalid source recovery journal.');
  for (const operation of journal.operations) {
    sourcePath(operation.path);
    for (const key of ['oldHash', 'newHash'])
      if (operation[key] !== null && !/^[a-f0-9]{64}$/.test(operation[key] || ''))
        throw Error('Invalid source recovery journal.');
  }
  if (new Set(journal.operations.map((o) => o.path)).size !== journal.operations.length)
    throw Error('Invalid source recovery journal.');
  return journal;
}
async function discardOwnedStage(root, id) {
  if (!uuid(id)) throw Error('Invalid source stage.');
  const cache = await safeCache(root),
    target = path.resolve(cache, 'pull-' + id);
  if (path.dirname(target) !== cache || !path.basename(target).startsWith('pull-'))
    throw Error('Unsafe source stage cleanup.');
  const stat = await lstat(target).catch(() => null);
  if (stat?.isSymbolicLink()) throw Error('Source stage cannot be a link.');
  await rm(target, { recursive: true, force: true });
}
export async function recoverPull(root) {
  const cache = await safeCache(root),
    file = path.join(cache, 'pull-journal.json');
  let journal;
  try {
    journal = validateJournal(JSON.parse(await regularBytes(file)));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const stage = path.join(cache, 'pull-' + journal.id);
  if (!journal.committed) {
    for (let index = journal.operations.length - 1; index >= 0; index--) {
      const operation = journal.operations[index],
        backup = path.join(stage, 'old-' + index),
        backupStat = await lstat(backup).catch(() => null),
        current = await localHash(root, operation.path);
      if (backupStat) {
        if (
          backupStat.isSymbolicLink() ||
          !backupStat.isFile() ||
          sha(await regularBytes(backup)) !== operation.oldHash
        )
          throw Error('Source recovery backup integrity failed.');
        if (current && current.sha256 !== operation.newHash)
          throw Error(
            'Source recovery would overwrite a newer local edit: ' +
              operation.path +
              '. Your backups remain in ' +
              stage
          );
        if (current) await rm(path.join(root, operation.path));
        await mkdir(path.dirname(path.join(root, operation.path)), { recursive: true });
        await move(backup, path.join(root, operation.path));
      } else if (!operation.oldHash && current) {
        if (current.sha256 !== operation.newHash)
          throw Error(
            'Source recovery would overwrite a newer local edit: ' +
              operation.path +
              '. Your backups remain in ' +
              stage
          );
        await rm(path.join(root, operation.path));
      }
    }
    for (const [name, existed] of [
      ['source.json', journal.hadState],
      ['project.json', journal.hadLink]
    ]) {
      const destination = path.join(cache, name),
        backup = path.join(stage, 'before-' + name);
      if (existed) {
        const bytes = await regularBytes(backup);
        await atomicState(destination, JSON.parse(bytes));
      } else {
        await regularBytes(destination).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await rm(destination, { force: true });
      }
    }
  }
  await discardOwnedStage(root, journal.id);
  await rm(file, { force: true });
}
export async function applyPull(
  root,
  previous,
  next,
  operations,
  { download, saveLink, signal, onOperation } = {}
) {
  const cache = await safeCache(root),
    id = randomUUID(),
    stage = path.join(cache, 'pull-' + id),
    journalFile = path.join(cache, 'pull-journal.json');
  await mkdir(stage, { mode: 0o700 });
  let journalWritten = false;
  try {
    for (let index = 0; index < operations.length; index++)
      if (operations[index].newHash) {
        signal?.throwIfAborted();
        await download(
          next.files.find((f) => f.path === operations[index].path),
          path.join(stage, 'new-' + index)
        );
      }
    // Re-check all paths after the potentially long network transfer.
    for (const operation of operations) {
      const current = await localHash(root, operation.path);
      if ((current?.sha256 || null) !== operation.oldHash)
        throw Error('Local source changed during pull: ' + operation.path);
    }
    const journal = {
      version: 1,
      id,
      operations,
      hadState: false,
      hadLink: false,
      committed: false
    };
    for (const [name, key] of [
      ['source.json', 'hadState'],
      ['project.json', 'hadLink']
    ])
      try {
        const bytes = await regularBytes(path.join(cache, name));
        await writeFile(path.join(stage, 'before-' + name), bytes, {
          flag: 'wx',
          mode: 0o600
        });
        journal[key] = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    await atomicState(journalFile, journal);
    journalWritten = true;
    for (let index = 0; index < operations.length; index++) {
      signal?.throwIfAborted();
      const operation = operations[index],
        current = await localHash(root, operation.path);
      if ((current?.sha256 || null) !== operation.oldHash)
        throw Error('Local source changed during pull: ' + operation.path);
      const destination = path.join(root, operation.path);
      await mkdir(path.dirname(destination), { recursive: true });
      if (current) await move(destination, path.join(stage, 'old-' + index));
      if (operation.newHash) await move(path.join(stage, 'new-' + index), destination);
      await onOperation?.(index);
    }
    await writeSourceState(root, next);
    await saveLink();
    journal.committed = true;
    await atomicState(journalFile, journal);
    await discardOwnedStage(root, id);
    await rm(journalFile, { force: true });
  } catch (error) {
    if (journalWritten) {
      try {
        await recoverPull(root);
      } catch (recovery) {
        error.message += ' Recovery needs attention: ' + recovery.message;
      }
    } else await discardOwnedStage(root, id);
    throw error;
  }
}
