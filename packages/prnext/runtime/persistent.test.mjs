import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { parsePersistent } from './persistent/client.mjs';
import { RotatingLog } from './persistent/logger.mjs';
import { startupDefinition } from './persistent/startup.mjs';

test('persistent commands reject ambiguous targets and invalid resource/health options', () => {
  assert.deepEqual(parsePersistent('pstart', ['dir with spaces', '--name', 'web', '--port', '4000', '--inspect']), { target: 'dir with spaces', options: { name: 'web', port: 4000, inspect: true } });
  for (const args of [['--port', '0'], ['--port', '99999'], ['--workers', 'NaN'], ['--workers', '65'], ['--health-path', '//other.test'], ['--health-path', '/\\evil'], ['--health-timeout', '0'], ['--name', '../outside'], ['--port'], ['--port', '3000', '--port', '3001']]) assert.throws(() => parsePersistent('pstart', args));
  for (const command of ['pstop', 'prestart', 'pdelete']) assert.throws(() => parsePersistent(command, ['web', '--all']));
  assert.throws(() => parsePersistent('pdown', ['web']));
  assert.throws(() => parsePersistent('plogs', ['../../secret']));
  assert.throws(() => parsePersistent('plogs', ['--lines', '10001']));
});

test('persistent log rotation bounds files and preserves ordered output across rotations', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'prnext-logs-'));
  try {
    const file = path.join(folder, 'app.log');
    const log = new RotatingLog(file, { maxBytes: 1024, backups: 3 });
    const bytes = Buffer.from('é🙂 some application output\n'.repeat(200));
    for (let offset = 0; offset < bytes.length; offset += 1537) if (!log.write(bytes.subarray(offset, offset + 1537))) await once(log, 'drain');
    const finished = once(log, 'finish'); log.end(); await finished;
    const names = await readdir(folder);
    assert.equal(names.length, 4);
    for (const name of names) assert.ok((await stat(path.join(folder, name))).size <= 1024);
    const retained = Buffer.concat(await Promise.all(['.3', '.2', '.1', ''].map(suffix => readFile(file + suffix))));
    assert.deepEqual(retained, bytes.subarray(bytes.length - retained.length));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('startup definitions are per-user, scoped, safely quoted, and restart failures', () => {
  const config = { home: '/tmp/PRNext home $cash% "quoted"', node: '/opt/node', watchdog: '/opt/prn/runtime/watchdog.mjs', userHome: '/home/test' };
  const linux = startupDefinition({ ...config, platform: 'linux' });
  assert.match(linux.content, /Restart=on-failure/); assert.match(linux.content, /\$\$cash%%/);
  assert.match(linux.file.replaceAll('\\', '/'), /\.config\/systemd\/user\//);
  assert.deepEqual(linux.commands[1][1].slice(0, 2), ['--user', 'enable']);
  assert.ok(!linux.commands.flat(2).includes('--now'));
  const mac = startupDefinition({ ...config, platform: 'darwin' });
  assert.match(mac.content, /SuccessfulExit<\/key><false\/>/); assert.match(mac.content, /&quot;quoted&quot;/);
  const windows = startupDefinition({ home: "C:\\PRNext's data", node: 'C:\\Program Files\\nodejs\\node.exe', watchdog: 'C:\\my app\\watchdog.mjs', userHome: 'C:\\Users\\test', platform: 'win32' });
  assert.match(windows.content, /-AtLogOn -User/); assert.match(windows.content, /-RunLevel Limited/);
  assert.match(windows.content, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(windows.extra.content, /-WindowStyle Hidden -Wait -PassThru/);
  assert.match(windows.extra.content, /PRNext''s data/);
  assert.ok(!windows.content.includes(' -Password '));
  assert.throws(() => startupDefinition({ ...config, home: 'path\ncode', platform: 'linux' }));
});

test('Windows startup scripts parse without executing or registering a task', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'prnext-startup-script-'));
  try {
    for (const remove of [false, true]) {
      const definition = startupDefinition({ home: "C:\\PRNext's data $literal", userHome: 'C:\\Users\\test', remove });
      for (const [index, content] of [definition.content, definition.extra.content].entries()) {
        const file = path.join(folder, `${remove}-${index}.ps1`); await writeFile(file, '\ufeff' + content);
        const parser = `$prnextTokens = $null; $prnextErrors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:PRNEXT_TEST_SCRIPT, [ref]$prnextTokens, [ref]$prnextErrors) | Out-Null; if ($prnextErrors.Count) { $prnextErrors | Out-String | Write-Error; exit 1 }`;
        await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { env: { ...process.env, PRNEXT_TEST_SCRIPT: file }, windowsHide: true, timeout: 10000 });
      }
    }
    const helper = path.join(folder, "helper é's $literal.mjs");
    await writeFile(helper, `import {writeFileSync} from 'node:fs';writeFileSync(new URL('received.json',import.meta.url),JSON.stringify(process.argv.slice(2)));`);
    const home = path.join(folder, "configuration é's $literal");
    const launch = startupDefinition({ home, watchdog: helper });
    const script = path.join(folder, 'launch.ps1');
    await writeFile(script, '\ufeff' + launch.extra.content);
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 15000 });
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'received.json'), 'utf8')), [home]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
