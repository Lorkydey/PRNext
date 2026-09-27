import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { standaloneFixture, startServer, repositoryRoot } from './support.mjs';

test('an independent app uses its own React installation for static render and SSR', async () => {
  const fixture = await standaloneFixture();
  let server;
  let deployed;
  try {
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
    deployed = await mkdtemp(path.join(tmpdir(), 'prnext-deployment-'));
    for (const file of ['.prnext', 'node_modules', 'package.json']) await cp(path.join(fixture.root, file), path.join(deployed, file), { recursive: true });
    await fixture.remove();
    server = await startServer(deployed);
    for (const pathname of ['/', '/server']) {
      const response = await fetch(server.url + pathname);
      assert.equal(response.status, 200, await response.clone().text());
      const html = await response.text();
      assert.match(html, /Independent React/);
      assert.match(html, /npm production count 0/);
    }
  } finally { await server?.close(); await fixture.remove(); if (deployed) await rm(deployed, { recursive: true, force: true }); }
});
