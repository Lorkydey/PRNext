import test from 'node:test';
import assert from 'node:assert/strict';
import {createLazyDevTool} from './dev-lazy-tool.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('tools load on use, reserve popups synchronously and close them on failure',async()=>{
  let loads=0,release,closed=0,used;
  const gate=new Promise(resolve=>release=resolve),popup={close(){closed++;}};
  const tool=createLazyDevTool(async()=>{loads++;await gate;return{popConsole(value){used=value;},dispose(){}};},{reserve:()=>popup});
  assert.equal(loads,0);tool.popConsole();assert.equal(loads,1);assert.equal(used,undefined);release();await tick();assert.equal(used,popup);
  const errors=[];const failing=createLazyDevTool(async()=>{throw Error('network failed');},{reserve:()=>popup,onError:error=>errors.push(error.message)});
  failing.popConsole();await tick();assert.equal(closed,1);assert.deepEqual(errors,['network failed']);
});
test('disposal during a delayed import cannot resurrect a panel',async()=>{
  let release,opened=false,disposed=false;const gate=new Promise(resolve=>release=resolve);
  const tool=createLazyDevTool(async()=>{await gate;return{open(){opened=true;},dispose(){disposed=true;}};});
  tool.open();tool.dispose();release();await tick();assert.equal(opened,false);assert.equal(disposed,true);
});
