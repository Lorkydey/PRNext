import { spawn } from 'node:child_process';
import { readFile, realpath, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeHome, rpc, delay, environment, validName, validHealthPath } from './common.mjs';
import { resolveNativeBinary } from '../../native/resolve.mjs';

export const persistentHelp = `Persistent apps (ordinary prn start stays in the foreground):
  prn pstart [directory] [options]   Start a built app in the background
  prn prestart [name] [--all]        Check a new instance, switch traffic, drain the old
  prn pstop [name] [--all]           Stop apps and disable their automatic restoration
  prn pdelete [name] [--all]         Stop apps and remove their saved settings
  prn pstatus [name] [--json]        Show supervised apps (alias: plist)
  prn plogs [name] [--follow]        Read application logs (last 100 lines)
  prn plogs --supervisor            Read supervisor logs
  prn pstartup [--remove]           Enable or remove restoration at user login
  prn pdown                        Stop the supervisor; keep apps saved for restoration

pstart options: --name NAME --port 3000 --hostname 127.0.0.1 --workers 1
  --profile balanced|speed|memory|classic --inspect
  --health-path / --health-timeout 15000 --drain-timeout 30000 (milliseconds)
prestart/pstop/plogs default to the app in the current directory.
plogs options: --lines 100 --follow. App environment comes from its .env files.
State and logs: ~/.prnext/processes (override with PRNEXT_PM_HOME).
`;

