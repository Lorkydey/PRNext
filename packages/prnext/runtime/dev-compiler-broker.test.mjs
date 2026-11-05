import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevCompilerBroker,deferredCompiler} from './dev-compiler-broker.mjs';
import {requestLoopback} from './loopback-rpc.mjs';
import {createDevelopmentQueue} from './development-queue.mjs';

test('compiler broker proves its identity, bounds pending work and validates retained patterns',{timeout:10000},async t=>{
  let finish,entered;const started=new Promise(resolve=>entered=resolve),calls=[];
  const broker=await createDevCompilerBroker({maxPending:1,compile:async(pattern,sources,admission)=>{calls.push([pattern,sources]);assert.ok(admission.signal instanceof AbortSignal);entered();await new Promise(resolve=>finish=resolve);return '.prnext-dev/session/generation';}});
  t.after(broker.close);const connection=JSON.parse(broker.descriptor);
  const request=(input,overrides={})=>requestLoopback({...connection,...overrides},input,{context:'development-compiler',timeout:5000,maxResponseBytes:65536});
  await assert.rejects(request({pattern:'/private'},{token:'wrong-key'}),/authentication failed/);
  const first=request({pattern:'/article/[id]',sources:['/feed']});await started;
  await assert.rejects(request({pattern:'/other'}),/compiler is busy/);
  finish();assert.deepEqual(await first,{directory:'.prnext-dev/session/generation'});
  assert.deepEqual(calls,[['/article/[id]',['/feed']]]);
  for(const input of [{pattern:'relative'},{pattern:'/x',sources:['relative']},{pattern:'/x',sources:Array(33).fill('/a')}])await assert.rejects(request(input),/Invalid/);
  assert.equal(calls.length,1);
});

test('compiler broker cancellation removes queued work while preserving watcher operations',{timeout:10000},async t=>{
  const queue=createDevelopmentQueue();let release,entered,queued;
  const started=new Promise(resolve=>entered=resolve),enqueued=new Promise(resolve=>queued=resolve),calls=[];
  const active=queue.enqueue(async()=>{entered();await new Promise(resolve=>release=resolve);calls.push('active');});await started;
  const broker=await createDevCompilerBroker({compile:(pattern,sources,admission)=>{const task=queue.enqueue(()=>calls.push('obsolete'),admission);queued(admission);return task;}});
  t.after(broker.close);const controller=new AbortController();
  const request=requestLoopback(JSON.parse(broker.descriptor),{pattern:'/cold'},{context:'development-compiler',signal:controller.signal,timeout:5000,maxResponseBytes:65536});
  const rejected=assert.rejects(request,/aborted/),admission=await enqueued;
  const cancelled=new Promise(resolve=>admission.signal.addEventListener('abort',resolve,{once:true}));
  controller.abort();await rejected;await cancelled;
  assert.equal(queue.pending,0,'disconnected compiler request is removed before the active build finishes');
  const watcher=queue.enqueue(()=>calls.push('watcher'));release();await Promise.all([active,watcher]);
  assert.deepEqual(calls,['active','watcher']);
});

test('compiler endpoint descriptors reject legacy or malformed transports without connecting',()=>{
  for(const descriptor of [{port:1234,token:'a'.repeat(43)},{version:2,port:0,token:'a'.repeat(43)},{version:2,port:1234,token:'bad'}])assert.throws(()=>deferredCompiler(JSON.stringify(descriptor),{root:'unused',home:'unused'}),/Invalid private compiler endpoint/);
});
