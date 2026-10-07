import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { partialFixture } from './partial-fixture.mjs';
import { startServer } from './support.mjs';

test('a global proxy accepts one module graph burst while retaining bounded overload admission', async () => {
  const fixture = await partialFixture();
  const gate = path.join(fixture.root, 'release-proxy');
  let server;
  try {
    await writeFile(path.join(fixture.root, 'proxy.js'), `import{NextResponse}from'next/server';import{existsSync}from'node:fs';export async function proxy(req){if(req.headers.get('x-gate'))while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,5));const response=NextResponse.next();response.headers.set('x-proxy','checked');return response}`);
    await fixture.build(); server = await startServer(fixture.root);
    const assets = (await readdir(path.join(fixture.root, '.prnext/assets'))).filter(name => name.endsWith('.js'));
    assert.ok(assets.length > 5, 'A module graph must exercise more than the old five-request limit');
    const responses = await Promise.all(assets.map(async name => {
      const response = await fetch(server.url + '/_prnext/assets/' + name);
      await response.arrayBuffer();
      return response;
    }));
    for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.headers.get('x-proxy'), 'checked'); }
    const completed = [];
    const pending = Array.from({ length: 1584 }, async () => {
      const response = await fetch(server.url + '/_prnext/assets/' + assets[0], { headers: { 'x-gate': '1' } });
      const text = await response.text();
      const result = { status: response.status, retry: response.headers.get('retry-after'), text };
      completed.push(result); return result;
    });
    try {
      for (let attempt = 0; completed.length < 48 && attempt < 300; attempt++) await delay(10);
      assert.ok(completed.length >= 48 && completed.every(response => response.status === 503), 'All excess waiters must arrive before opening the gate');
    } finally { await writeFile(gate, 'release'); }
    const all = await Promise.all(pending);
    const accepted = all.filter(response => response.status === 200);
    assert.ok(accepted.length > 5 && accepted.length <= 1536, `Expected at most 1024 waiters plus 512 active requests, got ${accepted.length}`);
    for (const response of all.filter(response => response.status !== 200)) { assert.equal(response.status, 503, response.text + '\n' + server.output()); assert.equal(response.retry, '1'); assert.match(response.text, /Middleware queue is full/); }
    const recovered = await fetch(server.url + '/_prnext/assets/' + assets[0]);
    assert.equal(recovered.status, 200); await recovered.arrayBuffer();
  } finally { await writeFile(gate, 'release').catch(() => {}); await server?.close(); await fixture.remove(); }
});
