import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {nativePprArtifact,NativePprArtifactCache,partialShell,sha256} from './native-ppr.mjs';

async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-native-ppr-cache-'));await mkdir(path.join(root,'static'));
  const artifact={version:1,shell:'<!DOCTYPE html><html><head></head><body><p>public shell</p></body></html>',postponed:{next:{id:1}},flight:'cHVibGlj',headers:{'x-public':'yes'}};
  const route={id:'ppr',client:'/_prnext/assets/app.js',ppr:{'/':'static/ppr.json'}};
  const make=async value=>{
    const bytes=Buffer.from(JSON.stringify(value));await writeFile(path.join(root,'static/ppr.json'),bytes);
    const descriptor={routeId:route.id,path:'/',artifact:'static/ppr.json',artifactHash:sha256(bytes),prefixHash:sha256(Buffer.from(partialShell(value,route).replace(/<\/body><\/html>$/i,''))),identity:sha256(value.flight)};
    return{distDir:root,url:'http://localhost/',route,renderMode:'native-ppr:'+descriptor.artifactHash,manifest:{config:{nativePprShell:true,nativePprArtifacts:[descriptor]}}};
  };
  return{root,artifact,make,remove:()=>rm(root,{recursive:true,force:true})};
}

test('native PPR cache reuses only frozen public parsing after current file verification',async()=>{
  const f=await fixture(),cache=new NativePprArtifactCache();
  try{
    const input=await f.make(f.artifact),first=await nativePprArtifact(input,cache),second=await nativePprArtifact(input,cache);
    assert.equal(first.artifact,second.artifact);assert.equal(cache.parses,1);assert.equal(cache.hits,1);
    assert.ok(Object.isFrozen(first.artifact)&&Object.isFrozen(first.artifact.postponed.next));
    assert.throws(()=>{first.artifact.headers['x-public']='private';},TypeError);
    const continuation=structuredClone(first.artifact.postponed);continuation.next.id=99;assert.equal(second.artifact.postponed.next.id,1);
    // Same-size tampering still fails: a cache hit never skips the actual SHA.
    await writeFile(path.join(f.root,'static/ppr.json'),JSON.stringify({...f.artifact,flight:'cHJpdmF0'}));
    await assert.rejects(nativePprArtifact(input,cache),/changed after publication/);assert.equal(cache.hits,1);
  }finally{await f.remove();}
});

test('native PPR cached snapshots retain descriptor bindings and new publication identity',async()=>{
  const f=await fixture(),cache=new NativePprArtifactCache({maxEntries:1});
  try{
    const input=await f.make(f.artifact),old=await nativePprArtifact(input,cache),descriptor=input.manifest.config.nativePprArtifacts[0];
    for(const field of['prefixHash','identity']){
      const wrong={...descriptor,[field]:'0'.repeat(64)};
      await assert.rejects(nativePprArtifact({...input,manifest:{config:{nativePprShell:true,nativePprArtifacts:[wrong]}}},cache),/Invalid native PPR snapshot/);
    }
    await assert.rejects(nativePprArtifact({...input,route:{...input.route,client:'/different.js'}},cache),/Invalid native PPR snapshot/);
    const next=await f.make({...f.artifact,shell:f.artifact.shell.replace('public shell','new public shell')});
    const fresh=await nativePprArtifact(next,cache);assert.notEqual(fresh.artifact,old.artifact);assert.match(fresh.artifact.shell,/new public shell/);assert.equal(cache.entries.size,1);assert.ok(cache.bytes<=cache.maxBytes);
    await assert.rejects(nativePprArtifact(input,cache),/changed after publication/);
  }finally{await f.remove();}
});

test('native PPR retention budgets bypass large or complex JSON without weakening validation',async()=>{
  const f=await fixture();
  try{
    const input=await f.make(f.artifact);
    for(const options of[{maxEntries:0},{maxEntryBytes:1},{maxBytes:1},{maxNodes:1}]){
      const cache=new NativePprArtifactCache(options);const first=await nativePprArtifact(input,cache),second=await nativePprArtifact(input,cache);
      assert.notEqual(first.artifact,second.artifact);assert.equal(cache.parses,2);assert.equal(cache.entries.size,0);assert.equal(cache.bytes,0);
    }
    for(const invalid of[NaN,Infinity,-1,true,1.5])assert.throws(()=>new NativePprArtifactCache({maxBytes:invalid}),TypeError);
    await assert.rejects(nativePprArtifact({...input,url:'http://localhost/?private=1'}),/does not match/);
    await assert.rejects(nativePprArtifact({...input,manifest:{...input.manifest,dev:true}}),/Invalid/);
  }finally{await f.remove();}
});

test('wide primitive arrays, huge keys and many nested children cannot enter the native JSON cache',async()=>{
  const f=await fixture();
  try{
    for(const extra of[
      {values:Array(10000).fill('')},
      {['key'.repeat(20000)]:0},
      {values:Array.from({length:128},(_,index)=>({index,child:{label:'public'}}))},
    ]){
      const cache=new NativePprArtifactCache({maxNodes:64}),input=await f.make({...f.artifact,...extra});
      await nativePprArtifact(input,cache);await nativePprArtifact(input,cache);
      assert.equal(cache.entries.size,0);assert.equal(cache.bytes,0);assert.equal(cache.parses,2);
    }
  }finally{await f.remove();}
});
