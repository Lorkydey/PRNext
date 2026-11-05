import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevelopmentQueue} from './development-queue.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('expired queued discovery is removed and settled before the active build finishes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let now=100;const queue=createDevelopmentQueue({now:()=>now}),entered=deferred(),release=deferred(),calls=[];
  const active=queue.enqueue(async()=>{entered.resolve();await release.promise;calls.push('shared build');});
  await entered.promise;
  const obsolete=queue.enqueue(()=>calls.push('obsolete discovery'),{deadlineMs:110});
  const rejected=assert.rejects(obsolete,/expired before compilation started/);
  const watcher=queue.enqueue(()=>calls.push('watcher'));
  now=110;t.mock.timers.tick(10);await rejected;
  assert.equal(queue.pending,1,'expired closure is removed while the active build is still running');
  release.resolve();await Promise.all([active,watcher,queue.idle()]);
  assert.deepEqual(calls,['shared build','watcher']);
});

test('cancelling an executing navigation keeps its shared build and independent watcher work',async()=>{
  const queue=createDevelopmentQueue(),controller=new AbortController(),entered=deferred(),release=deferred(),calls=[];
  let generation,builds=0;
  const active=queue.enqueue(async()=>{builds++;entered.resolve();await release.promise;generation='ready';return generation;},{signal:controller.signal});
  await entered.promise;
  const queuedController=new AbortController();
  const obsolete=queue.enqueue(()=>{throw Error('Cancelled queued work started');},{signal:queuedController.signal});
  const rejected=assert.rejects(obsolete,/expired/);queuedController.abort();await rejected;
  const shared=queue.enqueue(()=>generation),watcher=queue.enqueue(()=>calls.push('watcher'));
  controller.abort();release.resolve();
  assert.equal(await active,'ready');assert.equal(await shared,'ready');await watcher;
  assert.equal(builds,1);assert.deepEqual(calls,['watcher']);assert.equal(queue.pending,0);
});

test('same-turn cancellation, start-time deadlines and session shutdown cannot start queued work',async()=>{
  let now=10,stopping=false;const queue=createDevelopmentQueue({now:()=>now,isStopping:()=>stopping});
  const controller=new AbortController(),cancelled=queue.enqueue(()=>assert.fail('cancelled work ran'),{signal:controller.signal});
  controller.abort();await assert.rejects(cancelled,/expired/);
  const stale=queue.enqueue(()=>assert.fail('expired work ran'),{deadlineMs:20});now=20;
  await assert.rejects(stale,/expired/);
  stopping=true;await assert.rejects(queue.enqueue(()=>assert.fail('stopped work ran')),/stopping/);
  await queue.idle();assert.equal(queue.pending,0);
});
