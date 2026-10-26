import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleCapture, formatConsoleValue } from './dev-console.mjs';

function target() {
  const host = new EventTarget(), calls = [];
  host.console = Object.fromEntries(['log','info','warn','error','debug','table','trace','assert','clear'].map(method => [method,function(...args){calls.push({method,args,self:this});return 'native';}]));
  return {host,calls};
}
test('keeps native console behavior and captures formatted, bounded snapshots', async () => {
  const {host,calls} = target(), native = host.console.log;
  const capture = createConsoleCapture(host); let updates = 0; capture.subscribe(()=>updates++);
  assert.equal(host.console.log('%s %d %cvalue','count',2,'color:red'), 'native');
  host.console.assert(true,'ignored'); host.console.assert(false,'failed');
  await Promise.resolve();
  assert.equal(updates,1); assert.equal(calls[0].self,host.console);
  assert.deepEqual(capture.snapshot().entries.map(({level,text})=>({level,text})),[{level:'log',text:'count 2 value'},{level:'error',text:'Assertion failed: failed'}]);
  host.console.clear(); assert.equal(capture.snapshot().entries.length,0);
  for(let i=0;i<600;i++)host.console.log(i);
  assert.equal(capture.snapshot().entries.length,500); assert.equal(capture.snapshot().dropped,100);
  assert.equal(capture.snapshot().entries[0].text,'100');
  host.console.log('x'.repeat(100000));assert.equal(capture.snapshot().entries.at(-1).text.length,100000);
  host.console.log('y'.repeat(200000));assert.match(capture.snapshot().entries.at(-1).text,/\[Message truncated at 128000 characters\]$/);
  for(let i=0;i<30;i++)host.console.log('z'.repeat(100000));assert.ok(capture.snapshot().entries.reduce((sum,item)=>sum+item.text.length,0)<=2*1024*1024);
  capture.dispose(); assert.equal(host.console.log,native);
});
test('serializes circular values and getters safely without retaining object references', () => {
  const {host} = target(), capture = createConsoleCapture(host);
  let touched = false;
  const item = {name:'before',get secret(){touched=true;throw new Error('getter');}}; item.self=item;
  host.console.log(item); item.name='after';
  const text=capture.snapshot().entries[0].text;
  assert.match(text,/before/); assert.match(text,/\[Getter\]/); assert.match(text,/\[Circular\]/); assert.equal(touched,false);
  assert.doesNotThrow(()=>formatConsoleValue(new Proxy({}, {ownKeys(){throw Error('proxy');}})));
  const error=Error('safe message'); Object.defineProperty(error,'stack',{get(){touched=true;return 'side effect';}});
  assert.equal(formatConsoleValue(error),'safe message'); assert.equal(touched,false);
  assert.match(formatConsoleValue(new Error('native stack')),/dev-console\.test\.mjs/);
  capture.dispose();
});
test('records runtime errors/rejections without cancelling them and restores only its own wrappers', () => {
  const {host} = target(), capture=createConsoleCapture(host);
  const error = new Event('error',{cancelable:true}); error.error=Error('boom'); host.dispatchEvent(error);
  const rejected = new Event('unhandledrejection',{cancelable:true}); rejected.reason='rejected'; host.dispatchEvent(rejected);
  assert.equal(error.defaultPrevented,false); assert.equal(rejected.defaultPrevented,false);
  assert.match(capture.snapshot().entries[0].text,/boom/); assert.match(capture.snapshot().entries[1].text,/rejected/);
  const replacement=()=>{}; host.console.log=replacement; capture.dispose(); assert.equal(host.console.log,replacement);
  host.dispatchEvent(error); assert.equal(capture.snapshot().entries.length,0);
});
