import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnReferenceProcess, runReferenceCommand, captureReferenceCommand, referenceGroupIsTerminated } from './process.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

test('group state permits only absent groups or owned zombies and rejects incomplete evidence', () => {
  assert.equal(referenceGroupIsTerminated(' 0 0 Ss\n 12 501 S\n 34 501 Z+\n 34 501 Z\n', 34, 501), true);
  assert.equal(referenceGroupIsTerminated(' 12 501 S\n', 34, 501), true);
  assert.throws(() => referenceGroupIsTerminated('', 34, 501), /inspect/);
  assert.equal(referenceGroupIsTerminated(' 34 501 Z\n 34 501 S\n', 34, 501), false);
  assert.equal(referenceGroupIsTerminated(' 34 502 Z\n', 34, 501), false);
  assert.equal(referenceGroupIsTerminated(' 34 501 T\n', 34, 501), false);
  assert.throws(() => referenceGroupIsTerminated(' 34 501\n', 34, 501), /inspect/);
  assert.throws(() => referenceGroupIsTerminated(' 34 501 Z\ntruncated row', 34, 501), /inspect/);
  assert.throws(() => referenceGroupIsTerminated('', 0, 501), /identity/);
});

test('reference commands capture bounded output and preserve failures', async () => {
  assert.deepEqual(await runReferenceCommand(process.execPath, ['-e', 'process.stdout.write("ok");process.stderr.write("warning")']), { stdout: 'ok', stderr: 'warning' });
  await assert.rejects(runReferenceCommand(process.execPath, ['-e', 'process.exitCode=7']), error => error.code === 7);
  await assert.rejects(runReferenceCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000));setInterval(()=>{},1000)'], { maxBuffer: 100 }), /output budget/);
});

for (const code of [7, 0]) test('command exit ' + code + ' remains a failure when owned cleanup also fails', { timeout: 20000 }, async t => {
  const owned = spawnReferenceProcess(process.execPath, ['-e', `process.stdout.write('command stdout');process.stderr.write('command stderr');process.exitCode=${code}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = owned.stop;
  const cleanupError = Object.assign(new Error('Controlled cleanup failure.'), { code: 'CONTROLLED_CLEANUP' });
  let cleanupAttempted = false;
  owned.stop = async () => {
    // Always reap the actual child before simulating the secondary failure.
    await stop();
    cleanupAttempted = true;
    throw cleanupError;
  };
  t.after(async () => { await stop(); await owned.closed; });
  await assert.rejects(captureReferenceCommand(owned), error => {
    if (code === 0) return error === cleanupError;
    assert.equal(error.code, 7);
    assert.equal(error.stdout, 'command stdout');
    assert.equal(error.stderr, 'command stderr');
    assert.equal(error.cleanupError, cleanupError);
    assert.equal(error.message, 'Reference command exited unsuccessfully. Reference process cleanup also failed.');
    assert.notEqual(error, cleanupError);
    return true;
  });
  assert.equal(cleanupAttempted, true);
  assert.equal((await owned.closed).code, code);
  assert.throws(() => process.kill(owned.child.pid, 0), { code: 'ESRCH' });
});

test('a reference command timeout closes its own descendant process tree', { timeout: 20000 }, async () => {
  let descendant;
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});process.stdout.write(String(child.pid));setInterval(()=>{},1000)`;
  await assert.rejects(runReferenceCommand(process.execPath, ['-e', source], { timeout: 1000 }), error => {
    descendant = Number(error.stdout);
    return /execution deadline/.test(error.message) && Number.isSafeInteger(descendant) && descendant > 0;
  });
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});

test('stopping a reference server is idempotent and waits for close', { timeout: 20000 }, async () => {
  const owned = spawnReferenceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await Promise.all([owned.stop(), owned.stop()]);
  await owned.closed;
  assert.throws(() => process.kill(owned.child.pid, 0), { code: 'ESRCH' });
});

test('a permission error cannot hide a real live process group', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const owned = spawnReferenceProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const originalKill = process.kill;
  const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  const mock = t.mock.method(process, 'kill', function(pid, signal) {
    if (pid === -owned.child.pid) throw denied;
    return originalKill.call(this, pid, signal);
  });
  try {
    await assert.rejects(owned.stop(), error => error === denied);
    originalKill(owned.child.pid, 0);
  } finally {
    try { mock.mock.restore(); }
    finally {
      try { originalKill(-owned.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await owned.closed;
    }
  }
});

for (const earlyExit of [false, true]) test('POSIX shutdown closes a TERM-ignoring descendant with ignored stdio when parent exits ' + (earlyExit ? 'before stop' : 'during stop'), { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-reference-group-')), ready = path.join(directory, 'ready');
  const descendantSource = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const parentSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore'});${earlyExit ? 'child.unref();' : 'setInterval(()=>{},1000);'}`;
  const owned = spawnReferenceProcess(process.execPath, ['-e', parentSource], { stdio: 'ignore' });
  t.after(async () => {
    try { process.kill(-owned.child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') {
        if (process.platform !== 'darwin' || error.code !== 'EPERM') throw error;
        const { stdout } = await execute('/bin/ps', ['-ax', '-o', 'pgid=,uid=,stat='], { timeout: 1000, maxBuffer: 1024 * 1024 });
        assert.equal(referenceGroupIsTerminated(stdout, owned.child.pid, process.getuid()), true);
      }
    }
    await owned.closed;
    await rm(directory, { recursive: true, force: true });
  });
  let descendant;
  for (let attempt = 0; attempt < 200; attempt++) {
    descendant = Number(await readFile(ready, 'utf8').catch(() => ''));
    if (Number.isSafeInteger(descendant) && descendant > 0) break;
    await delay(25);
  }
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0, 'descendant installed its TERM handler');
  process.kill(descendant, 0);
  if (earlyExit) await owned.closed;
  await owned.stop();
  await owned.closed;
  // macOS may retain an exited orphan as a zombie until launchd reaps it.
  // Check the actual descendant independently of the group-state parser.
  const result = await execute('/bin/ps', ['-p', String(descendant), '-o', 'stat='], { timeout: 1000, maxBuffer: 1000 }).catch(error => {
    if (error.code === 1 && !error.stdout.trim()) return { stdout: '' };
    throw error;
  });
  assert.match(result.stdout.trim(), /^(?:Z[+<>=A-Za-z-]*)?$/);
});
