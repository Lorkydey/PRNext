import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevPreferences,normalizeDevPreferences} from './dev-preferences.mjs';
import {pngGeometry} from './dev-preview-export.mjs';

test('preferences persist only supported UI settings and return independent snapshots',()=>{
  const values=new Map(),view={localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}};
  const store=createDevPreferences(view);
  store.update({console:{level:'warn',source:'browser',bounds:{x:20,y:40,width:500,height:300},query:'secret',logs:['secret']},preview:{device:'duo',rotated:true,folded:true,frameEnabled:false,customWidth:500,url:'secret'}});
  const expected={version:1,console:{level:'warn',source:'browser',bounds:{x:20,y:40,width:500,height:300}},preview:{device:'duo',rotated:true,folded:true,frameEnabled:false}};
  assert.deepEqual(createDevPreferences(view).snapshot(),expected);
  assert.ok([...values.values()].every(value=>!value.includes('secret')));
  const copy=store.snapshot();copy.console.bounds.x=900;assert.deepEqual(store.snapshot(),expected);
  store.update({console:{level:'error'}});assert.equal(store.snapshot().console.source,'browser');
});

test('corrupt, obsolete and oversized preferences fall back to usable defaults',()=>{
  for(const raw of ['{','null','[]','{"version":2,"preview":{"device":"phone"}}',' '.repeat(5000)])assert.deepEqual(createDevPreferences({localStorage:{getItem:()=>raw}}).snapshot(),{version:1});
  assert.deepEqual(normalizeDevPreferences({version:1,console:{level:'fatal',bounds:{x:NaN,y:0,width:400,height:300}},preview:{device:'custom'}}),{version:1});
  assert.deepEqual(normalizeDevPreferences({version:1,preview:{device:'phone',rotated:'yes',customWidth:Infinity}}),{version:1,preview:{device:'phone'}});
});

test('blocked storage still remembers settings for this session',()=>{
  const view={get localStorage(){throw Error('blocked');}},store=createDevPreferences(view);
  assert.doesNotThrow(()=>store.update({preview:{device:'phone',customWidth:450}}));
  assert.equal(store.snapshot().preview.customWidth,450);
  const denied=createDevPreferences({localStorage:{getItem:()=>null,setItem:()=>{throw Error('quota');}}});
  denied.update({console:{level:'debug'}});assert.equal(denied.snapshot().console.level,'debug');
});

test('PNG geometry uses actual CSS pixels and bounds memory allocation',()=>{
  assert.deepEqual(pngGeometry({width:390,height:844,frameEnabled:true,inset:[12,12,12,12]}),{width:414,height:868,left:12,top:12,inset:[12,12,12,12]});
  assert.equal(pngGeometry({width:390,height:844,frameEnabled:false}).width,390);
  for(const [width,height] of [[0,10],[8193,10],[8000,8000],[NaN,20]])assert.throws(()=>pngGeometry({width,height,frameEnabled:false}));
});

function storageView(initial=[]){const values=new Map(initial),events=new EventTarget();return {values,view:{localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)},fire(key){const event=new Event('storage');Object.defineProperty(event,'key',{value:key});events.dispatchEvent(event);}};}

test('stale stores preserve independent changes in other tabs and fields',()=>{
  const {view}=storageView(),a=createDevPreferences(view),b=createDevPreferences(view);
  a.update({preview:{device:'phone',rotated:true}});b.update({console:{level:'warn'}});a.update({console:{source:'browser'}});b.update({preview:{frameEnabled:false}});
  assert.deepEqual(createDevPreferences(view).snapshot(),{version:1,console:{level:'warn',source:'browser'},preview:{device:'phone',rotated:true,frameEnabled:false}});
});

test('legacy preferences migrate once; reset affects tool preferences only',()=>{
  const legacy={version:1,console:{level:'error'},preview:{device:'duo',folded:true}},fixture=storageView([['prnext:dev-tools:v1',JSON.stringify(legacy)],['application-draft','keep me']]);
  const store=createDevPreferences(fixture.view);assert.deepEqual(store.snapshot(),legacy);
  const notifications=[];store.subscribe((value,meta)=>notifications.push({value,meta}));store.reset();
  assert.deepEqual(store.snapshot(),{version:1});assert.deepEqual(createDevPreferences(fixture.view).snapshot(),{version:1});assert.equal(fixture.values.get('application-draft'),'keep me');assert.ok(!fixture.values.has('prnext:dev-tools:v1'));assert.equal(notifications.at(-1).meta.reset,true);
});

test('storage changes notify subscribers without writing back and disposal removes listeners',()=>{
  const fixture=storageView(),store=createDevPreferences(fixture.view),received=[];store.subscribe(value=>received.push(value));
  fixture.values.set('prnext:dev-tools:v2:console:level','"warn"');fixture.fire('prnext:dev-tools:v2:console:level');assert.equal(received.at(-1).console.level,'warn');
  fixture.values.set('prnext:dev-tools:v2:console:level','"error"');store.dispose();fixture.fire('prnext:dev-tools:v2:console:level');assert.equal(received.length,1);
});
