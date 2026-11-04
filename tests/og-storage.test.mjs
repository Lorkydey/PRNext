import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, rm, writeFile, readFile, readdir, mkdtemp, cp, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {build} from '../packages/prnext/build/index.mjs';
import {appFixture, startServer} from './support.mjs';

test('production omits certified unused OG, preserves npm barrel usage and renders from a relocated standalone', {timeout: 120_000}, async () => {
  const f = await appFixture();
  let moved, child, plainServer, output = '';
  const put = async (name, source) => { const file = path.join(f.root, name); await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, source); };
  try {
    await rm(path.join(f.root, 'app'), {recursive: true});
    await rm(path.join(f.root, 'proxy.ts'), {force: true});
    await put('app/layout.jsx', `export default({children})=><html><body>{children}</body></html>`);
    await put('app/page.jsx', `export default()=> <h1>Small build</h1>`);
    await put('app/ping/route.js', `export const dynamic='force-dynamic';export const GET=()=>Response.json({ok:true});`);
    const plain = await build(f.root);
    for (const file of ['runtime/og', 'runtime/og-loader.mjs', 'compat/og.cjs']) await assert.rejects(access(path.join(plain.outputDirectory, file)), {code: 'ENOENT'}, file);
    const runtime = await readdir(path.join(plain.outputDirectory, 'runtime'));
    const chunks = await Promise.all(runtime.filter(name => name.endsWith('.mjs')).map(name => readFile(path.join(plain.outputDirectory, 'runtime', name), 'utf8')));
    assert.ok(chunks.every(source => !source.includes('resvg_wasm_exports') && !source.includes('og/index.node.mjs')), 'the unused renderer must not survive in a shared chunk');
    plainServer = await startServer(f.root);
    assert.deepEqual(await (await fetch(plainServer.url + '/ping')).json(), {ok: true});
    await plainServer.close(); plainServer = undefined;
    await put('node_modules/og-widget/package.json', '{"name":"og-widget","type":"module","exports":"./index.js"}');
    await put('node_modules/og-widget/index.js', `export {ImageResponse} from 'next/og';`);
    await put('app/og/route.jsx', `import {ImageResponse} from 'og-widget';export const dynamic='force-dynamic';export function GET(){return new ImageResponse(<div style={{display:'flex',fontSize:24}}>Standalone OG</div>,{width:240,height:80})}`);
    await put('prnext.config.mjs', `export default {output:'standalone'}`);
    const image = await build(f.root);
    await access(path.join(image.outputDirectory, 'runtime/og/index.node.mjs'));
    const loader = await readFile(path.join(image.outputDirectory, 'runtime/og-loader.mjs'), 'utf8');
    assert.match(loader, /\.\/og\/index.node.mjs/);
    const standalone = path.join(image.outputDirectory, 'standalone');
    moved = await mkdtemp(path.join(tmpdir(), 'prnext-og-deployed-'));
    await cp(standalone, moved, {recursive: true, verbatimSymlinks: true});
    const description = JSON.parse(await readFile(path.join(moved, 'standalone.json'), 'utf8'));
    const deployedRuntime = path.join(moved, description.app, description.distDir, 'runtime');
    // The loader must work independently too, with every relative WASM/font
    // read resolving inside the relocated artifact, rather than its source.
    await f.remove();
    const {loadImageRenderer} = await import(pathToFileURL(path.join(deployedRuntime, 'og-loader.mjs')).href);
    const {ImageResponse} = await loadImageRenderer();
    const {createElement} = await import('react');
    const direct = Buffer.from(await new ImageResponse(createElement('div', {style: {display: 'flex'}}, 'Loader'), {width: 120, height: 60}).arrayBuffer());
    assert.equal(direct.subarray(1, 4).toString(), 'PNG');
    assert.equal(direct.readUInt32BE(16), 120);
    child = spawn(process.execPath, [path.join(moved, 'server.js')], {cwd: moved, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, HOSTNAME: '127.0.0.1', PORT: '0', PRNEXT_WORKERS: '1'}});
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    let url;
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw Error('Standalone exited: ' + output);
      url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      if (url) { try { const response = await fetch(url + '/'); if (response.ok) break; } catch {} }
      await delay(50);
    }
    assert.ok(url, output);
    const response = await fetch(url + '/og');
    assert.equal(response.status, 200, output);
    assert.match(response.headers.get('content-type'), /image\/png/);
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 240); assert.equal(png.readUInt32BE(20), 80);
  } finally {
    await plainServer?.close();
    if (child && child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 15_000); child.once('close', () => {clearTimeout(timer); resolve();}); child.kill('SIGTERM'); });
    await f.remove(); if (moved) await rm(moved, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
});
