import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, access, rename, copyFile, realpath} from 'node:fs/promises';
import {renameSync, symlinkSync} from 'node:fs';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDevelopmentSessionOwner, pruneDevelopmentSessions, createRetiredGenerationCleanup} from './dev-session-retention.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'prnext-dev-retention-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  async function owner(options = {}) {
    const session = randomUUID(), home = path.join(root, '.prnext-dev', session);
    await mkdir(home, {recursive: true});
    const control = createDevelopmentSessionOwner(home, {session, processId: 1001, host: 'test-host', now: () => 1000, warn: () => {}, ...options});
    return {session, home, control, marker: () => readFile(path.join(home, '.owner.json'), 'utf8').then(JSON.parse)};
  }
  const prune = options => pruneDevelopmentSessions(root, {host: 'test-host', now: 100_000, graceMs: 1000, isAlive: () => false, ...options});
  return {root, owner, prune};
}

test('session spawn tickets survive a parent crash; all registered child PIDs must be dead', async t => {
  const f = await fixture(t), session = await f.owner();
  const ticket = session.control.beforeSpawn();
  assert.deepEqual((await session.marker()).pending, [ticket]);
  assert.equal((await f.prune()).removed, 0, 'unknown child creation cannot be treated as idle');
  session.control.spawned(ticket, {pid: 1002}, [1003]);
  assert.deepEqual((await session.marker()).children, [1002, 1003]);
  assert.equal((await f.prune({isAlive: pid => pid === 1003})).removed, 0, 'an orphan Node worker protects its session');
  assert.equal((await f.prune()).removed, 1);
  await assert.rejects(access(session.home), {code: 'ENOENT'});
});

test('session cleanup preserves foreign hosts, active/recent owners, legacy and malformed metadata', async t => {
  const f = await fixture(t), live = await f.owner({processId: 2001}), foreign = await f.owner({host: 'other-host'}), recent = await f.owner({now: () => 99_999}), unknown = await f.owner();
  unknown.control.disable();
  const legacy = path.join(f.root, '.prnext-dev', randomUUID()); await mkdir(legacy);
  const invalid = await f.owner(); await writeFile(path.join(invalid.home, '.owner.json'), JSON.stringify({pid: 4001}));
  const result = await f.prune({isAlive: pid => pid === 2001});
  assert.equal(result.removed, 0);
  for (const name of [live.home, foreign.home, recent.home, unknown.home, legacy, invalid.home]) await access(name);
});

test('session cleanup rejects symlink trees and retains failed deletions for a later startup', async t => {
  const f = await fixture(t), linked = await f.owner(), retryable = await f.owner();
  const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'untouched.txt'), 'keep');
  await symlink(outside, path.join(linked.home, 'directory'), process.platform === 'win32' ? 'junction' : 'dir');
  const failure = await f.prune({remove: async () => {throw Object.assign(Error('locked'), {code: 'EPERM'});}});
  assert.equal(failure.removed, 0); assert.equal(failure.failed, 1);
  await access(retryable.home);
  assert.equal((await f.prune()).removed, 1);
  await access(linked.home); assert.equal(await readFile(path.join(outside, 'untouched.txt'), 'utf8'), 'keep');
});

test('a symlinked development container and changed owner during the scan are never removed', async t => {
  const f = await fixture(t), session = await f.owner();
  let checks = 0;
  const result = await f.prune({isAlive: () => ++checks > 1});
  assert.equal(result.removed, 0); await access(session.home);
  const realContainer = path.join(f.root, '.prnext-dev');
  await rm(realContainer, {recursive: true});
  const outside = path.join(f.root, 'different'); await mkdir(outside);
  await symlink(outside, realContainer, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await f.prune(), {removed: 0, retained: 0, failed: 0});
});

test('generation deletion follows draining and retries filesystem failure without replaying lifecycle commands', async t => {
  const f = await fixture(t), home = path.join(f.root, '.prnext-dev', randomUUID()), id = randomUUID(), directory = path.join(home, id);
  await mkdir(directory, {recursive: true});
  const calls = []; let release, entered, fail = true;
  const drained = new Promise(resolve => {release = resolve;});
  const retiring = new Promise(resolve => {entered = resolve;});
  const cleanup = createRetiredGenerationCleanup({root: f.root, home,
    gateway: {request: async command => {calls.push(command); if (command === 'retire') {entered(); await drained;}}},
    stop: async () => {calls.push('stop');}, warn: () => {},
    remove: async (...args) => {calls.push('remove'); if (fail) throw Object.assign(Error('locked'), {code: 'EPERM'}); await rm(...args);},
  });
  const pending = cleanup.enqueue({id, directory: path.relative(f.root, directory), runtime: {close: async () => {calls.push('runtime');}}});
  await retiring;
  assert.deepEqual(calls, ['retire']); await access(directory);
  release(); await pending;
  assert.deepEqual(calls, ['retire', 'runtime', 'stop', 'forget', 'remove']); assert.equal(cleanup.pending, 1);
  fail = false; await cleanup.retry();
  assert.deepEqual(calls, ['retire', 'runtime', 'stop', 'forget', 'remove', 'remove']); assert.equal(cleanup.pending, 0);
  await assert.rejects(access(directory), {code: 'ENOENT'});
});

