import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { staticExportFixture, serveStatic } from './static-export-fixture.mjs';

test('static export serves App, Pages, Flight and data without any source, runtime or node_modules', async () => {
  const f = await staticExportFixture(); let server;
  try {
    const manifest = await f.build();
    const out = path.join(f.root, 'out');
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /Export home/);
    for (const name of ['runtime', 'server', 'manifest.json', 'compat']) await assert.rejects(access(path.join(out, name)));
    await writeFile(path.join(f.root, 'app/page.jsx'), 'export default()=>null;export const dynamic="force-dynamic";');
    await assert.rejects(f.build(), /output: 'export'/);
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /Export home/);
    for (const name of ['app', 'pages', '.prnext', 'node_modules', 'public']) await rm(path.join(f.root, name), { recursive: true, force: true });
    server = await serveStatic(out);
    for (const [url, text] of [['/', 'Export home'], ['/posts/one/', 'Post'], ['/legacy/', 'exported props'], ['/plain.txt', 'public export'], ['/_prnext/flight/posts/one/index.txt', 'one'], [`/_prnext/data/${manifest.buildId}/legacy.json`, 'exported props']]) {
      const response = await fetch(server.url + url); assert.equal(response.status, 200, url); assert.ok((await response.text()).includes(text), url);
    }
    assert.equal((await fetch(server.url + '/posts/unknown/')).status, 404);
  } finally { await server?.close(); await f.remove(); }
});
