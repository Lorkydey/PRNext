import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,open,symlink} from 'node:fs/promises';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {materializeDevImport,MAX_LAZY_ASSET_BYTES,MAX_LAZY_ASSET_FILES} from './dev-lazy-imports.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-lazy-assets-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const current={directory:'current',manifest:{cacheId:'current-js-generation',devLazy:{modules:[{id:'a'.repeat(24),importer:'app/client.jsx',request:'./editor'}],bridges:[],shared:[],outputs:{}},app:{actions:{}}}};
  const outputDirectory=path.join(root,'compiled'),id='a'.repeat(24),target={url:'/_prnext/assets/editor-hash.js',css:[]};
  await mkdir(path.join(root,'current/assets'),{recursive:true});await mkdir(path.join(outputDirectory,'assets'),{recursive:true});
  const built={outputDirectory,devLazy:{...current.manifest.devLazy,outputs:{[id]:target}},app:{actions:{}}};
  return {root,current,id,target,built,compile:async()=>built};
}

for(const received of [false,true])test(`deferred asset publication rejects collisions and leaves the running generation untouched${received?' with a receipt':''}`,async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.root,'current/assets/existing.js'),'original');
  await writeFile(path.join(f.built.outputDirectory,'assets/existing.js'),'different');
  if(received)f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'existing.js',bytes:9}]};
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

for(const received of [false,true])test(`new Server Action implementations cannot be published as browser assets alone${received?' with a receipt':''}`,async t=>{
  const f=await fixture(t);f.built.app.actions.newAction={module:'server/new-action.mjs'};
  if(received)f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[]};
  await assert.rejects(materializeDevImport(f),/introduced a new Server Action/);
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});

for(const received of [false,true])test(`a partial asset write remains private and a retry publishes complete assets${received?' from a receipt':''}`,async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'first asset');
  await writeFile(path.join(f.built.outputDirectory,'assets/b.js'),'second asset');
  if(received)f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'a.js',bytes:11},{name:'b.js',bytes:12}]};
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

for(const received of [false,true])test(`a publication failure preserves complete immutable assets and charges them once across retry${received?' from a receipt':''}`,async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'first asset');
  await writeFile(path.join(f.built.outputDirectory,'assets/b.js'),'second asset');
  if(received)f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'a.js',bytes:11},{name:'b.js',bytes:12}]};
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

test('a two-file receipt ignores a thousand unrelated assets without enumerating the directory',async t=>{
  const f=await fixture(t),source=path.join(f.built.outputDirectory,'assets');
  await writeFile(path.join(source,'editor.js'),'editor');await writeFile(path.join(source,'editor.css'),'style');
  for(let offset=0;offset<1000;offset+=50)await Promise.all(Array.from({length:50},(_,index)=>writeFile(path.join(source,`unrelated-${offset+index}.js`),'unused')));
  f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'editor.js',bytes:6},{name:'editor.css',bytes:5}]};
  const original=fs.readdir;let scans=0;
  fs.readdir=async(directory,...args)=>{if(path.resolve(directory)===source){scans++;throw Error('Receipt assets must not be enumerated');}return original(directory,...args);};
  syncBuiltinESMExports();
  try{assert.deepEqual(await materializeDevImport(f),f.target);}finally{fs.readdir=original;syncBuiltinESMExports();}
  assert.equal(scans,0);assert.equal(f.current.lazyAssetBytes,11);
  assert.deepEqual((await readdir(path.join(f.root,'current/assets'))).sort(),['editor.css','editor.js']);
  assert.equal(await readFile(path.join(f.root,'current/assets/editor.js'),'utf8'),'editor');
});