test('session cleanup rejects a development namespace swapped to a junction during lifetime checks', async t => {
  const f = await fixture(t), session = await f.owner();
  const container = path.join(f.root, '.prnext-dev'), parked = path.join(f.root, 'parked'), outside = path.join(f.root, 'outside');
  await mkdir(path.join(outside, session.session), {recursive: true});
  await writeFile(path.join(outside, session.session, 'untouched.txt'), 'outside');
  await copyFile(path.join(session.home, '.owner.json'), path.join(outside, session.session, '.owner.json'));
  let swapped = false;
  const result = await f.prune({isAlive: () => {if (!swapped) {swapped = true;renameSync(container, parked);symlinkSync(outside, container, process.platform === 'win32' ? 'junction' : 'dir');}return false;}});
  assert.equal(result.removed, 0);
  assert.equal(await readFile(path.join(outside, session.session, 'untouched.txt'), 'utf8'), 'outside');
  await access(path.join(parked, session.session, '.owner.json'));
});

test('session cleanup rejects a canonical project root replaced during its ownership check', {skip: process.platform === 'win32' ? 'Windows refuses renaming the ancestor of an open directory iterator.' : false}, async t => {
  const f = await fixture(t), session = await f.owner(), parked = f.root + '-parked', outside = f.root + '-outside';
  t.after(async () => {await rm(parked, {recursive: true, force: true});await rm(outside, {recursive: true, force: true});});
  const external = path.join(outside, '.prnext-dev', session.session);
  await mkdir(external, {recursive: true});
  await copyFile(path.join(session.home, '.owner.json'), path.join(external, '.owner.json'));
  await writeFile(path.join(external, 'untouched.txt'), 'outside');
  let swapped = false;
  const result = await f.prune({isAlive: () => {if (!swapped) {swapped = true;renameSync(f.root, parked);symlinkSync(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');}return false;}});
  assert.equal(result.removed, 0);
  assert.equal(await readFile(path.join(external, 'untouched.txt'), 'utf8'), 'outside');
  await access(path.join(parked, '.prnext-dev', session.session, '.owner.json'));
});

test('a canonical root replaced before cleanup is not recanonicalized into another project', async t => {
  const f = await fixture(t), session = await f.owner(), parked = f.root + '-parked', outside = f.root + '-outside';
  t.after(async () => {await rm(parked, {recursive: true, force: true});await rm(outside, {recursive: true, force: true});});
  const external = path.join(outside, '.prnext-dev', session.session);
  await mkdir(external, {recursive: true});
  await copyFile(path.join(session.home, '.owner.json'), path.join(external, '.owner.json'));
  await writeFile(path.join(external, 'untouched.txt'), 'outside');
  await rename(f.root, parked);await symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.prune()).removed, 0);
  assert.equal(await readFile(path.join(external, 'untouched.txt'), 'utf8'), 'outside');
});

test('a nested tree replaced after capture is detected before recursive deletion', async t => {
  const f = await fixture(t), session = await f.owner(), nested = path.join(session.home, 'snapshot/nested'), outside = path.join(f.root, 'outside');
  await mkdir(nested, {recursive: true}); await mkdir(outside);
  await writeFile(path.join(outside, 'untouched.txt'), 'outside');
  const original = fs.opendir; let replaced = false;
  try {
    fs.opendir = async (directory, ...args) => {
      if (directory === nested && !replaced) {replaced = true;await rename(nested, nested + '-parked');await symlink(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');}
      return original(directory, ...args);
    };
    syncBuiltinESMExports();
    const result = await f.prune();
    assert.equal(replaced, true); assert.equal(result.removed, 0);
    assert.equal(await readFile(path.join(outside, 'untouched.txt'), 'utf8'), 'outside');
    await access(path.join(nested + '-parked'));
  } finally {fs.opendir = original;syncBuiltinESMExports();}
});

test('retired generation cleanup rejects a session swapped during draining and preserves the external tree', async t => {
  const f = await fixture(t), home = path.join(f.root, '.prnext-dev', randomUUID()), id = randomUUID();
  await mkdir(path.join(home, id), {recursive: true});
  const outside = path.join(f.root, 'outside'); await mkdir(path.join(outside, id), {recursive: true});
  await writeFile(path.join(outside, id, 'untouched.txt'), 'outside');
  let closes = 0, removed = false;
  const cleanup = createRetiredGenerationCleanup({root: f.root, home,
    gateway: {request: async command => {if (command === 'retire') {await rename(home, home + '-parked');await symlink(outside, home, process.platform === 'win32' ? 'junction' : 'dir');}}},
    stop: async () => {}, warn: () => {}, remove: async () => {removed = true;},
  });
  await cleanup.enqueue({id, directory: path.relative(f.root, path.join(home, id)), runtime: {close: async () => {closes++;}}});
  assert.equal(cleanup.pending, 1); assert.equal(removed, false); assert.equal(closes, 0);
  await cleanup.close(); assert.equal(closes, 0, 'shutdown must not call a descriptor unlink through changed ancestry');
  assert.equal(await readFile(path.join(outside, id, 'untouched.txt'), 'utf8'), 'outside');
});

test('failed generation draining is retried and shutdown still stops its recorded process', async t => {
  const f = await fixture(t), home = path.join(f.root, '.prnext-dev', randomUUID()), id = randomUUID();
  await mkdir(path.join(home, id), {recursive: true});
  const calls = [];
  const cleanup = createRetiredGenerationCleanup({root: f.root, home, gateway: {request: async () => {throw Error('gateway closed');}}, stop: async () => calls.push('stop'), warn: () => {}});
  await cleanup.enqueue({id, directory: path.relative(f.root, path.join(home, id)), runtime: {close: async () => calls.push('runtime')}});
  assert.equal(cleanup.pending, 1);
  await cleanup.close(); assert.deepEqual(calls, ['runtime', 'stop']);
  assert.ok((await readdir(home)).includes(id), 'shutdown does not delete a snapshot before its owner removes the entire session');
});
