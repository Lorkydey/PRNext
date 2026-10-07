import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { standaloneFixture, freePort, repositoryRoot, binary } from './support.mjs';
import { build } from '../packages/prnext/build/index.mjs';
import { initializeHome, rpc } from '../packages/prnext/runtime/persistent/common.mjs';

const execute = promisify(execFile);
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
  assert.fail(message);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('persistent CLI supervises apps, reloads builds while streaming, rolls back failed health checks, and restores saved state', { timeout: 180000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'prnext persistent é-'));
  const fixture = await standaloneFixture('prnext persistent app é-');
  const port = await freePort(), otherPort = await freePort();
  const native = binary;
  const env = { ...process.env, PRNEXT_PM_HOME: home, PRNEXT_BINARY: native, PRIVATE_CALLER_SECRET: 'do-not-save-this' };
  const cli = async (...args) => (await execute(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), ...args], { env, cwd: fixture.root, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 })).stdout;
  const connection = await initializeHome(home);
  const status = async () => JSON.parse(await cli('pstatus', '--json'));
  const get = route => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(10000) });
  const startArgs = ['pstart', fixture.root, '--name', 'web', '--port', String(port), '--health-path', '/api/health'];
  let processIds = [];
  try {
    await mkdir(path.join(fixture.root, 'pages/api'));
    await writeFile(path.join(fixture.root, '.env.production'), 'APP_VALUE=from-project\n');
    await writeFile(path.join(fixture.root, 'pages/api/health.js'), `export default function handler(req,res){res.status(process.env.APP_HEALTH==='bad'?500:200).json({ok:true})}`);
    const stateSource = version => `export default function handler(req,res){console.log('application-log-${version}');res.setHeader('Set-Cookie',['one=1','two=2']);res.json({version:${version},worker:process.pid,server:process.ppid,env:process.env.APP_VALUE,private:process.env.PRIVATE_CALLER_SECRET||null,host:req.headers.host})}`;
    await writeFile(path.join(fixture.root, 'pages/api/state.js'), stateSource(1));
    await writeFile(path.join(fixture.root, 'pages/api/stream.js'), `export default async function handler(req,res){res.setHeader('Content-Type','text/plain');res.write('first');await new Promise(resolve=>setTimeout(resolve,2400));res.end('last')}`);
    await build(fixture.root);
    const concurrentStarts = await Promise.all([cli(...startArgs), cli(...startArgs)]);
    for (const output of concurrentStarts) assert.match(output, /web: online/);
    await assert.rejects(cli('pstart', fixture.root, '--name', 'WEB', '--port', String(otherPort)), /distinct regardless of letter case/);
    const first = await (await get('/api/state')).json();
    processIds.push(first.server, first.worker);
    assert.equal(first.env, 'from-project'); assert.equal(first.private, null); assert.equal(first.host, `127.0.0.1:${port}`);
    // pstart is idempotent; two callers do not create a second daemon/app.
    await Promise.all([cli(...startArgs), cli(...startArgs)]);
    assert.equal((await (await get('/api/state')).json()).server, first.server);
    const response = await get('/api/state'); assert.equal(response.headers.getSetCookie().length, 2);
    await response.arrayBuffer();
    const stream = await get('/api/stream');
    const reader = stream.body.getReader(); assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
    const reload = cli('prestart', 'web');
    let requests = 0, polling = true;
    const traffic = (async () => { while (polling) { const res = await get('/api/state'); assert.equal(res.status, 200); await res.arrayBuffer(); requests++; await delay(40); } })();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'last'); assert.equal((await reader.read()).done, true);
    await reload; polling = false; await traffic; assert.ok(requests >= 5);
    const second = await (await get('/api/state')).json(); assert.notEqual(second.server, first.server);
    await until(() => !alive(first.server) && !alive(first.worker), 'Previous process tree survived draining');
    await writeFile(path.join(fixture.root, '.env.production'), 'APP_VALUE=from-project\nAPP_HEALTH=bad\n');
    await assert.rejects(cli('prestart', 'web'), /Health check .* HTTP 500/);
    assert.equal((await (await get('/api/state')).json()).server, second.server, 'Unhealthy replacement must leave previous generation serving');
    await writeFile(path.join(fixture.root, '.env.production'), 'APP_VALUE=from-project\n');
    // Build publication must not remove modules/static assets of the live generation.
    await writeFile(path.join(fixture.root, 'pages/api/state.js'), stateSource(2));
    await build(fixture.root);
    assert.equal((await (await get('/api/state')).json()).version, 1);
    await cli('prestart', 'web'); assert.equal((await (await get('/api/state')).json()).version, 2);
    const crash = await (await get('/api/state')).json(); process.kill(crash.server, 'SIGKILL');
    await until(async () => { try { const res = await get('/api/state'); return res.status === 200 && (await res.json()).server !== crash.server; } catch { return false; } }, 'Crashed app was not restarted');
    assert.match(await cli('plogs', 'web', '--lines', '20'), /application-log-2/);
    const saved = await readFile(path.join(home, 'apps.json'), 'utf8'); assert.ok(!saved.includes('do-not-save-this'));
    await cli('pstart', fixture.root, '--name', 'other', '--port', String(otherPort), '--health-path', '/api/health');
    const manager = await rpc(connection, { command: 'ping' });
    const beforeCrash = await (await get('/api/state')).json();
    process.kill(manager.daemonPid, 'SIGKILL');
    await until(async () => { try { const res = await get('/api/state'); return res.status === 200 && (await res.json()).server !== beforeCrash.server; } catch { return false; } }, 'Watchdog did not restore apps after supervisor crash');
    await until(() => !alive(beforeCrash.server) && !alive(beforeCrash.worker), 'Orphan processes survived supervisor crash');
    await cli('pstop', 'web'); assert.equal((await status()).apps.find(app => app.name === 'web').state, 'stopped');
    assert.equal((await fetch(`http://127.0.0.1:${otherPort}/api/state`)).status, 200);
    await assert.rejects(get('/api/state'));
    await cli('pdown');
    await until(async () => { try { await rpc(connection, { command: 'ping' }, 500); return false; } catch { return true; } }, 'Supervisor did not stop');
    const restored = await cli('pstart', fixture.root, '--name', 'other', '--port', String(otherPort), '--health-path', '/api/health');
    assert.match(restored, /other: online/);
    assert.equal((await status()).apps.find(app => app.name === 'web').state, 'stopped', 'Stopped apps must remain stopped on restoration');
    await cli('prestart', 'web'); assert.equal((await get('/api/state')).status, 200);
    // Killing the outer watchdog closes IPC: the daemon must release both app
    // trees even without a graceful supervisor command.
    const outer = await rpc(connection, { command: 'ping' });
    const owned = [await (await get('/api/state')).json(), await (await fetch(`http://127.0.0.1:${otherPort}/api/state`)).json()].flatMap(value => [value.server, value.worker]);
    process.kill(outer.pid, 'SIGKILL');
    await until(() => [outer.daemonPid, ...owned].every(pid => !alive(pid)), 'Daemon or applications survived watchdog termination');
    await cli(...startArgs);
    assert.equal((await get('/api/state')).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${otherPort}/api/state`)).status, 200);
    processIds = [await (await get('/api/state')).json(), await (await fetch(`http://127.0.0.1:${otherPort}/api/state`)).json()].flatMap(value => [value.server, value.worker]);
    await cli('pdelete', '--all'); assert.deepEqual((await status()).apps, []);
    await until(() => processIds.every(pid => !alive(pid)), 'Processes survived pdelete');
  } finally {
    const owner = await rpc(connection, { command: 'ping' }, 1000).catch(() => null);
    await rpc(connection, { command: 'shutdown' }, 90000).catch(() => {});
    await until(async () => { try { await rpc(connection, { command: 'ping' }, 500); return false; } catch { return true; } }, 'Test supervisor is still running').catch(() => {});
    if (owner) await until(() => !alive(owner.pid), 'Test watchdog has not exited');
    // All removals are within the test-owned temporary roots.
    await fixture.remove(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
