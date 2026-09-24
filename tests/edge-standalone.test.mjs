import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';
import { startStandalone } from './standalone-output-fixture.mjs';

test('Edge handlers and middleware remain portable after deleting the original project and npm installation', async () => {
  const fixture = await appFixture();
  let deployed, server;
  try {
    for (const name of ['app', 'pages', 'components', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    await mkdir(path.join(fixture.root, 'app/edge'), { recursive: true });
    await writeFile(path.join(fixture.root, 'rustyx.config.mjs'), "export default{output:'standalone',basePath:'/docs'}");
    await writeFile(path.join(fixture.root, 'middleware.js'), "import {NextResponse} from 'next/server';export const config={runtime:'edge',matcher:'/edge'};export default()=>NextResponse.next({headers:{'x-edge-middleware':EdgeRuntime}})");
    await writeFile(path.join(fixture.root, 'app/edge/route.js'), "export const runtime='edge';export const GET=()=>Response.json({edge:EdgeRuntime,node:typeof Buffer,hash:crypto.randomUUID().length})");
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root], { timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    deployed = await mkdtemp(path.join(os.tmpdir(), 'rustyx-edge-deployed-'));
    await cp(path.join(fixture.root, '.rustyx/standalone'), deployed, { recursive: true, verbatimSymlinks: true });
    await fixture.remove();
    server = await startStandalone(deployed);
    const response = await fetch(server.url + '/docs/edge');
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-edge-middleware'), 'edge-runtime');
    assert.deepEqual(await response.json(), { edge: 'edge-runtime', node: 'undefined', hash: 36 });
  } finally { await server?.close(); await fixture.remove(); if (deployed) await rm(deployed, { recursive: true, force: true }); }
});
