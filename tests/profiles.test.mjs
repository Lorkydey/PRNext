import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, repositoryRoot, startServer, binary } from './support.mjs';
import presets from '../packages/prnext/runtime/profiles.json' with { type: 'json' };

const execute = promisify(execFile);
let fixture, gate, audit;
before(async () => {
  fixture = await appFixture();
  for (const folder of ['app', 'pages']) await rm(path.join(fixture.root, folder), { recursive: true, force: true });
  gate = path.join(fixture.root, 'release'); audit = path.join(fixture.root, 'starts');
  const files = {
    'public/robots.txt': 'ready',
    'app/layout.jsx': 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/profile/page.jsx': `import{resourceLimits}from'node:worker_threads';export const dynamic='force-dynamic';export default function Page(){return <p>{JSON.stringify({name:process.env.PRNEXT_PROFILE,young:resourceLimits.maxYoungGenerationSizeMb})}</p>}`,
    'app/hold/page.jsx': `import{Suspense}from'react';import{existsSync}from'node:fs';export const dynamic='force-dynamic';async function Content({id}){while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));return <p>{'done:'+id}</p>}export default async function Page({searchParams}){const{id}=await searchParams;return <Suspense fallback={<p>{'pending:'+id}</p>}><Content id={id}/></Suspense>}`,
    'app/start/page.jsx': `import{appendFileSync,existsSync}from'node:fs';export const dynamic='force-dynamic';export default async function Page({searchParams}){const{id}=await searchParams;appendFileSync(${JSON.stringify(audit)},id+'\\n');while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));return <p>{'done:'+id}</p>}`,
    'pages/api/profile.js': `export default function handler(req,res){res.json({name:process.env.PRNEXT_PROFILE,args:process.execArgv})}`,
    'pages/api/hold.js': `import{appendFileSync,existsSync}from'node:fs';export default async function handler(req,res){appendFileSync(${JSON.stringify(audit)},req.query.id+'\\n');while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));res.json({id:req.query.id})}`,
    'pages/api/large.js': `export const config={api:{responseLimit:false}};export default function handler(req,res){res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.alloc(5*1024*1024,65))}`,
  };
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source);
  }
  await execute(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, '.prnext/runtime/profiles.json'), 'utf8')), presets);
});
after(async () => { await fixture?.remove(); });

test('all profiles reach both the native host and the RSC isolate; CLI takes precedence', async () => {
  for (const [name, preset] of Object.entries(presets)) {
    const server = await startServer(fixture.root, ['--profile', name], { PRNEXT_PROFILE: 'speed', PRNEXT_MEMORY_PROFILE: 'compact', NODE_OPTIONS: '' });
    try {
      const value = await fetch(server.url + '/api/profile').then(r => r.json());
      assert.equal(value.name, name);
      assert.equal(value.args.includes('--optimize-for-size'), preset.optimizeForSize);
      assert.deepEqual(value.args.filter(a => a.startsWith('--max-semi-space-size')), preset.semiSpaceMiB ? [`--max-semi-space-size=${preset.semiSpaceMiB}`] : []);
      const html = await fetch(server.url + '/profile').then(r => r.text());
      assert.ok(html.includes('&quot;name&quot;:&quot;' + name + '&quot;'));
      assert.match(server.output(), new RegExp('profile ' + name));
    } finally { await server.close(); }
  }
});

test('explicit NODE_OPTIONS and development preserve the operator heap setting', async () => {
  for (const env of [{ NODE_OPTIONS: '--max-semi-space-size=8' }, { NODE_ENV: 'development', NODE_OPTIONS: '' }]) {
    const server = await startServer(fixture.root, ['--profile', 'memory'], env);
    try {
      const value = await fetch(server.url + '/api/profile').then(r => r.json());
      assert.ok(value.args.every(arg => !arg.startsWith('--max-semi-space-size')));
      if (env.NODE_ENV) { assert.ok(!value.args.includes('--optimize-for-size')); assert.match(server.output(), /profile classic/); }
    } finally { await server.close(); }
  }
});

test('start defaults to balanced and resolves legacy names and environment overrides end to end', async () => {
  const cases = [
    { args: [], env: {}, name: 'balanced' },
    { args: [], env: { PRNEXT_PROFILE: 'classic' }, name: 'classic' },
    { args: [], env: { PRNEXT_PROFILE: 'standard' }, name: 'classic' },
    { args: ['--profile', 'standard'], env: { PRNEXT_PROFILE: 'balanced' }, name: 'classic' },
    { args: [], env: { PRNEXT_MEMORY_PROFILE: 'compact' }, name: 'compact' },
  ];
  for (const { args, env, name } of cases) {
    const server = await startServer(fixture.root, args, { PRNEXT_PROFILE: '', PRNEXT_MEMORY_PROFILE: '', NODE_OPTIONS: '', ...env });
    try {
      const value = await fetch(server.url + '/api/profile').then(r => r.json());
      assert.equal(value.name, name);
      assert.equal(value.args.includes('--optimize-for-size'), presets[name].optimizeForSize);
      assert.deepEqual(value.args.filter(arg => arg.startsWith('--max-semi-space-size')), presets[name].semiSpaceMiB ? [`--max-semi-space-size=${presets[name].semiSpaceMiB}`] : []);
      assert.ok((await fetch(server.url + '/profile').then(r => r.text())).includes('&quot;name&quot;:&quot;' + name + '&quot;'));
      assert.match(server.output(), new RegExp('profile ' + name));
    } finally { await server.close(); }
  }
});

