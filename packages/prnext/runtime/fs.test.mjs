import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename as nativeRename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { rename } from './fs.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prnext-rename-'));
  const cleanup = [];
  t.after(async () => {
    for (const release of cleanup) await release();
    await rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'state.tmp');
  const destination = path.join(directory, 'state.json');
  await writeFile(source, '{"state":"ready"}');
  await writeFile(destination, '{"state":"building"}');
  return { source, destination, cleanup };
}

// Hold a real Windows reader that permits reads/writes but not deletion/rename.
// Release via stdin, rather than timing-dependent sleep in the child process.
async function lockFile(destination, cleanup) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $handle = [System.IO.File]::Open($env:PRNEXT_RENAME_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try { [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null }
    finally { $handle.Dispose() }
  `], { env: { ...process.env, PRNEXT_RENAME_TEST_FILE: destination }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const release = async () => {
    if (child.exitCode === null) child.stdin.end('\n');
    await exited;
  };
  cleanup.push(release);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('File lock setup timed out')); }, 30000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('locked')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`File lock exited: ${code}`)); });
  });
  return release;
}

test('atomic rename replaces a complete state file and reports missing sources', async t => {
  const { source, destination } = await fixture(t);
  await rename(source, destination);
  assert.equal(await readFile(destination, 'utf8'), '{"state":"ready"}');
  await assert.rejects(rename(source, destination), { code: 'ENOENT' });
  assert.equal(await readFile(destination, 'utf8'), '{"state":"ready"}');
});

test('Windows temporary reader lock is retried without removing the previous state', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const { source, destination, cleanup } = await fixture(t);
  const release = await lockFile(destination, cleanup);
  await assert.rejects(nativeRename(source, destination), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  let completed = false;
  const pending = rename(source, destination).then(() => { completed = true; });
  await delay(125);
  assert.equal(completed, false);
  assert.equal(await readFile(destination, 'utf8'), '{"state":"building"}');
  await release();
  await pending;
  assert.equal(await readFile(destination, 'utf8'), '{"state":"ready"}');
});

test('Windows persistent lock still fails within a bounded time and preserves both files', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const { source, destination, cleanup } = await fixture(t);
  await lockFile(destination, cleanup);
  const start = performance.now();
  await assert.rejects(rename(source, destination), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
  assert.ok(performance.now() - start < 5000, 'must not retry indefinitely');
  assert.equal(await readFile(destination, 'utf8'), '{"state":"building"}');
  assert.equal(await readFile(source, 'utf8'), '{"state":"ready"}');
});
