import test from 'node:test';
import assert from 'node:assert/strict';
import {mapConcurrent} from './concurrent.mjs';
import {createCompilerHealth} from './dev-compiler-health.mjs';
test('bounded prerender work overlaps, preserves order and settles before rejecting',async()=>{
  let release,started=0;const gate=new Promise(resolve=>release=resolve),seen=[];
  const run=mapConcurrent([0,1,2,3],async value=>{started++;await gate;seen.push(value);return value*2;},2);
  assert.equal(started,2);release();assert.deepEqual(await run,[0,2,4,6]);assert.equal(seen.length,4);
  let settle,drained=false;const pending=new Promise(resolve=>settle=resolve);
  const failed=mapConcurrent([0,1,2],async value=>{if(!value)throw Error('render failed');await pending;drained=true;},2);
  await Promise.resolve();assert.equal(drained,false);settle();await assert.rejects(failed,/render failed/);assert.equal(drained,true);
  let reached=false;const primitive=mapConcurrent([0,1],()=>{reached=true;throw undefined;},1);await assert.rejects(primitive,()=>true);assert.equal(reached,true);
});
test('compiler retains healthy graphs across many edits and recycles under pressure',()=>{
  const stable=createCompilerHealth();for(let i=0;i<100;i++)assert.equal(stable({rss:200*1024*1024,heapUsed:60*1024*1024}).recycle,false);
  assert.equal(stable({rss:800*1024*1024,heapUsed:60*1024*1024}).reason,'rss-limit');
  const growth=createCompilerHealth();for(let i=0;i<8;i++)growth({rss:200*1024*1024,heapUsed:60*1024*1024});
  assert.equal(growth({rss:350*1024*1024,heapUsed:60*1024*1024}).reason,'sustained-growth');
});
