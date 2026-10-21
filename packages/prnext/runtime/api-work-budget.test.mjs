import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runApi } from './api.mjs';
import { requestWork } from './request-work.mjs';

for (const router of ['app', 'pages']) {
  test(`${router} API cancellation retains the configured budget for outstanding npm work`, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prnext-api-work-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const modulePath = path.join(dir, 'route.mjs');
    await writeFile(modulePath, router === 'app'
      ? 'export let finish; export const GET = () => new Promise(resolve => { finish = () => resolve(new Response("done")); });'
      : 'export let finish; export default (_req,res) => new Promise(resolve => { finish = () => {res.end("done");resolve();}; });');
    const abort = new AbortController(), tracked = [];
    abort.signal[requestWork] = (promise, options) => tracked.push({ promise, options });
    const response = runApi({ modulePath, route: { router, kind: 'api' }, url: 'http://localhost/pending', stream: true, signal: abort.signal, timeoutMs: 30000 });
    const outcome = response.then(value => value, error => error);
    for (let n = 0; !tracked.length; n++) {
      assert.ok(n < 500); await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(tracked[0].options.timeoutMs, 30000);
    let settled = false; tracked[0].promise.then(() => { settled = true; }, () => { settled = true; });
    abort.abort(new Error('visitor left'));
    assert.match((await outcome).message, /visitor left/);
    assert.equal(settled, false, 'HTTP cancellation must not pretend npm work has completed');
    const { pathToFileURL } = await import('node:url');
    (await import(pathToFileURL(modulePath).href)).finish();
    await Promise.allSettled(tracked.map(item => item.promise));
    assert.equal(settled, true);
  });
}
