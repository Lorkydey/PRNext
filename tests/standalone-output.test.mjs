import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { standaloneOutputFixture, startStandalone } from './standalone-output-fixture.mjs';

test('output standalone starts from its own binary after deleting sources and npm installation', async () => {
  const fixture = await standaloneOutputFixture({ nativeAddon: true });
  let server;
  try {
    for (const file of ['pages', 'app', 'prnext.config.mjs', '.env.production', 'node_modules/unused-package']) await assert.rejects(access(path.join(fixture.app, file)), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(path.join(fixture.app, '.prnext-output.json'), 'utf8')).distDir, 'build/server');
    server = await startStandalone(fixture.root);
    assert.equal(await (await fetch(server.url + '/docs/asset.txt')).text(), 'public-portable');
    for (const route of ['/docs', '/docs/server', '/docs/application']) {
      const response = await fetch(server.url + route);
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(await response.text(), route.endsWith('application') ? /Portable App/ : /Independent React/);
    }
    const files = await fetch(server.url + '/docs/api/files');
    assert.equal(files.status, 200, await files.clone().text());
    assert.deepEqual(await files.json(), { data: 'npm-adjacent', version: 'nested-version-2', extra: 'explicit-include' });
    const native = await fetch(server.url + '/docs/api/native');
    assert.equal(native.status, 200, await native.clone().text());
    const png = Buffer.from(await native.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 2);
    assert.equal(png.readUInt32BE(20), 3);
    const flight = await fetch(server.url + '/docs/application', { headers: { RSC: '1' } });
    assert.equal(flight.status, 200);
    assert.match(await flight.text(), /Portable App/);
    await server.close();
    if (process.platform !== 'win32') {
      server = await startStandalone(fixture.root, { native: true });
      assert.equal((await fetch(server.url + '/docs/server')).status, 200);
    }
  } finally { await server?.close(); await fixture.remove(); }
});
