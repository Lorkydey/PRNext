import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {constants, writeFileSync, renameSync, rmSync} from 'node:fs';
import {lstat, open, opendir, rm} from 'node:fs/promises';
import path from 'node:path';
import {captureStorageDirectory,verifyStorageDirectories,sameStoragePath} from './storage-path.mjs';

const marker = '.owner.json', disabledMarker = '.recovery-disabled', uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const grace = 60_000, maxChildren = 4096, maxMarker = 64 * 1024;
const alive = pid => {try {process.kill(pid, 0); return true;} catch (error) {return error.code !== 'ESRCH';}};
const pid = value => Number.isSafeInteger(value) && value > 0;

/** A ticket is durable before a spawn. An interrupted spawn/metadata update
 * leaves the session ineligible for automatic recovery, never falsely idle. */
export function createDevelopmentSessionOwner(home, {session, processId = process.pid, host = hostname(), now = Date.now, warn = console.warn} = {}) {
  if (!uuid.test(session) || path.basename(home) !== session || !pid(processId)) throw Error('Invalid development session owner');
  const state = {version: 1, session, token: randomUUID(), pid: processId, host, createdAt: now(), updatedAt: now(), eligible: true, children: [], pending: []};
  function publish(initial = false) {
    state.updatedAt = now();
    const text = JSON.stringify(state) + '\n';
    if (Buffer.byteLength(text) > maxMarker) throw Error('Development owner metadata exceeds its budget');
    const file = path.join(home, marker);
    if (initial) {writeFileSync(file, text, {flag: 'wx', mode: 0o600}); return;}
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {writeFileSync(temporary, text, {flag: 'wx', mode: 0o600}); renameSync(temporary, file);}
    finally {rmSync(temporary, {force: true});}
  }
  publish(true);
  function disable() {
    // A separate create-only marker also works if Windows has temporarily
    // locked the owner receipt. A spawn may proceed only once this safeguard
    // or its pending ticket is durable.
    try {writeFileSync(path.join(home, disabledMarker), 'Incomplete development child ownership.\n', {flag: 'wx', mode: 0o600});}
    catch (error) {if (error.code !== 'EEXIST') throw error;}
    state.eligible = false; try {publish();} catch { /* The create-only marker forbids cleanup. */ }
  }
  return {
    beforeSpawn() {
      if (!state.eligible) return null;
      if (state.pending.length >= 128 || state.children.length >= maxChildren) {disable(); return null;}
      const ticket = randomUUID(); state.pending.push(ticket); try {publish();} catch {disable();} return ticket;
    },
    spawned(ticket, child, descendants = []) {
      if (!state.eligible) return;
      if (!state.pending.includes(ticket)) {disable(); return;}
      if (!pid(child?.pid) || descendants.some(value => !pid(value))) {state.eligible = false; try {disable();} catch { /* The pre-spawn ticket remains durable. */ } return;}
      for (const value of [child.pid, ...descendants]) if (!state.children.includes(value)) state.children.push(value);
      state.pending = state.pending.filter(value => value !== ticket);
      try {publish();} catch (error) {state.eligible = false; try {disable();} catch { /* The pre-spawn ticket remains durable. */ } warn('Development session recovery disabled: ' + (error.code || 'metadata publication failed'));}
    },
    disable,
  };
}

async function readOwner(home) {
  const name = path.join(home, marker), info = await lstat(name);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxMarker) return;
  const file = await open(name, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const bytes = Buffer.alloc(maxMarker + 1), {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxMarker) return;
    const text = bytes.toString('utf8', 0, bytesRead), value = JSON.parse(text);
    if (value.version !== 1 || value.session !== path.basename(home) || !uuid.test(value.session) || !uuid.test(value.token) || !pid(value.pid) || typeof value.host !== 'string' || value.host.length > 255 || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt || value.eligible !== true || !Array.isArray(value.pending) || value.pending.length || !Array.isArray(value.children) || value.children.length > maxChildren || value.children.some(value => !pid(value))) return;
    return {value, text};
  } finally {await file.close();}
}

async function ordinaryTree(home, budget, snapshots) {
  const directory = await captureStorageDirectory(home);
  if (!directory) return false;
  snapshots.push(directory);
  for await (const entry of await opendir(home)) {
    if (++budget.files > 32_768) return false;
    const file = path.join(home, entry.name), info = await lstat(file);
    if (info.isSymbolicLink()) return false;
    if (info.isDirectory()) {if (!await ordinaryTree(file, budget, snapshots)) return false;}
    else if (!info.isFile() || (budget.bytes += info.size) > 2 * 1024 ** 3) return false;
  }
  return true;
}

/** Called while the project's exclusive development lock is held. Legacy,
 * foreign, active, ambiguous and unmarked sessions are always preserved. */
