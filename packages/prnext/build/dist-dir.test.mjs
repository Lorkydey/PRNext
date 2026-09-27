import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './index.mjs';
import { validateProjectConfig } from './config.mjs';
import { readBuildDirectory } from '../runtime/build-directory.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(run){const root=await mkdtemp(path.join(repo,'.prnext-dist-test-'));try{await mkdir(path.join(root,'pages'));await writeFile(path.join(root,'pages/index.jsx'),'export default function Page(){return <h1>Custom output</h1>}');await run(root)}finally{await rm(root,{recursive:true,force:true})}}

test('distDir publishes nested output, keeps the active artifact on failure and can return to the default',async()=>fixture(async root=>{
  assert.equal(await readBuildDirectory(root),'.prnext');
  await writeFile(path.join(root,'prnext.config.mjs'),`export default {distDir:'build/server'}`);
  const built=await build(root);
  assert.equal(built.outputDirectory,path.join(root,'build/server'));
  assert.equal(await readBuildDirectory(root),'build/server');
  const manifest=await readFile(path.join(built.outputDirectory,'manifest.json'),'utf8');
  await writeFile(path.join(root,'prnext.config.mjs'),`export default {distDir:'next-output'}`);
  await writeFile(path.join(root,'pages/index.jsx'),'broken syntax {');
  await assert.rejects(build(root));
  assert.equal(await readBuildDirectory(root),'build/server');
  assert.equal(await readFile(path.join(built.outputDirectory,'manifest.json'),'utf8'),manifest);
  await writeFile(path.join(root,'pages/index.jsx'),'export default function Page(){return <h1>Restored</h1>}');
  await writeFile(path.join(root,'prnext.config.mjs'),'export default {}');
  await build(root);
  assert.equal(await readBuildDirectory(root),'.prnext');
  assert.equal((await readdir(root)).some(file=>/^\.prnext-(build|backup|output)-/.test(file)),false);
}));

test('distDir refuses traversal, source folders, symlink ancestors and unrelated existing files',async()=>fixture(async root=>{
  for(const distDir of['',false,'../outside','/absolute','a/../b','a//b','a\\b','public','src/build','node_modules/out','.git/out'])assert.throws(()=>validateProjectConfig({distDir}),/distDir/);
  await mkdir(path.join(root,'unrelated'));
  await writeFile(path.join(root,'unrelated/keep.txt'),'keep');
  await writeFile(path.join(root,'prnext.config.mjs'),`export default {distDir:'unrelated'}`);
  await assert.rejects(build(root),/unrelated files/);
  assert.equal(await readFile(path.join(root,'unrelated/keep.txt'),'utf8'),'keep');
  const outside=await mkdtemp(path.join(repo,'.prnext-dist-outside-'));
  try{
    await symlink(outside,path.join(root,'linked'),'dir');
    await writeFile(path.join(root,'prnext.config.mjs'),`export default {distDir:'linked/server'}`);
    await assert.rejects(build(root),/symbolic links/);
    assert.deepEqual(await readdir(outside),[]);
  }finally{await rm(outside,{recursive:true,force:true})}
  assert.equal(await readBuildDirectory(root),'.prnext');
}));
