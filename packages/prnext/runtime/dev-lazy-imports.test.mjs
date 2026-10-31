import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,open} from 'node:fs/promises';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {materializeDevImport,MAX_LAZY_ASSET_BYTES} from './dev-lazy-imports.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-lazy-assets-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const current={directory:'current',manifest:{devLazy:{modules:[{id:'a'.repeat(24),importer:'app/client.jsx',request:'./editor'}],bridges:[],shared:[],outputs:{}},app:{actions:{}}}};
  const outputDirectory=path.join(root,'compiled'),id='a'.repeat(24),target={url:'/_prnext/assets/editor-hash.js',css:[]};
  await mkdir(path.join(root,'current/assets'),{recursive:true});await mkdir(path.join(outputDirectory,'assets'),{recursive:true});
  const built={outputDirectory,devLazy:{...current.manifest.devLazy,outputs:{[id]:target}},app:{actions:{}}};
  return {root,current,id,target,built,compile:async()=>built};
}

test('deferred asset publication rejects collisions and leaves the running generation untouched',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'current/assets/existing.js'),'original');
  await writeFile(path.join(f.built.outputDirectory,'assets/existing.js'),'different');
  await assert.rejects(materializeDevImport(f),/conflicting immutable asset/);
  assert.equal(await readFile(path.join(f.root,'current/assets/existing.js'),'utf8'),'original');
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});

test('deferred output budgets are checked before reading an oversized asset into memory',async t=>{
  const f=await fixture(t),file=await open(path.join(f.built.outputDirectory,'assets/oversized.js'),'wx');
  try{await file.truncate(MAX_LAZY_ASSET_BYTES+1);}finally{await file.close();}
  await assert.rejects(materializeDevImport(f),/128 MiB generation budget/);
  assert.equal(f.current.lazyAssetBytes,undefined);
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});

test('new Server Action implementations cannot be published as browser assets alone',async t=>{
  const f=await fixture(t);f.built.app.actions.newAction={module:'server/new-action.mjs'};
  await assert.rejects(materializeDevImport(f),/introduced a new Server Action/);
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});

test('a failed asset write stays charged across a successful retry',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'first asset');
  await writeFile(path.join(f.built.outputDirectory,'assets/b.js'),'second asset');
  const original=fs.writeFile;
  fs.writeFile=async(file,...args)=>{
    await original(file,...args);
    if(file===path.join(f.root,'current/assets/b.js'))throw Object.assign(Error('Injected asset I/O failure'),{code:'EIO'});
  };
  syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/Injected asset I\/O failure/);}
  finally{fs.writeFile=original;syncBuiltinESMExports();}
  const bytes=Buffer.byteLength('first asset')+Buffer.byteLength('second asset');
  assert.equal(f.current.lazyAssetBytes,bytes);
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
  assert.deepEqual(await materializeDevImport(f),f.target);
  assert.equal(f.current.lazyAssetBytes,bytes,'previously written files cannot disappear from the quota on retry');
});