export function parsePersistent(command, argv) {
  const allowed = command === 'pstart' ? ['name', 'port', 'hostname', 'workers', 'profile', 'inspect', 'health-path', 'health-timeout', 'drain-timeout']
    : command === 'plogs' ? ['follow', 'lines', 'supervisor'] : command === 'pstartup' ? ['remove']
    : ['pstatus', 'plist'].includes(command) ? ['json'] : ['prestart', 'pstop', 'pdelete'].includes(command) ? ['all'] : [];
  const flags = new Set(['inspect', 'follow', 'supervisor', 'remove', 'json', 'all']);
  const options = {}; let target;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('-')) {
      const key = arg.slice(2);
      if (!arg.startsWith('--') || !allowed.includes(key)) throw new Error(`Unknown ${command} option: ${arg}`);
      if (key in options) throw new Error(`Duplicate option: ${arg}`);
      if (flags.has(key)) options[key] = true;
      else { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${arg}`); options[key] = value; }
    } else { if (target !== undefined) throw new Error(`${command} accepts one ${command === 'pstart' ? 'directory' : 'app name'}`); target = arg; }
  }
  if (target && (options.all || options.supervisor || ['pstartup', 'pdown'].includes(command))) throw new Error('Choose an app name or a global option, not both.');
  for (const key of ['port', 'workers', 'health-timeout', 'drain-timeout', 'lines']) if (key in options) {
    const max = key === 'port' ? 65535 : key === 'workers' ? 64 : key === 'lines' ? 10000 : 60000;
    const min = key.endsWith('timeout') ? 100 : 1;
    if (!/^\d+$/.test(options[key]) || Number(options[key]) < min || Number(options[key]) > max) throw new Error(`--${key} must be between ${min} and ${max}`);
    options[key] = Number(options[key]);
  }
  if (options.name) validName(options.name);
  if (options['health-path']) validHealthPath(options['health-path']);
  if (command !== 'pstart' && target) validName(target);
  return { target, options };
}
async function ensure(connection) {
  let running;
  try { running = await rpc(connection, { command: 'ping' }, 1500); }
  catch (error) { if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error; }
  if (!running) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), connection.home], { cwd: connection.home, detached: true, windowsHide: true, stdio: 'ignore', env: environment() });
    child.on('error', () => {}); child.unref();
  }
  for (let i = 0; i < 200; i++) {
    try { const result = await rpc(connection, { command: 'ping' }, 1500); if (result.version !== 1) throw new Error('Supervisor protocol mismatch. Run prn pdown before upgrading.'); if (result.ready) return; }
    catch (error) { if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error; }
    await delay(100);
  }
  throw new Error('Supervisor did not become ready. Check prn plogs --supervisor.');
}
async function offline(connection) {
  let saved;
  try { saved = JSON.parse(await readFile(path.join(connection.home, 'apps.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { daemonPid: null, apps: (saved?.apps || []).map(entry => ({ ...entry.config, enabled: entry.enabled, pid: null, state: 'supervisor-offline', starts: null })) };
}
async function tail(file, lines) {
  let text = '', current;
  for (const suffix of ['.3', '.2', '.1', '']) {
    let handle;
    try {
      handle = await open(file + suffix, 'r'); const info = await handle.stat();
      if (!suffix) current = info;
      const size = Math.min(info.size, 1024 * 1024);
      const buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, info.size - size);
      text = (text + buffer.toString()).slice(-1024 * 1024);
    } catch (error) { if (error.code !== 'ENOENT') throw error; } finally { await handle?.close(); }
  }
  return { text: text.split('\n').slice(-(lines + 1)).join('\n'), size: current?.size || 0, ino: current?.ino };
}
async function logs(connection, target, options) {
  let name = target;
  if (!options.supervisor && !name) {
    const root = await realpath(process.cwd());
    const saved = await offline(connection);
    const matching = saved.apps.filter(app => app.root === root);
    if (matching.length !== 1) throw new Error('Choose an app name from prn pstatus.');
    name = matching[0].name;
  }
  const file = path.join(connection.home, 'logs', options.supervisor ? 'supervisor.log' : `app-${validName(name)}.log`);
  const output = await tail(file, options.lines || 100);
  process.stdout.write(output.text || 'No logs yet.\n');
  if (!options.follow) return;
  let offset = output.size, ino = output.ino, stopped = false;
  const stop = () => { stopped = true; }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      await delay(250); let handle;
      try {
        handle = await open(file, 'r'); const info = await handle.stat();
        if (info.ino !== ino || info.size < offset) offset = 0;
        ino = info.ino;
        while (offset < info.size && !stopped) {
          const buffer = Buffer.alloc(Math.min(65536, info.size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break; offset += bytesRead;
          if (!process.stdout.write(buffer.subarray(0, bytesRead))) await new Promise(resolve => process.stdout.once('drain', resolve));
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; } finally { await handle?.close(); }
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
export async function persistentCommand(command, argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(persistentHelp); return; }
  const { target, options } = parsePersistent(command, argv);
  const connection = await initializeHome();
  if (command === 'pstartup') {
    const { startup } = await import('./startup.mjs');
    console.log(await startup(connection.home, { remove: !!options.remove })); return;
  }
  if (command === 'plogs') { await logs(connection, target, options); return; }
  if (command === 'pdown') {
    try {
      const owner = await rpc(connection, { command: 'ping' });
      const result = await rpc(connection, { command: 'shutdown' });
      for (let i = 0; i < 100; i++) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (!alive) { console.log(result); return; }
        await delay(50);
      }
      throw new Error('Supervisor is still exiting. Check prn pstatus before starting another instance.');
    }
    catch (error) { if (error.code !== 'ECONNREFUSED') throw error; console.log('Supervisor is already stopped.'); }
    return;
  }
  if (['pstatus', 'plist'].includes(command)) {
    let report;
    try { report = await rpc(connection, { command: 'status' }); }
    catch (error) { if (error.code !== 'ECONNREFUSED') throw error; report = await offline(connection); }
    if (target) { report.apps = report.apps.filter(app => app.name === target); if (!report.apps.length) throw new Error(`Unknown persistent app: ${target}`); }
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else if (!report.apps.length) console.log('No persistent apps. Run prn pstart in a built project.');
    else for (const app of report.apps) console.log(`${app.name}: ${app.state} | ${app.hostname}:${app.port} | pid ${app.pid || '—'}${app.error ? ' | ' + app.error : ''}`);
    return;
  }
  let request;
  if (command === 'pstart') {
    const root = await realpath(path.resolve(target || '.'));
    const name = validName(options.name || path.basename(root).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 64));
    request = { command: 'start', config: { name, root, binary: await resolveNativeBinary(), node: process.execPath, port: options.port || 3000, hostname: options.hostname || '127.0.0.1', workers: options.workers || 1, profile: options.profile || process.env.PRNEXT_PROFILE || 'balanced', inspect: !!options.inspect, healthPath: options['health-path'] || '/', healthTimeout: options['health-timeout'] || 15000, drainTimeout: options['drain-timeout'] || 30000 } };
  } else request = { command: ({ prestart: 'restart', pstop: 'stop', pdelete: 'delete' })[command], name: target, all: !!options.all, root: target || options.all ? undefined : await realpath(process.cwd()) };
  await ensure(connection);
  const report = await rpc(connection, request);
  for (const app of Array.isArray(report) ? report : [report]) console.log(`${app.name}: ${app.state} | ${app.hostname}:${app.port}${app.pid ? ' | pid ' + app.pid : ''}`);
}
