import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnReferenceProcess, runReferenceCommand } from './process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('reference commands capture bounded output and preserve failures', async () => {
  assert.deepEqual(await runReferenceCommand(process.execPath, ['-e', 'process.stdout.write("ok");process.stderr.write("warning")']), { stdout: 'ok', stderr: 'warning' });
  await assert.rejects(runReferenceCommand(process.execPath, ['-e', 'process.exitCode=7']), error => error.code === 7);
  await assert.rejects(runReferenceCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000));setInterval(()=>{},1000)'], { maxBuffer: 100 }), /output budget/);
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

for (const earlyExit of [false, true]) test('POSIX shutdown closes a TERM-ignoring descendant with ignored stdio when parent exits ' + (earlyExit ? 'before stop' : 'during stop'), { skip: process.platform === 'win32', timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-reference-group-')), ready = path.join(directory, 'ready');
  const descendantSource = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const parentSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore'});${earlyExit ? 'child.unref();' : 'setInterval(()=>{},1000);'}`;
  const owned = spawnReferenceProcess(process.execPath, ['-e', parentSource], { stdio: 'ignore' });
  t.after(async () => {
    try { process.kill(-owned.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
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
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});
