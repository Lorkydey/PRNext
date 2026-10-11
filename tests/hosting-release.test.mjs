import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { standaloneFixture, binary } from './support.mjs';
import { build } from '../packages/prnext/build/index.mjs';

async function until(fn, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  assert.fail(message);
}

test('host: tenant isolation, progressive streams, cold bursts, overload, crash recovery and shutdown', { timeout: 180000 }, async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'prnext-host-release-'));
  const fixtures = [], requests = new Set(), recentResponses = [], evidence = { checks: [], coldBursts: [] };
  let child, closed, output = '';
  const config = path.join(folder, 'apps.json'), status = path.join(folder, 'apps.status.json');
  const snapshot = async () => { try { return JSON.parse(await readFile(status, 'utf8')); } catch { return null; } };
  const check = name => evidence.checks.push(name);
  try {
    for (const name of ['one', 'two', 'three']) {
      const fixture = await standaloneFixture(); fixtures.push(fixture);
      const put = async (file, text) => { await mkdir(path.dirname(path.join(fixture.root, file)), { recursive: true }); await writeFile(path.join(fixture.root, file), text); };
      await put('pages/tenant.jsx', `export const getServerSideProps=({req})=>({props:{name:process.env.APP_NAME,user:req.cookies.user||'guest',nonce:crypto.randomUUID()}});export default function Page(p){return <main>{JSON.stringify(p)}</main>}`);
      await put('pages/cached.jsx', `export const getStaticProps=()=>({props:{name:'${name}',nonce:crypto.randomUUID()},revalidate:60});export default function Page(p){return <main>{JSON.stringify(p)}</main>}`);
      await put('pages/api/state.js', `export default function(req,res){res.setHeader('Cache-Control','private, no-store');res.setHeader('Set-Cookie',['tenant='+process.env.APP_NAME+'; Path=/','session='+String(req.cookies.user||'guest')+'; Path=/']);res.json({name:process.env.APP_NAME,user:req.cookies.user||'guest',nonce:crypto.randomUUID(),pid:process.pid,server:process.ppid,counts:globalThis.counts||{}})}`);
      await put('pages/api/stream.js', `export default async function(req,res){res.setHeader('Content-Type','text/plain');res.write('first:'+process.env.APP_NAME);await new Promise(r=>setTimeout(r,1500));res.end(':last')}`);
      await put('pages/api/hold.js', `export default async function(req,res){res.setHeader('Content-Type','text/plain');res.write('held');await new Promise(r=>{const t=setTimeout(r,6000);res.once('close',()=>{clearTimeout(t);r()})});res.end('done')}`);
      await put('pages/api/error.js', `export default function(req,res){const code=Number(req.query.code);const counts=globalThis.counts||={};counts[code]=(counts[code]||0)+1;res.setHeader('Cache-Control','no-store');if(code===503)res.setHeader('Retry-After','7');res.status(code).json({code,count:counts[code]})}`);
      await put('public/tenant.txt', name + '\n');
      await build(fixture.root);
    }
    await writeFile(config, JSON.stringify({ port: 0, memoryMb: 1024, apps: fixtures.map((fixture, i) => ({ name: ['one','two','three'][i], root: fixture.root, hosts: [['one','two','three'][i]+'.localhost'], memoryMb: 320, idleSeconds: 3, env: { APP_NAME: ['one','two','three'][i] } })) }));
    child = spawn(binary, ['host', config, '--node', process.execPath, '--shutdown-on-stdin-eof'], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), 'host readiness');
    const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const get = (name, route, user = 'guest', opts = {}) => new Promise((resolve, reject) => {
      const start = performance.now(), chunks = [], timings = [];
      const req = http.get(base + route, { headers: { host: name+'.localhost', cookie: 'user='+user, ...opts.headers }, agent: false }, res => {
        res.on('data', data => { chunks.push(data); timings.push(performance.now()-start); if (opts.first) opts.first(req, res); });
        res.on('error', error => reject(req.planned ? new Error('planned overload cancellation') : error));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          recentResponses.push({ name, route, status: res.statusCode, errorBody: res.statusCode >= 400 ? text : undefined });
          if (recentResponses.length > 8) recentResponses.shift();
          resolve({ status: res.statusCode, headers: res.headers, text, timings, ms: performance.now()-start });
        });
      });
      requests.add(req); req.on('close', () => requests.delete(req)); req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await until(async () => (await snapshot())?.apps.every(a => a.pid === null), 'all apps retire');
      const before = await snapshot();
      const values = await Promise.all(Array.from({ length: 48 }, async (_, i) => {
        const name = ['one','two','three'][i%3], r = await get(name, '/api/state', 'user'+i);
        assert.equal(r.status, 200); const data = JSON.parse(r.text);
        assert.equal(data.name, name); assert.equal(data.user, 'user'+i); assert.equal(r.headers['set-cookie'].length, 2);
        return { ...data, ms: r.ms };
      }));
      assert.equal(new Set(values.map(v => v.nonce)).size, 48);
      for (const name of ['one','two','three']) assert.equal(new Set(values.filter(v => v.name===name).map(v => v.server)).size, 1);
      await until(async () => (await snapshot())?.apps.every((a,i) => a.starts === before.apps[i].starts+1), 'exactly one startup per app');
      evidence.coldBursts.push({ cycle, responses: values.length, minMs: Math.min(...values.map(v=>v.ms)), maxMs: Math.max(...values.map(v=>v.ms)) });
    }
    check('48 simultaneous arrivals after sleep: one startup/app, unique responses, isolated cookies');
    const cached = new Map();
    for (const name of ['one','two','three']) {
      const ssr1 = await get(name, '/tenant', name+'-user'), ssr2 = await get(name, '/tenant', name+'-user');
      assert.equal(ssr1.status, 200); assert.match(ssr1.text, new RegExp(name+'-user')); assert.notEqual(ssr1.text, ssr2.text);
      const first = await get(name, '/cached'), second = await get(name, '/cached');
      assert.equal(first.status, 200); assert.equal(first.text, second.text); assert.match(first.text, new RegExp(name)); cached.set(name, first.text);
      const asset = await get(name, '/tenant.txt'); assert.equal(asset.text, name+'\n');
      assert.ok(asset.headers['last-modified']);
      const conditional = await get(name, '/tenant.txt', 'guest', { headers: { 'if-modified-since': asset.headers['last-modified'] } });
      assert.equal(conditional.status, 304);
    }
    assert.equal(new Set(cached.values()).size, 3); check('SSR freshness, separate prerender caches, static bytes and conditional 304');
    const stream = await get('one', '/api/stream');
    assert.equal(stream.text, 'first:one:last'); assert.ok(stream.timings.at(-1)-stream.timings[0] >= 1000); check('stream is progressive through proxy');
    for (const code of [500,503]) {
      const r = await get('one', '/api/error?code='+code); assert.equal(r.status, code); assert.equal(JSON.parse(r.text).count, 1);
      if (code===503) assert.equal(r.headers['retry-after'], '7');
    }
    check('upstream errors and Retry-After preserved, no automatic replay');
    // 16 active upstream streams + 256 waiting slots: extra callers must fail
    // explicitly without replay, and another tenant retains independent slots.
    const pending = Array.from({length: 300}, () => get('one', '/api/hold').catch(error => ({ aborted: error.message })));
    await delay(750);
    const neighbour = await get('two', '/api/state', 'neighbour'); assert.equal(neighbour.status,200);
    for (const req of requests) { req.planned=true; req.destroy(new Error('planned overload cancellation')); }
    const responses = await Promise.all(pending);
    const rejected = responses.filter(r => r.status===503);
    assert.ok(rejected.length > 0, 'overload must produce explicit 503s');
    for (const r of rejected) { assert.ok(r.headers['retry-after']); assert.match(r.headers['cache-control'] || '', /no-store/); }
    assert.ok(responses.every(r => [200,503].includes(r.status) || r.aborted==='planned overload cancellation'), JSON.stringify(responses));
    assert.equal((await get('one','/api/state')).status,200); check('bounded overload produces noncacheable 503s, neighbours survive, recovery succeeds');
    const ids = JSON.parse((await get('one', '/api/state')).text);
    process.kill(ids.server, 'SIGKILL');
    assert.equal((await get('two', '/api/state')).status,200);
    // A socket already dispatched as the process dies can return 502; after
    // exit detection the supervisor must enforce a 503 cooldown, not replay.
    const unavailable = await get('one','/api/state'); assert.ok([502,503].includes(unavailable.status));
    assert.match(unavailable.headers['cache-control'] || '', /no-store/);
    evidence.crashBoundaryStatus=unavailable.status;
    await until(async () => {const a=(await snapshot())?.apps[0];return a?.pid===null && a.reason.includes('exit');}, 'failed app detected');
    assert.equal((await get('one','/api/state')).status,503);
    await delay(5500); assert.equal((await get('one','/api/state')).status,200); check('application crash cooldown and restart do not affect neighbours');
    const live = await Promise.all(['one','two','three'].map(async name=>JSON.parse((await get(name,'/api/state')).text)));
    child.stdin.end(); await closed; assert.equal(child.exitCode,0,output);
    await until(() => live.every(({server,pid}) => [server,pid].every(id=>{try { process.kill(id,0); return false; } catch { return true; }})), 'host descendants must stop');
    check('stdin shutdown exits cleanly with no known descendants');
    evidence.complete = true;
  } catch (error) {
    // Preserve the supervisor's reason before shutdown removes its process tree.
    // A bare status assertion cannot distinguish overload, cooldown and startup failures.
    t.diagnostic(JSON.stringify({ ...evidence, recentResponses, snapshot: await snapshot(), output }, null, 2));
    throw error;
  } finally {
    for (const req of requests) req.destroy();
    if (child && child.exitCode===null && !child.signalCode) { child.stdin.end(); const timer=setTimeout(()=>child.kill('SIGKILL'),5000); await closed.catch(()=>{}); clearTimeout(timer); }
    if (process.env.PRNEXT_HOST_RELEASE_REPORT) {
      const file=path.resolve(process.env.PRNEXT_HOST_RELEASE_REPORT); await mkdir(path.dirname(file),{recursive:true});
      await writeFile(file,JSON.stringify({...evidence,binary,node:process.version,output},null,2));
    }
    for (const fixture of fixtures) await fixture.remove();
    await rm(folder,{recursive:true,force:true});
  }
});
