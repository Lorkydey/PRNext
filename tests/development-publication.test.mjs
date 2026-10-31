import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { devFixture, counterSource } from './dev-fixture.mjs';

async function until(check, message, timeout = 30000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() >= deadline) throw Error(message);
    await delay(40);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('failed ready publications retain bounded snapshots, drain old requests and keep the activated build usable', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-publication-fault-'));
  const control = path.join(directory, 'control.json'), events = path.join(directory, 'events.jsonl'), release = path.join(directory, 'release-lease'), preload = path.join(directory, 'fault.mjs');
  // Inject the real fs boundary, not writeState or its retirement helper. The
  // initial generation and all building/error publications remain unaffected.
  await writeFile(preload, `import fs from 'node:fs/promises';import path from 'node:path';import{syncBuiltinESMExports}from'node:module';const original=fs.rename,seen=new Set();fs.rename=async(source,destination)=>{if(path.basename(destination)==='.prnext-dev.json'){const value=JSON.parse(await fs.readFile(source,'utf8'));const mode=await fs.readFile(${JSON.stringify(control)},'utf8').then(JSON.parse).catch(()=>null);if(mode?.enabled&&value.state==='ready'&&value.buildId!==mode.initial){if(!seen.has(value.buildId)){seen.add(value.buildId);await fs.appendFile(${JSON.stringify(events)},JSON.stringify({buildId:value.buildId})+'\\n')}throw Object.assign(Error('Injected ready-state publication denial'),{code:'EACCES'})}}return original(source,destination)};syncBuiltinESMExports();`);
  const leaseSource = `import{readFile}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';export default async function(req,res){res.setHeader('content-type','text/plain');res.setHeader('x-lease-pid',String(process.pid));res.write('lease-start\\n');if(req.query.hold==='1'){const deadline=performance.now()+45000;while(!(await readFile(${JSON.stringify(release)}).then(()=>true,()=>false))){if(performance.now()>deadline)throw Error('Owned lease gate timed out');await delay(20)}}res.end('lease-complete\\n')}`;
  let fixture, lease, body;
  const abort = new AbortController();
  try {
    fixture = await devFixture({ files: { 'pages/api/lease.js': leaseSource }, env: { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href } });
    const warm = await fetch(fixture.url + '/docs/api/lease');
    assert.equal(warm.status, 200); assert.match(await warm.text(), /lease-complete/);
    const initial = JSON.parse(await fixture.read('.prnext-dev.json'));
    assert.equal(initial.state, 'ready');
    lease = await fetch(fixture.url + '/docs/api/lease?hold=1', { signal: abort.signal });
    assert.equal(lease.status, 200);
    const oldPid = Number(lease.headers.get('x-lease-pid'));
    assert.ok(Number.isSafeInteger(oldPid) && oldPid > 0);
    const reader = lease.body.getReader(), first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /lease-start/);
    body = Buffer.from(first.value).toString();
    await writeFile(control, JSON.stringify({ enabled: true, initial: initial.buildId }));
    const observed = [], failedIds = new Set();
    for (let i = 0; i < 6; i++) {
      const label = 'Publication failure ' + i;
      await fixture.write('components/Counter.jsx', counterSource(label));
      await until(async () => {
        const rows = await readFile(events, 'utf8').catch(() => '');
        for (const line of rows.trim().split('\n').filter(Boolean)) failedIds.add(JSON.parse(line).buildId);
        return failedIds.size >= i + 1;
      }, 'The real ready publication fault was not reached.');
      await until(async () => {
        const state = JSON.parse(await fixture.read('.prnext-dev.json'));
        return state.state === 'error' && state.error.includes('Injected ready-state publication denial');
      }, 'The publication error did not leave a complete readable error state.');
      const response = await fetch(fixture.url + '/docs/pages');
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(label), 'the activated replacement must remain usable even when its readiness receipt failed');
      if (i === 0) {
        assert.equal(alive(oldPid), true, 'the previous in-flight request must keep its worker alive');
        await writeFile(release, 'release');
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; body += Buffer.from(chunk.value).toString(); }
        assert.match(body, /lease-complete/, 'retirement must drain the actual old request rather than abort it');
      }
      const home = path.join(fixture.root, '.prnext-dev', initial.session);
      const snapshots = (await readdir(home, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f\d-]{36}$/.test(entry.name));
      observed.push(snapshots.length);
    }
    // The async retire/forget tasks may still be deleting the oldest directory.
    await until(async () => (await readdir(path.join(fixture.root, '.prnext-dev', initial.session), { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f\d-]{36}$/.test(entry.name)).length <= 3, 'Failed ready publications accumulated generation snapshots: ' + observed.join(','), 10000);
    await until(() => !alive(oldPid), 'The drained old generation still owns a live worker.', 10000);
    assert.equal(failedIds.size, 6);
    await writeFile(control, JSON.stringify({ enabled: false }));
    await fixture.write('components/Counter.jsx', counterSource('Publication recovered'));
    await until(async () => {
      const state = JSON.parse(await fixture.read('.prnext-dev.json'));
      return state.state === 'ready' && state.publication?.failures === 6;
    }, 'Development did not recover after the publication fault was removed.');
    const recovered = await fetch(fixture.url + '/docs/pages');
    assert.equal(recovered.status, 200); assert.ok((await recovered.text()).includes('Publication recovered'));
  } finally {
    await writeFile(release, 'release').catch(() => {});
    abort.abort();
    try { await fixture?.close(); }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});
