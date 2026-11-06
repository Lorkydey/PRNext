import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

for (const mode of ['lazy', 'prepared', 'failed', 'rss']) {
  test(`worker bootstrap readiness reports ${mode} framework preparation and preserves normal requests`, {timeout: 15000}, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'prnext-worker-prewarm-'));
    const dist = path.join(root, 'dist');
    await mkdir(path.join(dist, 'runtime'), {recursive: true});
    await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({
      routes: [{id: 'private', kind: 'page', router: 'app', module: 'private.mjs'}, {id: 'api', kind: 'api', router: 'app', module: 'private.mjs'}],
      ...(mode === 'rss' ? {config: {workerPreload: {maxRssMb: 16, timeoutMs: 1000, routes: ['/private']}}} : {}),
    }));
    await writeFile(path.join(dist, 'private.mjs'), 'throw new Error("Application routes must not be imported by framework preparation");');
    await writeFile(path.join(dist, 'runtime/http.mjs'), 'export const errorResponse=()=>({status:500,body:"failed"});');
    await writeFile(path.join(dist, 'runtime/api.mjs'), 'export const runApi=async()=>({status:200,body:"healthy"});');
    await writeFile(path.join(dist, 'runtime/app-render.mjs'), `
      import {writeFileSync} from 'node:fs';
      export async function prewarmAppRenderer(options) {
        writeFileSync('framework-prepared', JSON.stringify({pid:process.pid,timeoutMs:options.timeoutMs}));
        ${mode === 'failed' ? 'throw new Error("PRIVATE-IMPORT-DETAIL");' : ''}
      }
      export async function drainAppRuntime() {}
    `);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), root, dist], {
      env: {...process.env, NODE_ENV: 'production', PRNEXT_WORKER_SOCKET: '4', PRNEXT_WORKER_TOKEN: 'test-token', PRNEXT_WORKER_PREWARM: mode === 'lazy' ? '0' : '1'},
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = once(child, 'exit'), lines = createInterface({input: child.stdout});
    let stderr = ''; child.stderr.on('data', chunk => {stderr += chunk;});
    let socket;
    try {
      const ready = JSON.parse((await once(lines, 'line', {signal: AbortSignal.timeout(5000)}))[0]);
      assert.equal(ready.frameworkPrewarmed, mode === 'prepared');
      if (mode === 'lazy' || mode === 'rss') await assert.rejects(readFile(path.join(root, 'framework-prepared')), {code: 'ENOENT'});
      else assert.equal(JSON.parse(await readFile(path.join(root, 'framework-prepared'), 'utf8')).pid, child.pid);
      if (mode === 'failed' || mode === 'rss') assert.match(stderr, /Framework prewarm (?:failed|incomplete)/);
      assert.doesNotMatch(stderr, /PRIVATE-IMPORT-DETAIL/);
      socket = net.createConnection({port: ready.port, host: '127.0.0.1'});
      const response = createInterface({input: socket})[Symbol.asyncIterator]();
      socket.write('test-token\n'); assert.equal((await response.next()).value, 'ready');
      socket.write(JSON.stringify({id: 1, routeId: 'api', method: 'GET', url: 'http://localhost/healthy'}) + '\n');
      const value = JSON.parse((await response.next()).value);
      assert.equal(value.status, 200, stderr);
      assert.equal(Buffer.from(value.body, 'base64').toString(), 'healthy');
      socket.end(); child.stdin.end();
      assert.deepEqual(await exited, [0, null]);
    } finally {
      socket?.destroy(); lines.close();
      if (child.exitCode === null) child.kill();
      await exited;
      await rm(root, {recursive: true, force: true});
    }
  });
}
