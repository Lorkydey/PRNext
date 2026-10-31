import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { startReferenceHttpsProxy } from './https-proxy.mjs';

test('HTTPS fixture overwrites all untrusted forwarding headers and preserves request bodies and cookies', async t => {
  const backend = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('set-cookie', '__Secure-test=value; Path=/; HttpOnly; Secure; SameSite=Lax');
    res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const proxy = await startReferenceHttpsProxy('http://127.0.0.1:' + backend.address().port);
  t.after(() => proxy.close());
  const response = await new Promise((resolve, reject) => {
    const req = request(proxy.origin, {
      method: 'POST', rejectUnauthorized: false,
      headers: { host: 'attacker.test', forwarded: 'host=attacker.test;proto=http', 'x-forwarded-host': 'attacker.test', 'x-forwarded-for': 'evil', 'x-forwarded-proto': 'http', 'x-forwarded-extra': 'evil', cookie: 'session=owned', connection: 'x-client-hop', 'x-client-hop': 'drop' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ headers: res.headers, value: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end('request body');
  });
  const headers = response.value.headers;
  assert.equal(headers.host, new URL(proxy.origin).host);
  assert.equal(headers['x-forwarded-host'], headers.host);
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.equal(headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers['x-forwarded-extra'], undefined);
  assert.equal(headers['x-client-hop'], undefined);
  assert.equal(headers.cookie, 'session=owned');
  assert.equal(response.value.body, 'request body');
  assert.match(response.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
});

test('HTTPS fixture refuses non-loopback or non-HTTP upstream targets', async () => {
  for (const backend of ['https://127.0.0.1:1234', 'http://example.test', 'http://127.0.0.1:1234/path', 'http://user:password@127.0.0.1:1234', 'http://127.0.0.1:1234/?query', 'http://127.0.0.1:1234/#fragment']) {
    await assert.rejects(startReferenceHttpsProxy(backend), /HTTP loopback/);
  }
});

test('a truncated upstream body closes downstream instead of leaving a hanging response', async t => {
  const backend = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '100' });
    res.flushHeaders();
    res.write('partial');
    setTimeout(() => res.destroy(), 25);
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const proxy = await startReferenceHttpsProxy('http://127.0.0.1:' + backend.address().port);
  t.after(() => proxy.close());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Truncated proxy response remained open.')), 2000);
    const req = request(proxy.origin + '/api/auth/truncated', { rejectUnauthorized: false }, res => {
      assert.equal(res.statusCode, 200);
      res.resume();
      res.on('aborted', () => { clearTimeout(timeout); resolve(); });
      res.on('error', () => { clearTimeout(timeout); resolve(); });
      res.on('end', () => { clearTimeout(timeout); reject(new Error('A truncated response must not be complete.')); });
    });
    req.on('error', error => { clearTimeout(timeout); reject(error); });
    req.end();
  });
  assert.equal(proxy.metrics[0].upstreamAborted, true);
  assert.equal(proxy.metrics[0].upstreamEnded, false);
  assert.equal(proxy.metrics[0].downstreamFinished, false);
});
