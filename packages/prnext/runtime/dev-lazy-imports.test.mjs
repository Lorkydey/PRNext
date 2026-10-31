import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,open} from 'node:fs/promises';
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

test('a partial asset write remains private and a retry publishes complete assets',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'first asset');
  await writeFile(path.join(f.built.outputDirectory,'assets/b.js'),'second asset');
  const original=fs.writeFile;
  fs.writeFile=async(file,...args)=>{
    if(path.basename(file)==='b.js'){
      await original(file,Buffer.from(args[0]).subarray(0,3),args[1]);
      throw Object.assign(Error('Injected partial asset I/O failure'),{code:'EIO'});
    }
    return original(file,...args);
  };
  syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/Injected partial asset I\/O failure/);}
  finally{fs.writeFile=original;syncBuiltinESMExports();}
  const bytes=Buffer.byteLength('first asset')+Buffer.byteLength('second asset');
  assert.deepEqual(await readdir(path.join(f.root,'current/assets')),[],'partial bytes never become a public immutable asset');
  assert.deepEqual(await readdir(path.join(f.root,'current')),['assets'],'only the owned staging directory is removed');
  assert.equal(f.current.lazyAssetBytes,0,'removed unpublished staging bytes may be reclaimed');
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
  assert.deepEqual(await materializeDevImport(f),f.target);
  assert.equal(f.current.lazyAssetBytes,bytes);
  assert.equal(await readFile(path.join(f.root,'current/assets/b.js'),'utf8'),'second asset');
});

test('a publication failure preserves complete immutable assets and charges them once across retry',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'first asset');
  await writeFile(path.join(f.built.outputDirectory,'assets/b.js'),'second asset');
  const original=fs.link;
  fs.link=async(from,to)=>{await original(from,to);if(path.basename(to)==='b.js')throw Object.assign(Error('Injected publication uncertainty'),{code:'EIO'});};
  syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/Injected publication uncertainty/);}
  finally{fs.link=original;syncBuiltinESMExports();}
  const bytes=Buffer.byteLength('first asset')+Buffer.byteLength('second asset');
  assert.equal(f.current.lazyAssetBytes,bytes);
  assert.equal(await readFile(path.join(f.root,'current/assets/a.js'),'utf8'),'first asset');
  assert.equal(await readFile(path.join(f.root,'current/assets/b.js'),'utf8'),'second asset');
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
  assert.deepEqual(await materializeDevImport(f),f.target);
  assert.equal(f.current.lazyAssetBytes,bytes);
});

test('a collision during exclusive publication never overwrites the other immutable asset',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'our asset');
  const original=fs.link;
  fs.link=async(from,to)=>{await writeFile(to,'other immutable asset',{flag:'wx'});return original(from,to);};
  syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/conflicting immutable asset/);}
  finally{fs.link=original;syncBuiltinESMExports();}
  assert.equal(await readFile(path.join(f.root,'current/assets/a.js'),'utf8'),'other immutable asset');
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});