export async function pruneDevelopmentSessions(root, {host = hostname(), now = Date.now(), isAlive = alive, graceMs = grace, remove = rm} = {}) {
  const report = {removed: 0, retained: 0, failed: 0};
  // The caller already holds the canonical project's development lock. Do not
  // recanonicalize a replaced root into a different project's storage.
  root = path.resolve(root);
  const container = path.join(root, '.prnext-dev');
  let info;
  try {info = await lstat(container);} catch (error) {if (error.code === 'ENOENT') return report; throw error;}
  if (!info.isDirectory() || info.isSymbolicLink()) return report;
  const ancestors = [await captureStorageDirectory(root), await captureStorageDirectory(container)];
  if (!await verifyStorageDirectories(ancestors)) return report;
  let scanned = 0;
  for await (const entry of await opendir(container)) {
    if (++scanned > 256) break;
    if (!entry.isDirectory() || !uuid.test(entry.name)) {report.retained++; continue;}
    const home = path.join(container, entry.name);
    try {
      const snapshots = [...ancestors, await captureStorageDirectory(home)];
      if (!await verifyStorageDirectories(snapshots)) {report.retained++; continue;}
      const owner = await readOwner(home);
      if (await lstat(path.join(home, disabledMarker)).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;})) {report.retained++; continue;}
      const inactive = value => value.host === host && value.updatedAt <= now - graceMs && value.createdAt <= now && ![value.pid, ...value.children].some(isAlive);
      if (!owner || !inactive(owner.value) || !await verifyStorageDirectories(snapshots) || !await ordinaryTree(home, {files: 0, bytes: 0}, snapshots) || !await verifyStorageDirectories(snapshots)) {report.retained++; continue;}
      // Validate the same marker and lifetime after the bounded tree walk. A
      // currently running session can never be deleted merely because it is old.
      const current = await readOwner(home), directory = await lstat(home);
      const disabled = await lstat(path.join(home, disabledMarker)).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
      if (disabled || !current || current.text !== owner.text || !inactive(current.value) || !directory.isDirectory() || directory.isSymbolicLink() || !await verifyStorageDirectories(snapshots)) {report.retained++; continue;}
      await remove(home, {recursive: true, force: true, maxRetries: 3, retryDelay: 100}); report.removed++;
    } catch {report.failed++;}
  }
  return report;
}

/** Failed generation cleanup remains in this retryable queue, including the
 * exact completed phase. Nothing is deleted before requests have drained. */
export function createRetiredGenerationCleanup({root, home, gateway, stop, remove = rm, warn = console.warn}) {
  const pending = new Map(); let running;
  const ownedHome = path.resolve(home);
  const ancestry = directory => [path.resolve(root), path.join(path.resolve(root), '.prnext-dev'), ownedHome, directory];
  async function storage(item, directory) {
    item.snapshots ??= await Promise.all(ancestry(directory).map(captureStorageDirectory));
    return verifyStorageDirectories(item.snapshots);
  }
  async function clean(item) {
    const directory = path.resolve(root, item.generation.directory);
    if (!sameStoragePath(path.dirname(directory), ownedHome) || !uuid.test(path.basename(directory)) || item.generation.id !== path.basename(directory)) throw Error('Invalid retired development generation');
    if (!await storage(item, directory)) throw Error('Development generation storage changed');
    if (item.phase === 0) {await gateway.request('retire', {generation: item.generation.id}); item.phase++;}
    if (!await storage(item, directory)) throw Error('Development generation storage changed');
    if (item.phase === 1) {await item.generation.runtime?.close(); item.phase++;}
    if (item.phase === 2) {await stop(item.generation.child); item.phase++;}
    if (item.phase === 3) {await gateway.request('forget', {generation: item.generation.id}); item.phase++;}
    const snapshots = [...item.snapshots];
    if (!await storage(item, directory) || !await ordinaryTree(directory, {files: 0, bytes: 0}, snapshots) || !await verifyStorageDirectories(snapshots)) throw Error('Development generation storage changed');
    await remove(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
  const retry = () => {
    if (running) return running;
    running = (async () => {
      for (const [id, item] of [...pending]) {
        try {await clean(item); pending.delete(id);}
        catch (error) {warn('Development generation cleanup: ' + error.message);}
      }
    })().finally(() => {running = undefined;});
    return running;
  };
  return {get pending() {return pending.size;}, enqueue(generation) {if (!pending.has(generation.id)) pending.set(generation.id, {generation, phase: 0}); return retry();}, retry,
    async close() {await running; for (const item of pending.values()) {const directory=path.resolve(root,item.generation.directory);if(await storage(item,directory))await item.generation.runtime?.close();else await stop(item.generation.runtime?.child);await stop(item.generation.child);}},
  };
}
