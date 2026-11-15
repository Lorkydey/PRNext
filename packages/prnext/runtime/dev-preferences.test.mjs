import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevPreferences,normalizeDevPreferences} from './dev-preferences.mjs';
import {pngGeometry} from './dev-preview-export.mjs';

test('preferences persist only supported UI settings and return independent snapshots',()=>{
  const values=new Map(),view={localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)}};
  const store=createDevPreferences(view);
  store.update({console:{level:'warn',source:'browser',bounds:{x:20,y:40,width:500,height:300},query:'secret',logs:['secret']},preview:{device:'duo',rotated:true,folded:true,frameEnabled:false,customWidth:500,url:'secret'}});
  const expected={version:1,console:{level:'warn',source:'browser',bounds:{x:20,y:40,width:500,height:300}},preview:{device:'duo',rotated:true,folded:true,frameEnabled:false}};
  assert.deepEqual(createDevPreferences(view).snapshot(),expected);
  assert.ok(![...values.values()][0].includes('secret'));
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
