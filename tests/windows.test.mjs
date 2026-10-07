import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { standaloneFixture, freePort, repositoryRoot } from './support.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(message());
}

test('native Windows dev handles Unicode paths, rebuilds, and releases its process tree when the CLI is killed', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async () => {
  const fixture = await standaloneFixture('prnext Windows espace é-');
  const port = await freePort();
  let child, output = '';
  const processes = new Set();
  const page = marker => `export default function Page(){return <h1>${marker}</h1>}`;
  try {
    await mkdir(path.join(fixture.root, 'pages/api'));
    await writeFile(path.join(fixture.root, 'pages/api/process.js'), 'export default function handler(req,res){res.json({worker:process.pid,server:process.ppid})}');
    await writeFile(path.join(fixture.root, 'pages/index.jsx'), page('Windows first'));
    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'dev', fixture.root, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, NODE_ENV: 'development' },
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const response = async route => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1000) });
    async function ready(marker) {
      await until(async () => {
        if (child.exitCode !== null) assert.fail(output);
        try { const result = await response('/'); return result.ok && (await result.text()).includes(marker); } catch { return false; }
      }, () => output);
      const ids = await (await response('/api/process')).json();
      for (const pid of Object.values(ids)) { assert.ok(Number.isInteger(pid) && pid > 0); processes.add(pid); }
      return ids;
    }
    const first = await ready('Windows first');
    await writeFile(path.join(fixture.root, 'pages/index.jsx'), page('Windows updated'));
    const second = await ready('Windows updated');
    assert.notEqual(second.server, first.server);
    await until(() => !alive(first.server) && !alive(first.worker), () => 'Old development workers survived a rebuild');
    // Windows kill terminates the CLI immediately, without running JS signal
    // handlers. EOF on its pipe must stop Rust and all of Rust's Node workers.
    child.kill('SIGKILL');
    await Promise.race([closed, delay(10000).then(() => assert.fail('CLI descendants kept pipes open'))]);
    await until(() => [...processes].every(pid => !alive(pid)), () => 'Native server or render workers survived their parent CLI');
    await assert.rejects(response('/'));
  } finally {
    if (child?.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    for (const pid of processes) if (alive(pid)) { try { process.kill(pid); } catch {} }
    await fixture.remove();
  }
});
