import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);
const ps = value => `'${value.replaceAll("'", "''")}'`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const systemd = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
// Windows CommandLineToArgvW quoting, followed separately by PowerShell quoting.
const windows = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export function startupDefinition({ platform = process.platform, home, node = process.execPath, watchdog = fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), userHome = homedir(), remove = false }) {
  for (const value of [home, node, watchdog, userHome]) if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Startup paths cannot contain control characters');
  const id = createHash('sha256').update(platform === 'win32' ? home.toLowerCase() : home).digest('hex').slice(0, 16);
  const marker = `PRNext persistent supervisor ${id}`;
  const name = `prnext-${id}`;
  if (platform === 'linux') {
    const file = path.join(userHome, '.config/systemd/user', `${name}.service`);
    return { marker, file, content: `# ${marker}\n[Unit]\nDescription=${marker}\n\n[Service]\nType=simple\nExecStart=${[node, watchdog, home].map(systemd).join(' ')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=70\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`,
      commands: remove ? [['systemctl', ['--user', 'disable', `${name}.service`]]] : [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', `${name}.service`]]],
      note: 'Restoration enabled for your next user login. For startup before login on a server, an administrator can enable linger for this account (loginctl enable-linger). No linger setting was changed.' };
  }
  if (platform === 'darwin') {
    const file = path.join(userHome, 'Library/LaunchAgents', `dev.prnext.${id}.plist`);
    return { marker, file, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>dev.prnext.${id}</string>\n<key>Description</key><string>${marker}</string>\n<key>ProgramArguments</key><array>${[node, watchdog, home].map(value => '<string>' + xml(value) + '</string>').join('')}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ExitTimeOut</key><integer>70</integer>\n</dict></plist>\n`, commands: [],
      note: 'Restoration enabled for your next macOS login. The LaunchAgent restarts a failed supervisor while your session is active.' };
  }
  if (platform === 'win32') {
    const file = path.join(home, 'startup.ps1');
    const launch = path.join(home, 'launch.ps1');
    const launcher = `# ${marker}\n$ErrorActionPreference = 'Stop'\n$prnextProcess = Start-Process -FilePath ${ps(node)} -ArgumentList ${ps([watchdog, home].map(windows).join(' '))} -WindowStyle Hidden -Wait -PassThru\nexit $prnextProcess.ExitCode\n`;
    const args = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windows(launch)}`;
    const content = `# ${marker}\n$ErrorActionPreference = 'Stop'\n$prnextTaskName = ${ps(name)}\n$prnextExisting = Get-ScheduledTask -TaskName $prnextTaskName -ErrorAction SilentlyContinue\nif ($prnextExisting -and $prnextExisting.Description -ne ${ps(marker)}) { throw 'This task name belongs to another application.' }\n` + (remove
      ? `if ($prnextExisting) { Unregister-ScheduledTask -TaskName $prnextTaskName -Confirm:$false }\n`
      : `$prnextUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n$prnextAction = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ${ps(args)}\n$prnextTrigger = New-ScheduledTaskTrigger -AtLogOn -User $prnextUser\n$prnextPrincipal = New-ScheduledTaskPrincipal -UserId $prnextUser -LogonType Interactive -RunLevel Limited\n$prnextSettings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\nRegister-ScheduledTask -TaskName $prnextTaskName -Description ${ps(marker)} -Action $prnextAction -Trigger $prnextTrigger -Principal $prnextPrincipal -Settings $prnextSettings -Force | Out-Null\n`);
    return { marker, file, content, extra: { file: launch, content: launcher }, commands: [['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]]],
      note: 'Restoration enabled for your next Windows login, using a hidden task for your account. It retries supervisor failures every minute. This is not a service that runs before login.' };
  }
  throw new Error('Automatic startup supports Windows, macOS and Linux with systemd.');
}
async function owned(file, marker) {
  try { if (!(await readFile(file, 'utf8')).includes(marker)) throw new Error(`Refusing to replace a startup file not owned by PRNext: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function startup(home, { remove = false } = {}) {
  const definition = startupDefinition({ home, remove });
  await owned(definition.file, definition.marker);
  if (definition.extra) await owned(definition.extra.file, definition.marker);
  if (!remove || process.platform === 'win32') {
    await mkdir(path.dirname(definition.file), { recursive: true, mode: 0o700 });
    // Windows PowerShell 5.1 needs a UTF-8 BOM to preserve non-ASCII paths.
    const encodingMarker = process.platform === 'win32' ? '\ufeff' : '';
    await writeFile(definition.file, encodingMarker + definition.content, { mode: 0o600 });
    if (definition.extra && !remove) await writeFile(definition.extra.file, encodingMarker + definition.extra.content, { mode: 0o600 });
  }
  for (const [file, args] of definition.commands) {
    try { await execute(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch (error) { throw new Error(`Unable to ${remove ? 'remove' : 'enable'} startup: ${error.stderr?.trim() || error.message}. The generated definition is at ${definition.file}.`); }
  }
  if (remove) {
    await rm(definition.file, { force: true });
    if (definition.extra) await rm(definition.extra.file, { force: true });
    if (process.platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload'], { timeout: 30000 });
    return 'Automatic startup removed. Running apps remain available; use prn pstop to stop them.';
  }
  return definition.note + '\nRun prn pstartup again after moving or upgrading Node or PRNext.';
}
