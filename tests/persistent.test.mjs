import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
const homePrefix = 'prnext persistent é-';
async function removeHome(home) {
  assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
  assert.ok(path.basename(home).startsWith(homePrefix));
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function availableHome(excludedPorts = []) {
  // This fixed control port is an OS resource, just like the app's freePort().
  // Select it after building, before either concurrent launcher is started.
  for (let attempt = 0; attempt < 50; attempt++) {
    const home = await mkdtemp(path.join(tmpdir(), homePrefix));
    let selected = false;
    const probe = net.createServer();
    try {
      const connection = await initializeHome(home);
      if (excludedPorts.includes(connection.port)) continue;
      try { await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(connection.port, '127.0.0.1', resolve); }); }
      catch (error) { if (['EADDRINUSE', 'EACCES'].includes(error.code)) continue; throw error; }
      await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
      selected = true;
      return { home, connection };
    } finally {
      if (probe.listening) await new Promise(resolve => probe.close(resolve));
      if (!selected) await removeHome(home);
    }
  }
  throw new Error('No available supervisor control port for an isolated test home.');
}

test('persistent CLI supervises apps, reloads builds while streaming, rolls back failed health checks, and restores saved state', { timeout: 180000 }, async () => {
  const fixture = await standaloneFixture('prnext persistent app é-');
  const port = await freePort(), otherPort = await freePort();
  const native = binary;
  const env = { ...process.env, PRNEXT_BINARY: native, PRIVATE_CALLER_SECRET: 'do-not-save-this' };
  const cli = async (...args) => (await execute(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), ...args], { env, cwd: fixture.root, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 })).stdout;
  let home, connection;
  const status = async () => JSON.parse(await cli('pstatus', '--json'));
  const get = route => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(10000) });
  const startArgs = ['pstart', fixture.root, '--name', 'web', '--port', String(port), '--health-path', '/api/health', '--rollback-window', '0'];
  let processIds = [];
  try {
    await mkdir(path.join(fixture.root, 'pages/api'));
    await writeFile(path.join(fixture.root, '.env.production'), 'APP_VALUE=from-project\n');
    await writeFile(path.join(fixture.root, 'pages/api/health.js'), `export default function handler(req,res){res.status(process.env.APP_HEALTH==='bad'?500:200).json({ok:true})}`);
    const stateSource = version => `export default function handler(req,res){console.log('application-log-${version}');res.setHeader('Set-Cookie',['one=1','two=2']);res.json({version:${version},worker:process.pid,server:process.ppid,env:process.env.APP_VALUE,private:process.env.PRIVATE_CALLER_SECRET||null,host:req.headers.host})}`;
    await writeFile(path.join(fixture.root, 'pages/api/state.js'), stateSource(1));
    await writeFile(path.join(fixture.root, 'pages/api/stream.js'), `export default async function handler(req,res){res.setHeader('Content-Type','text/plain');res.write('first');await new Promise(resolve=>setTimeout(resolve,2400));res.end('last')}`);
    await build(fixture.root);
    ({ home, connection } = await availableHome([port, otherPort])); env.PRNEXT_PM_HOME = home;
    const concurrentStarts = await Promise.all([cli(...startArgs), cli(...startArgs)]);
    for (const output of concurrentStarts) assert.match(output, /web: online/);
    await assert.rejects(cli('pstart', fixture.root, '--name', 'WEB', '--port', String(otherPort)), error => {
      const diagnostic=JSON.stringify({code:error.code,signal:error.signal,killed:error.killed,stdout:error.stdout,stderr:error.stderr});
      assert.equal(error.code,1,diagnostic);
      assert.equal(error.signal,null,diagnostic);
      assert.match(error.stderr,/distinct regardless of letter case/,diagnostic);
      return true;
    });
    const first = await (await get('/api/state')).json();
    const initialStatus=await status();
    const proxyPid=initialStatus.apps.find(app=>app.name==='web').proxyPid;
    assert.ok(alive(proxyPid),'pstart traffic uses a live native proxy process');
    assert.notEqual(proxyPid,initialStatus.daemonPid);
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
    const beforeProxyCrash=await status(),priorBackend=await(await get('/api/state')).json();
    process.kill(beforeProxyCrash.apps.find(app=>app.name==='web').proxyPid,'SIGKILL');
    await until(async()=>{try{const res=await get('/api/state');return res.status===200&&(await res.json()).server!==priorBackend.server;}catch{return false;}},'Watchdog did not restore apps after native proxy failure');
    await until(()=>!alive(priorBackend.server)&&!alive(priorBackend.worker),'Proxy failure left orphan backend processes');
    if(process.platform!=='win32'){
      const blocked=await status(),beforeTimeout=await(await get('/api/state')).json();
      process.kill(blocked.apps.find(app=>app.name==='web').proxyPid,'SIGSTOP');
      await assert.rejects(cli('pstatus','--json'),/timed out|closed|reset|unavailable|exited|EPIPE/i);
      await until(async()=>{try{const res=await get('/api/state');return res.status===200&&(await res.json()).server!==beforeTimeout.server;}catch{return false;}},'Watchdog did not recover an unresponsive native control plane');
      await until(()=>!alive(beforeTimeout.server)&&!alive(beforeTimeout.worker),'Timed-out control plane left orphan backend processes');
    }
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
  } catch (error) {
    const redact = value => [connection?.token, env.PRIVATE_CALLER_SECRET].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value ?? ''));
    const supervisor = home ? await readFile(path.join(home, 'logs/supervisor.log'), 'utf8').then(text => redact(text).slice(-16384), failure => ({ readError: failure.code || redact(failure.message) })) : null;
    const ping = connection ? await rpc(connection, { command: 'ping' }, 1000).then(({ version, pid, daemonPid, ready }) => ({ version, pid, daemonPid, ready }), failure => ({ error: redact(failure.message), code: failure.code })) : null;
    const diagnostic = { controlPort: connection?.port, ping, supervisor, command: { code: error.code, signal: error.signal, killed: error.killed, stdout: redact(error.stdout).slice(-8192), stderr: redact(error.stderr).slice(-8192) } };
    error.message = redact(error.message) + '\nPersistent test diagnostics before cleanup: ' + JSON.stringify(diagnostic);
    throw error;
  } finally {
    if (connection) {
      const owner = await rpc(connection, { command: 'ping' }, 1000).catch(() => null);
      await rpc(connection, { command: 'shutdown' }, 90000).catch(() => {});
      await until(async () => { try { await rpc(connection, { command: 'ping' }, 500); return false; } catch { return true; } }, 'Test supervisor is still running').catch(() => {});
      if (owner) await until(() => !alive(owner.pid), 'Test watchdog has not exited');
    }
    // All removals are within the test-owned temporary roots.
    await fixture.remove(); if (home) await removeHome(home);
  }
});