for (const name of ['memory', 'speed']) {
  test(name + ': pre-header starts and live streams are independently bounded; cancellation releases a slot', { timeout: 20000 }, async () => {
    const server = await startServer(fixture.root, ['--profile', name]), preset = presets[name];
    const controllers = [], pending = [], readers = [];
    try {
      await rm(gate, { force: true }); await writeFile(audit, '');
      const controller = new AbortController(); controllers.push(controller);
      for (let id = 0; id < preset.renderStarts + 2; id++) pending.push(fetch(`${server.url}/start?id=${id}`, { signal: controller.signal }).then(async r => { assert.equal(r.status, 200); assert.ok((await r.text()).includes('done:' + id)); }));
      for (let i = 0; i < 150; i++) { if ((await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).length >= preset.renderStarts) break; await delay(20); }
      await delay(100);
      assert.equal((await readFile(audit, 'utf8')).trim().split('\n').length, preset.renderStarts);
      await writeFile(gate, 'release'); await Promise.all(pending); pending.length = 0;
      await rm(gate, { force: true });
      const open = async id => {
        const controller = new AbortController(); controllers.push(controller);
        const r = await fetch(`${server.url}/hold?id=${id}`, { signal: controller.signal, headers: { 'accept-encoding': 'identity' } });
        assert.equal(r.status, 200); const reader = r.body.getReader(); readers.push(reader);
        let html = ''; while (!html.includes('pending:' + id)) { const chunk = await reader.read(); assert.equal(chunk.done, false); html += Buffer.from(chunk.value).toString(); }
        return { reader, html, id, controller };
      };
      for (let id = 0; id < preset.liveResponses; id++) pending.push(open(id));
      const active = await Promise.all(pending); let admitted = false;
      const waiting = open(preset.liveResponses).then(r => { admitted = true; return r; }); pending.push(waiting);
      await delay(100); assert.equal(admitted, false);
      assert.equal((await fetch(server.url + '/api/profile')).status, 200);
      active[0].controller.abort(); await active[0].reader.cancel().catch(() => {});
      const next = await waiting; await writeFile(gate, 'release');
      for (const stream of [...active.slice(1), next]) {
        for (;;) { const chunk = await stream.reader.read(); if (chunk.done) break; stream.html += Buffer.from(chunk.value).toString(); }
        assert.ok(stream.html.includes('done:' + stream.id));
      }
    } finally {
      await writeFile(gate, 'release'); controllers.forEach(c => c.abort());
      await Promise.allSettled(pending); await Promise.allSettled(readers.map(r => r.cancel()));
      await server.close(); await rm(gate, { force: true });
    }
  });
}

test('memory mode streams bodies larger than its queue budget and survives cancellation', async () => {
  const server = await startServer(fixture.root, ['--profile', 'memory']);
  try {
    const slow = await fetch(server.url + '/api/large'); await slow.body.cancel();
    const r = await fetch(server.url + '/api/large'); assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer()); assert.equal(body.length, 5 * 1024 * 1024); assert.ok(body.every(byte => byte === 65));
  } finally { await server.close(); }
});

test('memory mode limits API execution to 64 and queues the next request', async () => {
  const server = await startServer(fixture.root, ['--profile', 'memory']);
  const controller = new AbortController(); let pending = [];
  try {
    await rm(gate, { force: true }); await writeFile(audit, '');
    pending = Array.from({ length: 65 }, (_, id) => fetch(`${server.url}/api/hold?id=${id}`, { signal: controller.signal }).then(async r => { assert.equal(r.status, 200); assert.deepEqual(await r.json(), { id: String(id) }); }));
    for (let i = 0; i < 150; i++) { if ((await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).length >= 64) break; await delay(20); }
    await delay(100); assert.equal((await readFile(audit, 'utf8')).trim().split('\n').length, 64);
    await writeFile(gate, 'release'); await Promise.all(pending);
    assert.equal((await readFile(audit, 'utf8')).trim().split('\n').length, 65);
  } finally { await writeFile(gate, 'release'); controller.abort(); await Promise.allSettled(pending); await server.close(); await rm(gate, { force: true }); }
});

test('invalid profile fails at CLI parsing before starting a server', async () => {
  await assert.rejects(execute(binary, ['start', fixture.root, '--profile', 'typo']), error => /invalid value.*typo/.test(error.stderr));
});

test('profile help exposes the renamed policy and balanced default; removed options fail clearly', async () => {
  await assert.rejects(execute(binary, ['start', fixture.root, '--profile', 'cpu']), error => /invalid value.*cpu/.test(error.stderr));
  await assert.rejects(execute(binary, ['start', fixture.root], { env: { ...process.env, PRNEXT_PROFILE: 'cpu' } }), error => /Unknown runtime profile.*cpu/.test(error.stderr));
  await assert.rejects(execute(binary, ['start', fixture.root, '--advanced-profile', 'memory']), error => /unexpected argument.*--advanced-profile/.test(error.stderr));
  const nativeHelp = (await execute(binary, ['start', '--help'])).stdout;
  assert.match(nativeHelp, /possible values: balanced, speed, memory, classic/);
  assert.match(nativeHelp, /default: balanced/);
  assert.doesNotMatch(nativeHelp, /--advanced-profile/);
  const npmHelp = (await execute(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), '--help'])).stdout;
  assert.match(npmHelp, /Production profiles: --profile balanced\|speed\|memory\|classic/);
  assert.match(npmHelp, /then balanced/);
  assert.doesNotMatch(npmHelp, /--advanced-profile/);
});