test('invalid receipt metadata is rejected before reading or inspecting asset files',async t=>{
  const f=await fixture(t),valid={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'a.js',bytes:1}]};
  const invalid=[undefined,null,{...valid,version:2},{...valid,baseCacheId:'previous-generation'},{...valid,files:null},
    {...valid,files:Array.from({length:MAX_LAZY_ASSET_FILES+1},(_,index)=>({name:`asset-${index}.js`,bytes:0}))},
    {...valid,files:[{name:'a.js',bytes:MAX_LAZY_ASSET_BYTES},{name:'b.js',bytes:1}]},
    ...[-1,0.5,NaN,Infinity,MAX_LAZY_ASSET_BYTES+1].map(bytes=>({...valid,files:[{name:'a.js',bytes}]})),
    ...['../escape.js','a/b.js','a\\b.js','a.js:payload','a.js\n','.','..','trailing.','CON.js','lpt1','é.js'].map(name=>({...valid,files:[{name,bytes:0}]})),
    {...valid,files:[{name:'a.js',bytes:0},{name:'a.js',bytes:0}]},
    {...valid,files:[{name:'A.js',bytes:0},{name:'a.js',bytes:0}]},
  ];
  const originals={lstat:fs.lstat,open:fs.open,readFile:fs.readFile,readdir:fs.readdir};let assetIO=0;
  for(const name of Object.keys(originals))fs[name]=async()=>{assetIO++;throw Error('Asset I/O must not run before receipt validation');};
  syncBuiltinESMExports();
  try{for(const receipt of invalid){f.built.devLazyAssets=receipt;await assert.rejects(materializeDevImport(f),/receipt|budget/);}}
  finally{Object.assign(fs,originals);syncBuiltinESMExports();}
  assert.equal(assetIO,0);assert.equal(f.current.lazyAssetBytes,undefined);assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
  assert.deepEqual(await readdir(path.join(f.root,'current/assets')),[]);
});

test('all receipt file types and declared sizes are checked before payload reads or publication',async t=>{
  const f=await fixture(t),source=path.join(f.built.outputDirectory,'assets');
  await writeFile(path.join(source,'a.js'),'a');await writeFile(path.join(source,'b.js'),'wrong-size');
  f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'a.js',bytes:1},{name:'b.js',bytes:1}]};
  const original=fs.open;let opened=0;
  fs.open=async(...args)=>{opened++;return original(...args);};syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/receipt byte size/);}finally{fs.open=original;syncBuiltinESMExports();}
  assert.equal(opened,0);assert.deepEqual(await readdir(path.join(f.root,'current/assets')),[]);
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);assert.equal(f.current.lazyAssetBytes,undefined);
});

test('a receipt rejects a symlink instead of copying its target',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside.js'),alias=path.join(f.built.outputDirectory,'assets/alias.js');
  await writeFile(outside,'private');
  try{await symlink(outside,alias,'file');}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('File symlinks are unavailable for this process');return;}throw error;}
  f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'alias.js',bytes:7}]};
  await assert.rejects(materializeDevImport(f),/regular file without symbolic links/);
  assert.deepEqual(await readdir(path.join(f.root,'current/assets')),[]);assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});

for(const changed of ['x','grown-asset'])test(`receipt reads reject a file ${changed==='x'?'truncated':'grown'} after its final stat`,async t=>{
  const f=await fixture(t),filename=path.join(f.built.outputDirectory,'assets/a.js');
  await writeFile(filename,'abc');f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'a.js',bytes:3}]};
  const original=fs.open;let closed=false;
  fs.open=async(file,...args)=>{
    const handle=await original(file,...args);
    if(path.resolve(file)!==filename)return handle;
    return {stat:async()=>{const info=await handle.stat();await writeFile(filename,changed);return info;},read:handle.read.bind(handle),close:async()=>{closed=true;await handle.close();}};
  };syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/receipt byte size/);}finally{fs.open=original;syncBuiltinESMExports();}
  assert.equal(closed,true);assert.deepEqual(await readdir(path.join(f.root,'current/assets')),[]);
  assert.equal(f.current.lazyAssetBytes,undefined);assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});

for(const received of [false,true])test(`a collision during exclusive publication never overwrites the other immutable asset${received?' with a receipt':''}`,async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.built.outputDirectory,'assets/a.js'),'our asset');
  if(received)f.built.devLazyAssets={version:1,baseCacheId:f.current.manifest.cacheId,files:[{name:'a.js',bytes:9}]};
  const original=fs.link;
  fs.link=async(from,to)=>{await writeFile(to,'other immutable asset',{flag:'wx'});return original(from,to);};
  syncBuiltinESMExports();
  try{await assert.rejects(materializeDevImport(f),/conflicting immutable asset/);}
  finally{fs.link=original;syncBuiltinESMExports();}
  assert.equal(await readFile(path.join(f.root,'current/assets/a.js'),'utf8'),'other immutable asset');
  assert.equal(f.current.manifest.devLazy.outputs[f.id],undefined);
});
