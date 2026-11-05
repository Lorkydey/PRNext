import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeHome, environment, delay } from './common.mjs';
import { RotatingLog } from './logger.mjs';
import { serveLoopback } from '../loopback-rpc.mjs';

const connection = await initializeHome(process.argv[2]);
const log = new RotatingLog(path.join(connection.home, 'logs', 'supervisor.log'));
const pending = new Map(), children = new Set(), sockets = new Set();
const shutdownReplies = [];
let daemon, ready = false, closing = false, counter = 0, heartbeat = Date.now(), failures = 0, restartTimer;
const server = createServer(socket => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  serveLoopback(socket, { token: connection.token, context: 'persistent-supervisor', handle: async message => {
      if (message.command === 'ping') return { version: 2, pid: process.pid, daemonPid: daemon?.pid || null, ready };
      if (message.command === 'shutdown') return new Promise(resolve => { shutdownReplies.push(resolve); void shutdown(); });
      if (!ready || !daemon?.connected) throw new Error('Supervisor is recovering. Retry shortly.');
      if (pending.size >= 32) throw new Error('Supervisor is busy. Retry shortly.');
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const reply = result => result.ok ? resolve(result.value) : reject(Error(result.error || 'Supervisor request failed'));
        pending.set(id, reply);
        socket.once('close', () => { pending.delete(id); reject(Error('Supervisor client disconnected')); });
        daemon.send({ type: 'request', id, request: message }, error => { if (error) { pending.delete(id); reject(error); } });
      });
  } });
});
server.maxConnections = 64;
try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(connection.port, '127.0.0.1', resolve); }); }
catch (error) {
  // Concurrent pstart calls can create two candidates. Only the listener owner
  // starts a daemon; a losing candidate never writes into the shared log.
  console.error(`Cannot bind supervisor control port ${connection.port}: ${error.message}`);
  log.destroy(); process.exit(1);
}
function killChildren() {
  for (const pid of children) { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch {} }
  children.clear();
}
function launch() {
  if (closing) return;
  ready = false; heartbeat = Date.now();
  const child = fork(fileURLToPath(new URL('./daemon.mjs', import.meta.url)), [connection.home], {
    cwd: connection.home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment(), execArgv: [],
  });
  daemon = child;
  log.attach(child.stdout, 'supervisor'); log.attach(child.stderr, 'supervisor');
  const started = Date.now();
  child.on('message', message => {
    if (message.type === 'ready') { ready = true; log.message(`Supervisor ready: watchdog ${process.pid}, daemon ${child.pid}`); }
    if (message.type === 'heartbeat') heartbeat = Date.now();
    if (message.type === 'child') { if (message.running) children.add(message.pid); else children.delete(message.pid); }
    if (message.type === 'reply') { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  child.on('error', error => log.message(error.message));
  child.once('exit', (code, signal) => {
    ready = false; killChildren();
    for (const reply of pending.values()) reply({ ok: false, error: 'Supervisor restarted during the command. Check prn pstatus before retrying.' });
    pending.clear();
    if (closing) return;
    failures = Date.now() - started > 60000 ? 1 : failures + 1;
    const wait = Math.min(30000, 500 * 2 ** Math.min(failures - 1, 6));
    log.message(`Supervisor exited (${signal || code}); restart in ${wait} ms.`);
    restartTimer = setTimeout(launch, wait);
  });
}
const pulse = setInterval(() => {
  if (!daemon?.connected || closing) return;
  if (Date.now() - heartbeat > 15000) { log.message('Supervisor stopped responding; restarting.'); daemon.kill('SIGKILL'); }
  else daemon.send({ type: 'heartbeat' }, () => {});
}, 1000);
async function shutdown() {
  if (closing) return; closing = true; ready = false;
  clearTimeout(restartTimer); clearInterval(pulse);
  if (daemon?.connected) {
    const exited = new Promise(resolve => daemon.once('exit', resolve));
    daemon.send({ type: 'shutdown' }, () => {});
    await Promise.race([exited, delay(65000)]);
    if (daemon.exitCode === null && !daemon.signalCode) daemon.kill('SIGKILL');
    await exited;
  }
  killChildren();
  log.message('Supervisor stopped.');
  await new Promise(resolve => log.end(resolve));
  server.close();
  for (const reply of shutdownReplies) reply('Supervisor stopped; enabled apps will return on the next launch.');
  await delay(50);
  for (const socket of sockets) socket.destroy();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
launch();