test('post-switch probation rolls back HTTP failures and crashes without replaying mutations or cutting drained responses', {timeout:120000}, async () => {
  const fixture=await standaloneFixture('prnext probation app-');
  const port=await freePort();let home,connection;
  const metricsToken='probation-native-metrics-0123456789abcdef';
  const projectEnv=generation=>`GENERATION=${generation}\nPRNEXT_METRICS_TOKEN=${metricsToken}\n`;
  const env={...process.env,PRNEXT_BINARY:binary};
  const cli=async(...args)=>(await execute(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),...args],{env,cwd:fixture.root,windowsHide:true,timeout:60000,maxBuffer:1024*1024})).stdout;
  const status=async()=>JSON.parse(await cli('pstatus','--json'));
  const get=(route,options)=>fetch(`http://127.0.0.1:${port}${route}`,{...options,signal:AbortSignal.timeout(15000)});
  const state=async()=>{const response=await get('/api/state');assert.equal(response.status,200);return response.json();};
  try{
    await mkdir(path.join(fixture.root,'pages/api'),{recursive:true});
    await writeFile(path.join(fixture.root,'pages/api/health.js'),`let calls=0;export default function handler(req,res){const failing=process.env.GENERATION==='delayed'&&++calls>1;res.status(failing?500:200).json({ok:!failing})}`);
    await writeFile(path.join(fixture.root,'pages/api/state.js'),`export default function handler(req,res){res.json({generation:process.env.GENERATION,server:process.ppid,worker:process.pid})}`);
    await writeFile(path.join(fixture.root,'pages/api/stream.js'),`export default async function handler(req,res){res.setHeader('Content-Type','text/plain');res.write('first:'+process.env.GENERATION);await new Promise(resolve=>setTimeout(resolve,6500));res.end(':last')}`);
    await writeFile(path.join(fixture.root,'pages/api/mutation.js'),`import{appendFileSync}from'node:fs';import path from'node:path';export default function handler(req,res){if(req.method!=='POST')return res.status(405).end();appendFileSync(path.join(process.cwd(),'mutations.txt'),req.headers['x-operation']+'\\n');res.write('accepted');setTimeout(()=>res.destroy(Error('test response lost after commit')),20)}`);
    await writeFile(path.join(fixture.root,'.env.production'),projectEnv('stable'));
    await build(fixture.root);
    ({home,connection}=await availableHome([port]));env.PRNEXT_PM_HOME=home;
    await cli('pstart',fixture.root,'--name','probation','--port',String(port),'--health-path','/api/health','--rollback-window','10000');
    const original=await state();assert.equal(original.generation,'stable');
    const metrics=await get('/_prnext/metrics',{headers:{authorization:`Bearer ${metricsToken}`,accept:'application/json'}});
    assert.equal(metrics.status,200,'Native monitoring settings must load from the scoped project env before spawn');
    assert.equal((await metrics.json()).http.enabled,true);
    assert.ok(!(await readFile(path.join(home,'apps.json'),'utf8')).includes(metricsToken),'Native telemetry credentials must not enter the persistent registry');

    await writeFile(path.join(fixture.root,'.env.production'),projectEnv('delayed'));
    await cli('prestart','probation');
    const replacement=await state();assert.equal(replacement.generation,'delayed');assert.notEqual(replacement.server,original.server);
    assert.ok((await status()).apps[0].rollback,'A real switch must enter the nonzero monitoring window');
    const stream=await get('/api/stream'),reader=stream.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(),'first:delayed');
    await assert.rejects(async()=>{const response=await get('/api/mutation',{method:'POST',headers:{'x-operation':'lost-response'}});await response.arrayBuffer();});
    await until(async()=>{const report=(await status()).apps[0];return report.pid===original.server&&report.error?.startsWith('Rolled back:');},'HTTP500 replacement did not roll back after the actual traffic switch');
    assert.deepEqual(await state(),original,'Rollback must restore the same healthy process, rather than restart or replay traffic');
    assert.equal(Buffer.from((await reader.read()).value).toString(),':last');assert.equal((await reader.read()).done,true);
    await until(()=>!alive(replacement.server)&&!alive(replacement.worker),'Failed replacement survived its drained responses');
    assert.equal(await readFile(path.join(fixture.root,'mutations.txt'),'utf8'),'lost-response\n','A response lost after a write must never cause an automatic mutation replay');

    await writeFile(path.join(fixture.root,'.env.production'),projectEnv('crash'));
    await cli('prestart','probation');
    const crashing=await state();assert.equal(crashing.generation,'crash');
    assert.ok((await status()).apps[0].rollback);
    process.kill(crashing.server,'SIGKILL');
    await until(async()=>{try{return(await status()).apps[0].pid===original.server;}catch{return false;}},'Crashed replacement did not restore the retained healthy generation');
    assert.deepEqual(await state(),original);
    await until(()=>!alive(crashing.server)&&!alive(crashing.worker),'Crashed replacement left an orphan worker');
    await delay(1200);
    assert.deepEqual(await state(),original,'Rolled-back builds must not be automatically retried');
    assert.equal(await readFile(path.join(fixture.root,'mutations.txt'),'utf8'),'lost-response\n');
    await cli('pdelete','probation');
  }finally{
    if(connection){
      const owner=await rpc(connection,{command:'ping'},1000).catch(()=>null);
      await rpc(connection,{command:'shutdown'},60000).catch(()=>{});
      if(owner)await until(()=>!alive(owner.pid),'Probation test watchdog survived cleanup');
    }
    await fixture.remove();if(home)await removeHome(home);
  }
});
