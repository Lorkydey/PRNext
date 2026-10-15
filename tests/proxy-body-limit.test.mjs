import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

test('configured 25 MiB Proxy copies and larger route uploads survive transport and cancellation', async () => {
  const fixture = await appFixture(); let server;
  try {
    for (const route of ['upload', 'plain']) {
      const dir = path.join(fixture.root, 'app', route); await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'route.js'), `import {createHash} from 'node:crypto';export async function POST(req){const bytes=Buffer.from(await req.arrayBuffer());return Response.json({length:bytes.length,hash:createHash('sha256').update(bytes).digest('hex'),proxy:req.headers.get('x-proxy-hash')})}`);
    }
    await writeFile(path.join(fixture.root, 'next.config.mjs'), `export default {experimental:{proxyClientMaxBodySize:'25mb'}}`);
    await writeFile(path.join(fixture.root, 'proxy.ts'), `import{NextResponse}from'next/server';import{createHash}from'node:crypto';export const config={matcher:'/upload'};export async function proxy(req){const h=new Headers(req.headers);h.set('x-proxy-hash',createHash('sha256').update(Buffer.from(await req.arrayBuffer())).digest('hex'));return NextResponse.next({request:{headers:h}})}`);
    const manifest = await build(fixture.root);
    assert.equal(manifest.middleware.bodySizeLimit, 25 * 1024 * 1024);
    server = await startServer(fixture.root, ['--workers', '1']);
    const bytes = Buffer.alloc(25 * 1024 * 1024, 201);
    const hash = createHash('sha256').update(bytes).digest('hex');
    for (const route of ['upload', 'plain']) {
      const response = await fetch(server.url + '/' + route, { method: 'POST', body: bytes, signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { length: bytes.length, hash, proxy: route === 'upload' ? hash : null });
    }
    const oversized = await fetch(server.url + '/plain', { method: 'POST', body: Buffer.alloc(32 * 1024 * 1024 + 1), signal: AbortSignal.timeout(30000) });
    assert.equal(oversized.status, 413);
    await oversized.text();
    const abort = new AbortController();
    const pending = fetch(server.url + '/upload', { method: 'POST', duplex: 'half', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024)); } }), signal: abort.signal });
    await new Promise(resolve => setTimeout(resolve, 150)); abort.abort();
    await assert.rejects(pending);
    const recovered = await fetch(server.url + '/upload', { method: 'POST', body: 'recovered', signal: AbortSignal.timeout(5000) });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).length, 9);
  } finally { await server?.close(); await fixture.remove(); }
});
