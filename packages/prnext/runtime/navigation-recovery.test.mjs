import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {recoverNavigation} from './navigation-recovery.mjs';
import offline from '../compat/offline-store.cjs';

test('offline GET recovery waits for reconnection, exposes status and cancels stale work',async()=>{
  const events=new EventTarget();let online=false,calls=0;const controller=new AbortController();
  const work=recoverNavigation(async()=>{calls++;if(!online)throw new TypeError('Failed to fetch');return 'fresh-authenticated-result';},{signal:controller.signal,events,online:()=>online,budgetMs:1000});
  await delay(10);assert.equal(calls,1);assert.equal(offline.snapshot(),true);await delay(20);assert.equal(calls,1);
  online=true;events.dispatchEvent(new Event('online'));assert.equal(await work,'fresh-authenticated-result');assert.equal(calls,2);assert.equal(offline.snapshot(),false);assert.equal(getEventListeners(events,'online').length,0);
  online=false;const aborted=recoverNavigation(()=>{throw new TypeError('Failed to fetch');},{signal:controller.signal,events,online:()=>online,budgetMs:1000});
  await delay(10);controller.abort(new DOMException('Newer navigation','AbortError'));await assert.rejects(aborted,/Newer navigation/);assert.equal(offline.snapshot(),false);assert.equal(getEventListeners(events,'online').length,0);
});
test('application errors are never retried and unreachable GETs have a total time budget',async()=>{
  let calls=0;
  await assert.rejects(recoverNavigation(()=>{calls++;throw new TypeError('Invalid component props');},{budgetMs:1000}),/Invalid component/);assert.equal(calls,1);
  await assert.rejects(recoverNavigation(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),{budgetMs:25}),error=>error.code==='PRNEXT_NAVIGATION_NETWORK');
  assert.equal(offline.snapshot(),false);
});
