import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

async function run(stale) {
  const nonces = new Map();
  const server = http.createServer((req, res) => {
    const user = req.headers.cookie.slice('user='.length);
    const key = user + req.url;
    if (!stale || !nonces.has(key)) nonces.set(key, randomUUID());
    const nonce = nonces.get(key);
    res.end(req.url === '/api/json' ? JSON.stringify({ user, nonce }) : `<p>user:${user}</p><p>nonce:${nonce}</p>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, [process.env.MIXED_LOAD_SCRIPT || fileURLToPath(new URL('./mixed-load.mjs', import.meta.url)), `http://127.0.0.1:${server.address().port}`, '1', '3']);
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  try {
    const [code] = await once(child, 'close');
    return { code, errors, result: JSON.parse(output.trim().split('\n').at(-1)) };
  } finally { child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('mixed freshness rejects a distinct stale cached response per user and route', async () => {
  const row = await run(true);
  assert.equal(row.code, 1, row.errors);
  assert.ok(row.result.validationErrors > 0);
  assert.equal(row.result.errors, 0);
});
test('mixed freshness accepts fresh responses on all rotating routes', async () => {
  const row = await run(false);
  assert.equal(row.code, 0, row.errors);
  assert.equal(row.result.validationErrors, 0);
  assert.ok(row.result.count > 9);
});
