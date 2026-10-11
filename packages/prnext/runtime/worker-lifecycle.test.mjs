import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

for (const shutdownOrder of [null, 'stdin-first', 'stdout-first']) {
test(shutdownOrder ? `cache finalization survives closing both control pipes (${shutdownOrder})`
  : 'successful response releases its transport before long cache finalization', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-worker-finalize-'));
  const dist = path.join(root, 'dist'), script = path.join(root, 'worker.mjs');
  await mkdir(path.join(dist, 'runtime'), { recursive: true });
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({ routes: [{ id: 'test', kind: 'api', router: 'app', module: 'unused' }] }));
  await writeFile(path.join(dist, 'runtime/http.mjs'), "export const errorResponse=()=>({status:500,body:'error'});");
  await writeFile(path.join(dist, 'runtime/api.mjs'), `
    import {existsSync,writeFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    export async function runApi({url,signal}) {
      return {status:200,headers:{'x-worker':String(process.pid)},body:'healthy',
        ...(url.endsWith('/cache') ? {finalizeCache:async()=>{
          signal.addEventListener('abort',()=>writeFileSync('aborted','yes'),{once:true});
          writeFileSync('finalizing','yes');
          while(!existsSync('release-cache'))await delay(5);
          writeFileSync('finalized','yes');
        }} : {})};
    }
  `);
  await writeFile(script, `
    const original=setTimeout;
    globalThis.setTimeout=(callback,ms,...args)=>original(callback,ms===5000?50:ms,...args);
    const originalInterval=setInterval;
    globalThis.setInterval=(callback,ms,...args)=>originalInterval(callback,ms===1000?20:ms,...args);
    await import(${JSON.stringify(new URL('./worker.mjs', import.meta.url).href)});
  `);
  const child = spawn(process.execPath, [script, root, dist], {
    env: { ...process.env, PRNEXT_WORKER_SOCKET: '4', PRNEXT_WORKER_TOKEN: 'test-token', PRNEXT_WORKER_ACTIVITY: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const activity = [];
  lines.on('line', line => { activity.push(line); });
  let ready;
  const sockets = [];
  async function request(url) {
    const socket = net.createConnection({ port: ready.port, host: '127.0.0.1' });
    sockets.push(socket);
    const replies = createInterface({ input: socket })[Symbol.asyncIterator]();
    socket.write('test-token\n');
    assert.equal((await replies.next()).value, 'ready');
    socket.write(JSON.stringify({ id: 1, routeId: 'test', method: 'GET', url: 'http://localhost' + url }) + '\n');
    return { socket, response: JSON.parse((await replies.next()).value) };
  }
  try {
    ready = JSON.parse((await once(lines, 'line', { signal: AbortSignal.timeout(5000) }))[0]);
    assert.equal(ready.activity, true);
    const first = await request('/cache');
    assert.equal(Buffer.from(first.response.body, 'base64').toString(), 'healthy');
    first.socket.end(); // Native idle retirement closes a completed lane.
    if (shutdownOrder === 'stdin-first') {
      child.stdin.end();
      child.stdout.destroy();
    } else if (shutdownOrder === 'stdout-first') {
      child.stdout.destroy();
      // Deliver a broken-pipe heartbeat before EOF so shutdown cannot depend
      // on the order in which independent control-pipe events are dispatched.
      await delay(80);
      assert.equal(child.exitCode, null, stderr);
      child.stdin.end();
    }
    await delay(180); // Exceed the accelerated orphan guard (50 ms).
    assert.equal(child.exitCode, null, stderr);
    assert.equal(await readFile(path.join(root, 'finalizing'), 'utf8'), 'yes');
    await assert.rejects(readFile(path.join(root, 'aborted')), error => error.code === 'ENOENT');
    await assert.rejects(readFile(path.join(root, 'finalized')), error => error.code === 'ENOENT');
    if (!shutdownOrder) {
      assert.ok(activity.includes('busy'), 'native host ownership must cover finalization after the HTTP body');
      const next = await request('/healthy');
      assert.equal(next.response.headers['x-worker'], first.response.headers['x-worker']);
      next.socket.end();
    }
    await writeFile(path.join(root, 'release-cache'), 'go');
    for (let i = 0; ; i++) {
      try { await readFile(path.join(root, 'finalized')); break; }
      catch { assert.ok(i < 100); await delay(5); }
    }
    if (!child.stdin.writableEnded) child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
    assert.equal(stderr, '');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
}
