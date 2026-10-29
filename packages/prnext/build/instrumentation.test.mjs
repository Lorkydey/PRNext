import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from './index.mjs';
import {initializeInstrumentation} from '../runtime/instrumentation.mjs';

test('src CommonJS instrumentation bundles conditional Node/Edge imports; duplicate hooks preserve the last build',async t=>{
  const root=await mkdtemp(fileURLToPath(new URL('../../../.prnext-instrumentation-build-',import.meta.url)));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await mkdir(path.join(root,'src/app/edge'),{recursive:true});
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  await writeFile(path.join(root,'src/app/edge/route.js'),`export const runtime='edge';export function GET(){return Response.json({ok:true})}`);
  await writeFile(path.join(root,'src/instrumentation.cjs'),`exports.register=async()=>{if(process.env.NEXT_RUNTIME==='nodejs'){const fs=require('node:fs');globalThis.__prnextHookTest=typeof fs.readFile}else{globalThis.__prnextHookTest='edge'}};exports.onRequestError=async()=>{};`);
  const manifest=await build(root);assert.equal(globalThis.__prnextHookTest,undefined,'static build does not run runtime registration');
  const node=await initializeInstrumentation(manifest.outputDirectory,manifest);assert.equal(typeof node.register,'function');assert.equal(globalThis.__prnextHookTest,'function');delete globalThis.__prnextHookTest;
  const edge=await initializeInstrumentation(manifest.outputDirectory,manifest,{realm:'edge'});assert.equal(typeof edge.register,'function');
  await writeFile(path.join(root,'instrumentation.ts'),'export function register(){}');
  await assert.rejects(build(root),/Only one instrumentation/);
  assert.equal(JSON.parse(await readFile(path.join(manifest.outputDirectory,'manifest.json'),'utf8')).cacheId,manifest.cacheId);
});
