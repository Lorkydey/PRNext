import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink,link,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createReplayStore} from './dev-replay-store.mjs';
import {replayLimits} from './dev-replay-model.mjs';
const scenario=()=>({version:1,name:'Saved intention',viewport:{width:390,height:844},steps:[{type:'visit',path:'/'},{type:'expectURL',path:'/'}]});
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'prnext-replay-store-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,store:await createReplayStore({root})};}
test('scenario definitions survive reopening and only known generated identifiers can be updated or removed',async t=>{
  const {root,store}=await fixture(t),saved=await store.save(scenario());assert.match(saved.id,/^[a-f0-9-]{36}$/);assert.deepEqual(await store.get(saved.id),saved);
  const reopened=await createReplayStore({root});assert.deepEqual(await reopened.list(),[saved]);saved.name='Updated';assert.equal((await reopened.save(saved)).name,'Updated');
  await assert.rejects(store.save({...scenario(),id:randomUUID()}),/Unknown/);await assert.rejects(store.get('../secret'),/identifier/);await store.remove(saved.id);assert.deepEqual(await store.list(),[]);
});
test('results retain only the latest three per scenario and remove only that scenario evidence',async t=>{
  const {root,store}=await fixture(t),a=await store.save(scenario()),b=await store.save({...scenario(),name:'Other'});
  for(let index=0;index<6;index++)await store.saveResult({id:a.id,runId:randomUUID(),state:'failed',verified:false,startedAt:index,finishedAt:index+1,steps:[],errors:[]});
  await store.saveResult({id:b.id,runId:randomUUID(),state:'failed',verified:false,startedAt:100,finishedAt:101,steps:[],errors:[]});
  assert.deepEqual((await store.results(a.id)).map(run=>run.startedAt),[5,4,3]);assert.equal((await readdir(path.join(root,'.prnext-replays','results'))).length,4);
  await store.remove(a.id);assert.equal((await store.results(b.id)).length,1);
});
test('linked directories, hardlinks and symbolic scenario files are rejected without modifying their targets',async t=>{
  const {root,store}=await fixture(t),saved=await store.save(scenario()),file=path.join(root,'.prnext-replays','scenarios',saved.id+'.json'),outside=path.join(root,'outside.json');
  await writeFile(outside,'sensitive original');await rm(file);await link(outside,file);await assert.rejects(store.get(saved.id),/linked/);await assert.rejects(store.remove(saved.id),/linked/);assert.equal(await readFile(outside,'utf8'),'sensitive original');await rm(file);
  try{await symlink(outside,file,'file');}catch(error){if(error.code==='EPERM'){t.diagnostic('File symlink requires Windows developer privilege; hardlink defense still checked.');return;}throw error;}
  await assert.rejects(store.get(saved.id),/linked/);assert.equal(await readFile(outside,'utf8'),'sensitive original');
});
test('a storage junction is rejected and oversized files are never parsed',async t=>{
  const {root,store}=await fixture(t),saved=await store.save(scenario()),file=path.join(root,'.prnext-replays','scenarios',saved.id+'.json');
  await writeFile(file,' '.repeat(65537));await assert.rejects(store.get(saved.id),/size limit/);
  await rm(path.join(root,'.prnext-replays'),{recursive:true});const outside=path.join(root,'outside');await mkdir(outside);await symlink(outside,path.join(root,'.prnext-replays'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(store.list(),/linked/);assert.deepEqual(await readdir(outside),[]);
});
test('the aggregate definition limit bounds full library responses without dropping scenarios',async t=>{
  const {store}=await fixture(t),large=scenario();large.steps.push(...Array.from({length:20},()=>({type:'expectText',target:{kind:'testId',value:'result'},text:'x'.repeat(1900)})));
  let accepted=0;
  for(let index=0;index<10;index++)try{await store.save({...large,name:'Large '+index});accepted++;}catch(error){assert.match(error.message,/library size limit/);break;}
  assert.ok(accepted>1&&accepted<10);const listed=await store.list();assert.equal(listed.length,accepted);assert.ok(Buffer.byteLength(JSON.stringify(listed))<=replayLimits.maxLibraryBytes);
  const first=listed[0];first.name='Updated safely';await store.save(first);assert.equal((await store.list()).length,accepted);
});
test('result files cannot introduce unbounded messages, unknown fields or inconsistent success states',async t=>{
  const {store,root}=await fixture(t),saved=await store.save(scenario()),result={id:saved.id,runId:randomUUID(),state:'failed',verified:false,startedAt:1,finishedAt:2,steps:[],errors:[]};
  await assert.rejects(store.saveResult({...result,reason:'x'.repeat(501)}),/result text/);
  await assert.rejects(store.saveResult({...result,parameters:{password:'private'}}),/result fields/);
  await assert.rejects(store.saveResult({...result,verified:true}),/Invalid replay result/);
  await assert.rejects(store.saveResult({...result,state:'verified',verified:true}),/evidence is incomplete/);
  await store.saveResult(result);const file=path.join(root,'.prnext-replays','results',saved.id+'.'+result.runId+'.json');await writeFile(file,JSON.stringify({...result,reason:'x'.repeat(501)}));await assert.rejects(store.results(saved.id),/result text/);
});
