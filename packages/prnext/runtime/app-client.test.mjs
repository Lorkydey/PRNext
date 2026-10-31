import assert from 'node:assert/strict';
import test from 'node:test';
import {installFlightModuleLoader} from './app-client.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
function fixture(t,modules){
  const names=['__webpack_require__','__webpack_chunk_load__','__webpack_get_script_filename__'];
  const previous=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  t.after(()=>names.forEach((name,index)=>{if(previous[index])Object.defineProperty(globalThis,name,previous[index]);else delete globalThis[name];}));
  return installFlightModuleLoader(modules);
}

for(const rejectOld of [false,true])test(`pending Flight imports follow the current generation after an old ${rejectOld?'rejection':'resolution'}`,async t=>{
  const old=deferred(),next=deferred();
  const loader=fixture(t,{client:()=>old.promise});
  const initial=globalThis.__webpack_chunk_load__('client');await Promise.resolve();
  const updating=loader.updateModules({client:()=>next.promise});
  if(rejectOld)old.reject(new Error('obsolete import failed'));else old.resolve({revision:'old'});
  let finished=false;void initial.then(()=>{finished=true});
  await Promise.resolve();assert.equal(finished,false);
  next.resolve({revision:'new'});await Promise.all([updating,initial]);
  assert.equal(globalThis.__webpack_require__('client').revision,'new');
  await globalThis.__webpack_chunk_load__('client');
  assert.equal(globalThis.__webpack_require__('client').revision,'new');
});

test('loaded modules update without accepting a late result from an intermediate generation',async t=>{
  const loader=fixture(t,{client:async()=>({revision:'first'})});
  await globalThis.__webpack_chunk_load__('client');
  const intermediate=deferred();
  const firstUpdate=loader.updateModules({client:()=>intermediate.promise});
  await Promise.resolve();
  await loader.updateModules({client:async()=>({revision:'last'})});
  intermediate.resolve({revision:'intermediate'});await firstUpdate;
  assert.equal(globalThis.__webpack_require__('client').revision,'last');
});

test('a removed module cannot be resurrected by a pending old import',async t=>{
  const old=deferred(),loader=fixture(t,{client:()=>old.promise});
  const pending=globalThis.__webpack_chunk_load__('client');
  const rejected=assert.rejects(pending,/Unknown PRNext client module/);
  await loader.updateModules({});old.resolve({revision:'old'});await rejected;
  assert.throws(()=>globalThis.__webpack_require__('client'),/has not been loaded/);
});

test('a failed current generation rejects waiting imports and does not certify the old namespace',async t=>{
  const loader=fixture(t,{client:async()=>({revision:'first'})});
  await globalThis.__webpack_chunk_load__('client');
  await assert.rejects(loader.updateModules({client:async()=>{throw new Error('current import failed')}}),/current import failed/);
  assert.throws(()=>globalThis.__webpack_require__('client'),/has not been loaded/);
  await assert.rejects(globalThis.__webpack_chunk_load__('client'),/current import failed/);
});
