import test from 'node:test';
import assert from 'node:assert/strict';
import {createLazyDevTool,registerDevToolLoaders} from './dev-lazy-tool.mjs';
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

test('an unopened tool uses current generation imports while open tool state survives loader updates',async()=>{
  const target={},loaded=[],calls=[];let disposed=0;
  const retainedState={value:'draft text',focused:true};
  const first={open(){calls.push(retainedState);},dispose(){disposed++;}};
  const load=registerDevToolLoaders({inspector:async()=>{loaded.push(0);return first;}},target);
  const opened=createLazyDevTool(()=>load('inspector'));
  const unopened=createLazyDevTool(()=>load('inspector'));
  opened.open();await tick();
  for(let generation=1;generation<=4;generation++)registerDevToolLoaders({inspector:async()=>{loaded.push(generation);return{open(){calls.push(generation);},dispose(){}};}},target);
  unopened.open();await tick();
  opened.open();
  assert.deepEqual(loaded,[0,4]);assert.deepEqual(calls,[retainedState,4,retainedState]);
  assert.equal(calls[2],retainedState);assert.equal(retainedState.focused,true);assert.equal(disposed,0);
  opened.dispose();unopened.dispose();assert.equal(disposed,1);
});

test('a failed lazy import can retry the newest published loader without leaking its popup',async()=>{
  const target={},errors=[];let closed=0,opened=0;
  const load=registerDevToolLoaders({workbench:async()=>{throw Error('Retired chunk');}},target);
  const tool=createLazyDevTool(()=>load('workbench'),{reserve:()=>({close(){closed++;}}),onError:error=>errors.push(error.message)});
  tool.popConsole();await tick();
  registerDevToolLoaders({workbench:async()=>({popConsole(){opened++;},dispose(){}})},target);
  tool.popConsole();await tick();
  assert.equal(closed,1);assert.equal(opened,1);assert.deepEqual(errors,['Retired chunk']);tool.dispose();
});
