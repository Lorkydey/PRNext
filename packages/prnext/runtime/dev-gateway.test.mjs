import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DevGateway} from './dev-gateway.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,onEnsure){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.exitCode=null;
  let killed=0;const failures=[],replies=[];
  child.kill=()=>{killed++;if(child.exitCode===null){child.exitCode=0;child.emit('exit',0);child.emit('close',0);}};
  child.stdin.once('finish',()=>child.kill());
  const gateway=new DevGateway('unused','unused',{hostname:'127.0.0.1',port:0,onEnsure,onOpen(){},onClose(){},onFatal:error=>failures.push(error)},{spawnChild:()=>child});
  const emit=message=>child.stdout.write(JSON.stringify(message)+'\n');
  emit({type:'ready',port:1});
  t.after(()=>gateway.close());
  return {gateway,emit,replies,failures,get killed(){return killed;},reply(){gateway.request=async(command,value)=>replies.push({command,...value});}};
}

test('gateway cancels identities before invoking ensure and drops expired arrivals',async t=>{
  const calls=[],f=fixture(t,(...args)=>calls.push(args));f.reply();
  const deadlineMs=Date.now()+120000;
  f.emit({type:'ensure',id:1,path:'/cold',deadlineMs});f.emit({type:'ensure-cancel',id:1});
  f.emit({type:'ensure',id:2,path:'/expired',deadlineMs:Date.now()-1});
  await flush();assert.deepEqual(calls,[]);assert.deepEqual(f.replies,[]);assert.equal(f.gateway.ensures.size,0);
});

test('gateway deadline cancels queued admission and never publishes a late shared result',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let admission,finish;const task=new Promise(resolve=>finish=resolve);
  const f=fixture(t,(path,client,value)=>{admission=value;return task;});f.reply();
  f.emit({type:'ensure',id:1,path:'/cold',deadlineMs:Date.now()+20});await flush();
  assert.equal(admission.signal.aborted,false);t.mock.timers.tick(20);
  assert.equal(admission.signal.aborted,true);assert.equal(f.gateway.ensures.size,0);
  finish({buildId:'shared'});await flush();assert.deepEqual(f.replies,[]);assert.deepEqual(f.failures,[]);
});

test('future clock skew is clamped; shutdown cancels admission without cancelling its shared build',async t=>{
  let admission,finish;const task=new Promise(resolve=>finish=resolve),f=fixture(t,(path,client,value)=>{admission=value;return task;});f.reply();
  const before=Date.now();f.emit({type:'ensure',id:1,path:'/cold',deadlineMs:before+180000});await flush();
  assert.equal(f.killed,0);assert.ok(admission.deadlineMs<=Date.now()+120000);
  await f.gateway.close();assert.equal(admission.signal.aborted,true);
  finish({buildId:'shared'});await flush();assert.deepEqual(f.replies,[]);
});

test('gateway retains the native 64-request admission and outbound frame budgets',async t=>{
  const f=fixture(t,()=>new Promise(()=>{}));await f.gateway.ready;
  await assert.rejects(f.gateway.request('graph',{value:'x'.repeat(65536)}),/64 KiB/);
  const deadlineMs=Date.now()+120000;
  for(let id=0;id<64;id++)f.emit({type:'ensure',id,path:'/cold',deadlineMs});
  assert.equal(f.gateway.ensures.size,64);
  f.emit({type:'ensure',id:64,path:'/cold',deadlineMs});
  assert.equal(f.killed,1);assert.equal(f.gateway.ensures.size,0);
});
