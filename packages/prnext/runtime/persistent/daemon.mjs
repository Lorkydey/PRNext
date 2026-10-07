import { spawn } from 'node:child_process';
import { Agent, createServer, request } from 'node:http';
import { cp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { readBuildDirectory } from '../build-directory.mjs';
import { atomicJSON, delay, environment, validName, validHealthPath } from './common.mjs';
import { RotatingLog } from './logger.mjs';

const home = process.argv[2];
const registry = path.join(home, 'apps.json');
const owner = createHash('sha256').update(home).digest('hex').slice(0, 16);
const apps = new Map();
let closing = false, sequence = Promise.resolve();
const send = message => { if (process.connected) process.send(message); };

function validate(config) {
  validName(config.name); validHealthPath(config.healthPath);
  if (!path.isAbsolute(config.root) || !path.isAbsolute(config.binary) || !path.isAbsolute(config.node)) throw new Error('Application, Node and native executable paths must be absolute');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('--port must be between 1 and 65535');
  if (typeof config.hostname !== 'string' || !config.hostname || /[\s\x00-\x1f]/.test(config.hostname)) throw new Error('Choose a valid --hostname');
  if (!Number.isInteger(config.workers) || config.workers < 1 || config.workers > 64) throw new Error('--workers must be between 1 and 64');
  if (!['balanced', 'speed', 'memory', 'classic', 'standard', 'compact'].includes(config.profile)) throw new Error('Choose --profile balanced, speed, memory or classic');
  for (const key of ['healthTimeout', 'drainTimeout']) if (!Number.isInteger(config[key]) || config[key] < 100 || config[key] > 60000) throw new Error(`${key} must be between 100 and 60000 milliseconds`);
}
async function persist() {
  await atomicJSON(registry, { version: 1, apps: [...apps.values()].map(app => ({ config: app.config, enabled: app.enabled, snapshots: [...app.snapshots] })) });
}
function newApp(config, enabled = false) {
  return { config, enabled, snapshots: new Set(), active: null, generations: new Set(), gateway: null, sockets: new Set(), state: 'stopped', error: null, starts: 0, failures: [], retry: null,
    log: new RotatingLog(path.join(home, 'logs', `app-${config.name}.log`)) };
}
function summary(app) {
  return { name: app.config.name, root: app.config.root, hostname: app.config.hostname, port: app.config.port,
    state: app.state, enabled: app.enabled, pid: app.active?.child.pid || null, starts: app.starts,
    activeRequests: [...app.generations].reduce((sum, generation) => sum + generation.active, 0),
    draining: [...app.generations].filter(generation => generation !== app.active).length,
    buildId: app.active?.buildId || null, startedAt: app.active?.startedAt || null, error: app.error,
    log: path.join(home, 'logs', `app-${app.config.name}.log`) };
}
function hopHeaders(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const key of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...nominated]) delete result[key];
  return result;
}
async function listen(app) {
  if (app.gateway) return;
  const server = createServer({ requestTimeout: 300000, headersTimeout: 30000 }, (incoming, outgoing) => {
    const generation = app.active;
    if (!incoming.url.startsWith('/')) { outgoing.writeHead(400).end('Use a local request path.'); return; }
    if (!generation || generation.dead) { outgoing.writeHead(503, { 'retry-after': '1' }).end('Application is restarting.'); incoming.resume(); return; }
    if (generation.active >= 512) { outgoing.writeHead(503, { 'retry-after': '1' }).end('Application is busy.'); incoming.resume(); return; }
    generation.active++;
    const headers = hopHeaders(incoming.headers);
    // Preserve original Host and trusted reverse-proxy headers. Never invent
    // retry/replay behavior for POSTs or requests that have already streamed.
    const upstream = request({ host: '127.0.0.1', port: generation.port, method: incoming.method, path: incoming.url, headers, agent: generation.agent }, response => {
      outgoing.writeHead(response.statusCode, hopHeaders(response.headers));
      response.on('error', () => outgoing.destroy()); response.pipe(outgoing);
    });
    generation.requests.add(upstream);
    let released = false;
    const release = () => { if (released) return; released = true; generation.active--; generation.requests.delete(upstream); upstream.destroy(); };
    outgoing.once('finish', release); outgoing.once('close', release);
    incoming.once('aborted', () => outgoing.destroy());
    incoming.once('error', () => outgoing.destroy());
    upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502).end('Application connection closed.'); else outgoing.destroy(); });
    incoming.pipe(upstream);
  });
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('connection', socket => { app.sockets.add(socket); socket.once('close', () => app.sockets.delete(socket)); });
  server.maxConnections = 1024;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(app.config.port, app.config.hostname, resolve); });
  server.on('error', error => { app.error = error.message; app.log.message(error.message); });
  app.gateway = server;
}
async function removeSnapshot(app, relative) {
  // Only delete a directory generated by this manager inside this exact root.
  const prefix = `.prnext-persistent/${owner}/`;
  if (!relative.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(relative.slice(prefix.length))) throw new Error('Invalid managed build path');
  const root = await realpath(app.config.root);
  const target = path.join(root, relative);
  const actual = await realpath(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (actual && (actual !== target && (process.platform !== 'win32' || actual.toLowerCase() !== target.toLowerCase()))) throw new Error('Managed build path must not be a symbolic link');
  if (actual) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.snapshots.delete(relative);
}
async function snapshot(app) {
  const root = await realpath(app.config.root);
  const dist = await readBuildDirectory(root);
  if (dist.split('/')[0] === '.prnext-persistent') throw new Error('distDir cannot use .prnext-persistent');
  const source = path.join(root, dist);
  const before = await readFile(path.join(source, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(before);
  if (manifest.dev || manifest.version !== 1 || !Array.isArray(manifest.routes)) throw new Error('Run prn build before prn pstart; a production build is required.');
  const relative = `.prnext-persistent/${owner}/${randomUUID()}`;
  app.snapshots.add(relative); await persist();
  const destination = path.join(root, relative);
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    const container = await realpath(path.dirname(destination));
    if (path.relative(root, container).startsWith('..') || path.isAbsolute(path.relative(root, container))) throw new Error('Managed builds must remain inside the project');
    await cp(source, destination, { recursive: true, verbatimSymlinks: true, filter: file => file !== path.join(source, 'standalone') });
    if (await readFile(path.join(source, 'manifest.json'), 'utf8') !== before || await readFile(path.join(destination, 'manifest.json'), 'utf8') !== before) throw new Error('Build changed while copying. Finish prn build, then retry prn prestart.');
    return { relative, buildId: manifest.buildId || null };
  } catch (error) { await removeSnapshot(app, relative); throw error; }
}
function health(generation, config, timeout) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: generation.port, path: config.healthPath, method: 'GET', headers: { host: `${config.hostname.includes(':') ? '[' + config.hostname + ']' : config.hostname}:${config.port}` }, signal: AbortSignal.timeout(timeout) }, res => {
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      res.destroy(); ok ? resolve() : reject(new Error(`Health check ${config.healthPath} returned HTTP ${res.statusCode}`));
    });
    req.once('error', reject); req.end();
  });
}
async function stopGeneration(app, generation, drain = true) {
  if (generation.stopping) return generation.stopping;
  generation.expected = true;
  generation.stopping = (async () => {
    const deadline = Date.now() + (drain ? app.config.drainTimeout : 0);
    while (generation.active && Date.now() < deadline && !generation.dead) await delay(25);
    for (const req of generation.requests) req.destroy();
    generation.agent.destroy();
    generation.child.stdin?.end();
    await Promise.race([generation.closed, delay(3000)]);
    if (!generation.dead) generation.child.kill('SIGKILL');
    if (process.platform !== 'win32' && generation.child.pid) { try { process.kill(-generation.child.pid, 'SIGKILL'); } catch {} }
    await generation.closed;
    app.generations.delete(generation);
    await removeSnapshot(app, generation.relative);
  })();
  return generation.stopping;
}
function retry(app, error) {
  if (!app.enabled || closing || app.retry) return;
  app.error = error.message; app.state = 'restarting';
  const now = Date.now(); app.failures = app.failures.filter(time => now - time < 300000); app.failures.push(now);
  if (app.failures.length >= 10) { app.state = 'errored'; app.log.message('Stopped automatic retries after 10 failures in 5 minutes. Run prn prestart to retry.'); return; }
  const wait = Math.min(30000, 500 * 2 ** Math.min(app.failures.length - 1, 6));
  app.log.message(`Restart in ${wait} ms: ${error.message}`);
  app.retry = setTimeout(() => {
    app.retry = null;
    sequence = sequence.then(async () => {
      if (!app.enabled || closing || app.active) return;
      try { await activate(app); } catch (error) { retry(app, error); }
    }).catch(error => app.log.message(error.stack));
  }, wait);
}
async function launch(app) {
  const config = app.config;
  const build = await snapshot(app);
  const child = spawn(config.binary, ['start', config.root, '--build-dir', build.relative, '--hostname', '127.0.0.1', '--port', '0', '--node', config.node, '--workers', String(config.workers), '--profile', config.profile, '--shutdown-on-stdin-eof'], {
    cwd: config.root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...environment(), NODE_ENV: 'production', ...(config.inspect ? { PRNEXT_INSPECT_DIR: path.join(config.root, '.prnext-cache/inspect') } : {}) },
  });
  child.stdin.on('error', () => {});
  const generation = { child, ...build, active: 0, requests: new Set(), agent: new Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 16, timeout: 30000 }), dead: false, expected: false, port: null, startedAt: Date.now() };
  app.generations.add(generation);
  if (child.pid) send({ type: 'child', pid: child.pid, running: true });
  let output = '', failure;
  const started = chunk => { output = (output + chunk.toString()).slice(-8192); generation.port ||= Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]) || null; };
  child.stdout.on('data', started);
  child.once('error', error => { failure = error; });
  child.once('exit', () => {
    generation.dead = true;
    // On Unix an abruptly killed native parent cannot close descendants itself.
    // Kill its private group before waiting for inherited log pipes to close.
    if (!generation.expected && process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  });
  app.log.attach(child.stdout, 'stdout'); app.log.attach(child.stderr, 'stderr');
  generation.closed = new Promise(resolve => child.once('close', (code, signal) => {
    generation.dead = true;
    if (child.pid) send({ type: 'child', pid: child.pid, running: false });
    if (app.active === generation) app.active = null;
    if (!generation.expected) {
      app.log.message(`Process ${child.pid || 'unknown'} exited (${signal || code}).`);
      if (generation.ready) {
        // Serialize recovery and cleanup with explicit lifecycle commands.
        sequence = sequence.then(async () => { await stopGeneration(app, generation, false); await persist(); retry(app, new Error(`Application exited (${signal || code})`)); }).catch(error => app.log.message(error.stack));
      }
    }
    resolve();
  }));
  try {
    const deadline = Date.now() + config.healthTimeout;
    while (!generation.port) {
      if (failure || generation.dead) throw failure || new Error('Application exited before listening. Check prn plogs.');
      if (Date.now() >= deadline) throw new Error('Application did not listen before --health-timeout');
      await delay(25);
    }
    await health(generation, config, Math.max(1, deadline - Date.now()));
    if (generation.dead) throw new Error('Application exited during its health check');
    generation.ready = true; app.starts++;
    return generation;
  } catch (error) { await stopGeneration(app, generation, false); throw error; }
  finally { child.stdout.off('data', started); }
}
async function activate(app) {
  await listen(app);
  const previous = app.active;
  const wasEnabled = app.enabled;
  let next;
  app.state = previous ? 'reloading' : 'starting';
  try {
    next = await launch(app);
    app.enabled = true;
    await persist();
    if (next.dead) throw new Error('Application exited before traffic could switch');
    app.active = next; app.state = 'online'; app.error = null;
    app.log.message(`Ready: pid ${next.child.pid}, build ${next.buildId || 'unknown'}, ${app.config.hostname}:${app.config.port}`);
  } catch (error) {
    if (next) await stopGeneration(app, next, false).catch(cleanup => app.log.message(cleanup.message));
    app.enabled = wasEnabled;
    app.state = previous && !previous.dead ? 'online' : 'errored'; app.error = error.message;
    await persist().catch(saved => app.log.message(saved.message));
    app.log.message(`Start failed; ${previous && !previous.dead ? 'previous generation remains active' : 'no healthy generation'}: ${error.message}`);
    throw error;
  }
  if (previous) {
    await stopGeneration(app, previous).catch(error => app.log.message(`Previous build cleanup: ${error.message}`));
    await persist();
  }
}
async function stopApp(app) {
  app.enabled = false; clearTimeout(app.retry); app.retry = null;
  await persist();
  app.state = 'stopping'; app.active = null;
  const gateway = app.gateway; app.gateway = null;
  const closed = gateway ? new Promise(resolve => gateway.close(resolve)) : Promise.resolve();
  gateway?.closeIdleConnections();
  await Promise.all([...app.generations].map(generation => stopGeneration(app, generation)));
  for (const socket of app.sockets) socket.destroy();
  await closed; app.state = 'stopped'; app.error = null; await persist();
  app.log.message('Stopped.');
}
function select(message) {
  const selected = message.all ? [...apps.values()] : [...apps.values()].filter(app => message.name ? app.config.name === message.name : app.config.root === message.root);
  if (!selected.length && !message.all) throw new Error('No matching persistent app. Run prn pstatus to see app names.');
  if (selected.length > 1 && !message.all) throw new Error('Several apps use this directory. Choose an app name.');
  return selected;
}
async function command(message) {
  if (message.command === 'status') return { daemonPid: process.pid, apps: [...apps.values()].map(summary) };
  if (message.command === 'start') {
    validate(message.config);
    message.config.root = await realpath(message.config.root);
    let app = apps.get(message.config.name);
    if (app) {
      if (JSON.stringify(app.config) !== JSON.stringify(message.config)) throw new Error('This app name already has different settings. Use prn pdelete, then prn pstart with the new settings.');
      if (app.active) return summary(app);
    } else {
      if (apps.size >= 128) throw new Error('The supervisor supports up to 128 apps');
      if ([...apps.keys()].some(name => name.toLowerCase() === message.config.name.toLowerCase())) throw new Error('App names must be distinct regardless of letter case.');
      app = newApp(message.config); apps.set(message.config.name, app);
    }
    clearTimeout(app.retry); app.retry = null; app.failures = [];
    try { await activate(app); }
    catch (error) { await stopApp(app); app.state = 'errored'; app.error = error.message; throw error; }
    return summary(app);
  }
  const selected = select(message);
  if (message.command === 'restart') {
    for (const app of selected) { clearTimeout(app.retry); app.retry = null; app.failures = []; await activate(app); }
  } else if (message.command === 'stop' || message.command === 'delete') {
    for (const app of selected) { await stopApp(app); if (message.command === 'delete') { apps.delete(app.config.name); app.log.end(); } }
    await persist();
  } else throw new Error('Unknown supervisor command');
  return selected.map(summary);
}
async function shutdown() {
  if (closing) return; closing = true;
  await sequence;
  // A supervisor shutdown preserves each enabled flag for the next launch.
  await Promise.all([...apps.values()].map(async app => {
    clearTimeout(app.retry); app.active = null; app.gateway?.close();
    await Promise.all([...app.generations].map(generation => stopGeneration(app, generation)));
    for (const socket of app.sockets) socket.destroy();
    app.log.end();
  }));
  await persist(); process.exit(0);
}
process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('message', message => {
  if (message.type === 'heartbeat') { send({ type: 'heartbeat' }); return; }
  if (message.type === 'shutdown') { void shutdown(); return; }
  if (message.type !== 'request') return;
  const perform = async () => {
    try { if (closing) throw new Error('Supervisor is shutting down'); send({ type: 'reply', id: message.id, ok: true, value: await command(message.request) }); }
    catch (error) { send({ type: 'reply', id: message.id, ok: false, error: error.message }); }
  };
  if (message.request.command === 'status') void perform(); else sequence = sequence.then(perform);
});
try {
  let saved;
  try { saved = JSON.parse(await readFile(registry, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved && (saved.version !== 1 || !Array.isArray(saved.apps) || saved.apps.length > 128)) throw new Error('Unsupported persistent application registry');
  for (const entry of saved?.apps || []) {
    validate(entry.config);
    if ([...apps.keys()].some(name => name.toLowerCase() === entry.config.name.toLowerCase())) throw new Error('Duplicate app names in persistent registry');
    const app = newApp(entry.config, entry.enabled); apps.set(app.config.name, app);
    app.snapshots = new Set(entry.snapshots || []);
    for (const relative of app.snapshots) await removeSnapshot(app, relative).catch(error => app.log.message(error.message));
  }
  sequence = sequence.then(async () => {
    for (const app of apps.values()) if (app.enabled) { try { await activate(app); } catch (error) { retry(app, error); } }
  });
  send({ type: 'ready' });
} catch (error) { console.error(error.stack); process.exit(1); }
