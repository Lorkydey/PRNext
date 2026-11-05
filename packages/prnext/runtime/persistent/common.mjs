import { mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { rename } from '../fs.mjs';
import { requestLoopback } from '../loopback-rpc.mjs';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const homeDirectory = () => path.resolve(process.env.PRNEXT_PM_HOME || path.join(homedir(), '.prnext', 'processes'));
export async function initializeHome(directory = homeDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const home = await realpath(directory);
  const file = path.join(home, 'control.token');
  try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let token = '';
  // A second launcher may see the exclusive file between creation and write.
  for (let attempt = 0; attempt < 50; attempt++) {
    token = await readFile(file, 'utf8');
    if (token.length) break;
    await delay(20);
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid supervisor credentials in ${file}`);
  // A kernel-owned listener arbitrates simultaneous launches. No stale PID file
  // is used to kill a process or steal a filesystem lock after a crash.
  const key = process.platform === 'win32' ? home.toLowerCase() : home;
  const port = 35000 + createHash('sha256').update(key).digest().readUInt16BE(0) % 20000;
  return { home, token, port };
}
export async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export function environment() {
  const allowed = /^(?:path|home|userprofile|systemroot|windir|temp|tmp|tmpdir|lang|lc_all|localappdata|appdata|pathext|comspec)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
}
export function validName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Choose an app name of 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.');
  return value;
}
export function validHealthPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f#]/.test(value) || value.length > 2048) throw new Error('--health-path must be a local URL path such as /api/health');
  return value;
}
export async function rpc(connection, request, timeout = 120000) {
  try { return await requestLoopback(connection, request, { context: 'persistent-supervisor', timeout }); }
  catch (error) {
    if (error.code === 'ERR_PRNEXT_PEER_AUTH') error.message = 'Cannot authenticate the supervisor control listener. If an older PRNext supervisor is running, stop it with that version\'s prn pdown before upgrading; saved apps are preserved.';
    else if (error.message === 'Loopback request timed out') error.message = 'Supervisor request timed out. Check prn plogs --supervisor.';
    throw error;
  }
}
