import test from 'node:test';
import assert from 'node:assert/strict';
import {streamSelector} from './stream-select.mjs';

test('a slow Flight read gets one listener while thousands of HTML chunks pass', async () => {
  let resolve, subscriptions=0;
  const pending=new Promise(done=>{resolve=done;});
  const then=pending.then.bind(pending);
  pending.then=(...args)=>{subscriptions++;return then(...args);};
  const select=streamSelector();
  select.watch('flight',pending);
  for(let i=0;i<10000;i++){
    select.watch('html',Promise.resolve({value:i,done:false}));
    assert.deepEqual(await select.next(),{type:'html',value:i,done:false});
  }
  assert.equal(subscriptions,1,'a stalled source must not accumulate reactions');
  resolve({done:true});assert.deepEqual(await select.next(),{type:'flight',done:true});select.close();
});

test('selection preserves settlement order and observes errors after cancellation', async () => {
  const select=streamSelector();let reject;
  select.watch('flight',new Promise((_,fail)=>{reject=fail;}));
  select.watch('html',Promise.resolve({value:'shell'}));
  assert.equal((await select.next()).value,'shell');
  const waiting=select.next();select.close();
  await assert.rejects(waiting,/closed/);
  reject(new Error('late reader failure'));
  await new Promise(resolve=>setImmediate(resolve));
});

test('reader failures propagate even while the other source never settles', async () => {
  const select=streamSelector();select.watch('flight',new Promise(()=>{}));
  const failure=new Error('broken HTML');select.watch('html',Promise.reject(failure));
  await assert.rejects(select.next(),error=>error===failure);select.close();
});
