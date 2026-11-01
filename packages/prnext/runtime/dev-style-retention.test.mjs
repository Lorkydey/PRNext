import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {pruneDevelopmentStyles} from './dev-style-retention.mjs';

test('style retention waits for asset leases and deletes only the excess snapshots',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-style-retention-'));
  try{
    const generations=Array.from({length:5},(_,id)=>({id:String(id),directory:'styles-'+id}));
    await Promise.all(generations.map(item=>mkdir(path.join(root,item.directory))));
    let release;const drained=new Promise(resolve=>release=resolve),calls=[];
    const pending=pruneDevelopmentStyles(generations,{request:async(command,{generation})=>{calls.push([command,generation]);if(command==='retire'&&generation==='0')await drained;}},root);
    assert.deepEqual(calls,[['retire','0']]);assert.equal(generations.length,5);assert.equal((await readdir(root)).length,5);
    release();await pending;
    assert.deepEqual(calls,[['retire','0'],['forget','0'],['retire','1'],['forget','1']]);
    assert.deepEqual(generations.map(item=>item.id),['2','3','4']);
    assert.deepEqual((await readdir(root)).sort(),['styles-2','styles-3','styles-4']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('failed style retirement stays tracked for the next cleanup attempt',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-style-retention-'));
  try{
    const generations=Array.from({length:4},(_,id)=>({id:String(id),directory:'styles-'+id}));
    await Promise.all(generations.map(item=>mkdir(path.join(root,item.directory))));
    await assert.rejects(pruneDevelopmentStyles(generations,{request:async()=>{throw Error('Asset lease did not drain');}},root),/did not drain/);
    assert.equal(generations.length,4);assert.equal((await readdir(root)).length,4);
    await pruneDevelopmentStyles(generations,{request:async()=>{}},root);
    assert.equal(generations.length,3);assert.deepEqual((await readdir(root)).sort(),['styles-1','styles-2','styles-3']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a failed filesystem deletion stays tracked after the gateway has forgotten its assets',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-style-retention-'));
  const original=fs.rm;
  try{
    const generations=Array.from({length:4},(_,id)=>({id:String(id),directory:'styles-'+id}));
    await Promise.all(generations.map(item=>mkdir(path.join(root,item.directory))));
    fs.rm=async(...args)=>{if(args[0]===path.join(root,'styles-0'))throw Object.assign(Error('Injected deletion failure'),{code:'EIO'});return original(...args);};syncBuiltinESMExports();
    await assert.rejects(pruneDevelopmentStyles(generations,{request:async()=>{}},root),{code:'EIO'});
    assert.equal(generations.length,4);assert.equal((await readdir(root)).length,4);
    fs.rm=original;syncBuiltinESMExports();
    await pruneDevelopmentStyles(generations,{request:async()=>{}},root);
    assert.equal(generations.length,3);assert.equal((await readdir(root)).length,3);
  }finally{fs.rm=original;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});
