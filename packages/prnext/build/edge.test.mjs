import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileEdge } from './edge.mjs';
import { scanProject } from './scan.mjs';
import { loadEdgeModule } from '../runtime/edge.mjs';

test('Edge statically bundles nested CommonJS packages without exposing a runtime require', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-edge-cjs-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const directory = path.join(root, 'node_modules/web-compatible');
  await mkdir(directory, {recursive:true});
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({name:'web-compatible',main:'index.cjs'}));
  await writeFile(path.join(directory, 'value.cjs'), 'exports.value=42');
  await writeFile(path.join(directory, 'index.cjs'), "module.exports={value:require('./value.cjs').value}");
  const file = path.join(root, 'route.js'), outfile = path.join(root, 'server/route.mjs');
  await writeFile(file, "import data from 'web-compatible';export const GET=()=>Response.json({value:data.value,require:typeof require,Buffer:typeof Buffer});");
  await compileEdge({file,outfile,projectRoot:root});
  const edge = await loadEdgeModule(await readFile(outfile.replace('.mjs','.edge.js'),'utf8'), file);
  assert.deepEqual(await (await edge.GET(new Request('https://example.test/'))).json(), {value:42,require:'undefined',Buffer:'undefined'});
  await writeFile(path.join(directory, 'value.cjs'), "module.exports=require('node:fs')");
  await assert.rejects(compileEdge({file,outfile,projectRoot:root}), /Node.js module node:fs cannot run/);
});

test('Edge compilation rejects Node and dynamic execution in the transitive package graph', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-edge-build-'));
  try {
    const file = path.join(root, 'route.js'), outfile = path.join(root, 'server/route.mjs');
    await mkdir(path.join(root, 'node_modules/unsafe-package'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/unsafe-package/package.json'), JSON.stringify({ name: 'unsafe-package', type: 'module', exports: './index.js' }));
    for (const [source, message] of [
      ["import fs from 'node:fs';export const value=fs", /Node.js module node:fs cannot run/],
      ["import fs from 'fs';export const value=fs", /Node.js module fs cannot run/],
      ["import './theme.css';export const value=1", /theme.css cannot run in the Edge Runtime/],
      ["const id='anything';export const value=require(id)", /dynamic require\(\) is not supported/],
      ["const load=require;export const value=load('anything')", /runtime require reference/],
      ["export const value=eval('1+1')", /eval\(\) is not supported/],
      ["export const value=new Function('return 1')", /Function\(\) is not supported/],
      ["export const value=globalThis.eval('1')", /Dynamic JavaScript compilation/],
      ["export const value=WebAssembly.compile(new Uint8Array())", /dynamic WebAssembly compilation/],
      ["export const value=module.require('fs')", /Node module APIs/],
      ["const name='./module.js';export const value=import(name)", /dynamic import paths/],
      ["'use server';export async function value(){}", /Server Actions/],
      ["export function value(){async function action(){'use server';return 1}return action}", /Server Actions/],
      ["export async function value(){'use cache';return 1}", /Cache Components/],
    ]) {
      await writeFile(path.join(root, 'node_modules/unsafe-package/index.js'), source);
      await writeFile(file, `import {value} from 'unsafe-package';export const GET=()=>Response.json(value);`);
      await assert.rejects(compileEdge({ file, outfile, projectRoot: root }), message);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Edge routes preserve their runtime and reject unsupported ISR options before compilation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prnext-edge-config-'));
  try {
    await mkdir(path.join(root, 'app'));
    const route = path.join(root, 'app/route.js');
    await writeFile(route, "export const runtime='edge';export const GET=()=>new Response('ok')");
    assert.equal((await scanProject(root)).routes[0].handlerConfig.runtime, 'edge');
    for (const option of ['export const revalidate=10', "export const dynamic='force-static'", "export const dynamic='error'"]) {
      await writeFile(route, `export const runtime='edge';${option};export const GET=()=>new Response('ok')`);
      await assert.rejects(scanProject(root), /Edge Runtime does not support static generation or ISR/);
    }
    await rm(route);
    await writeFile(path.join(root, 'app/page.jsx'), "export const runtime='edge';export default()=>null");
    await writeFile(path.join(root, 'app/layout.jsx'), 'export default({children})=><html><body>{children}</body></html>');
    assert.equal((await scanProject(root)).routes.find(route => route.kind === 'page').cacheConfig.runtime, 'edge');
  } finally { await rm(root, { recursive: true, force: true }); }
});
