import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateReplay,replayPath,exportReplay,replayOnScreen} from './dev-replay-model.mjs';

const scenario=()=>({version:1,name:'Add to basket',viewport:{width:390,height:844},steps:[{type:'visit',path:'/products/1'},{type:'click',target:{kind:'role',role:'button',name:'Add'}},{type:'expectText',target:{kind:'testId',value:'count'},text:'1'}]});
test('replay validation keeps a strict portable format and requires a real expectation',()=>{
  const value=scenario(),normalized=validateReplay(value);assert.deepEqual(normalized,value);assert.notEqual(normalized.steps,value.steps);
  for(const change of [item=>item.steps.pop(),item=>item.steps[0].type='click',item=>item.version=2,item=>item.viewport.width=100,item=>item.shell='echo nope',item=>item.steps[1].target.exact=false]){
    const invalid=scenario();change(invalid);assert.throws(()=>validateReplay(invalid));
  }
  const tooMany=scenario();tooMany.steps.push(...Array.from({length:50},()=>({type:'expectURL',path:'/'})));assert.throws(()=>validateReplay(tooMany),/steps/);
});
test('fill recordings accept fixture names and reject embedded input values',()=>{
  const value=scenario();value.steps.splice(1,0,{type:'fill',target:{kind:'label',value:'Email'},parameter:'email'});assert.equal(validateReplay(value).steps[1].parameter,'email');
  value.steps[1].value='private@example.test';assert.throws(()=>validateReplay(value),/Unknown step field/);delete value.steps[1].value;
  value.steps[1].parameter='process.env.SECRET';assert.throws(()=>validateReplay(value),/Fixture/);
});
test('navigation rejects remote, internal, query and encoded escape paths',()=>{
  for(const value of ['https://example.test','//example.test','/a\\b','/a?token=secret','/a#secret','/x/%2f/example.test','/_prnext/dev','/a/../_prnext/dev','/x\0y'])assert.throws(()=>replayPath(value),value);
  assert.equal(replayPath('/products/../basket'),'/basket');
});
test('export has exact locators, isolated networking and safe fixture names',async t=>{
  const value=scenario();value.name='Quotes " and ${process.exit()}';value.steps.splice(1,0,...['class','page','errors','target1'].map(parameter=>({type:'fill',target:{kind:'label',value:'Name'},parameter})));
  const code=exportReplay(value);assert.match(code,/getByRole\("button", \{ name: "Add", exact: true \}\)/);assert.match(code,/routeWebSocket/);assert.match(code,/toHaveCount\(1\)/);assert.match(code,/PRNEXT_REPLAY_class/);assert.doesNotMatch(code,/const class\b|const page\b|const errors = process/);
  const root=await mkdtemp(path.join(tmpdir(),'prnext-export-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'replay.spec.mjs');await writeFile(file,code);execFileSync(process.execPath,['--check',file]);
});
test('visible expectation rejects offscreen, covered and transparent targets without scrolling',()=>{
  let hit,rectangle={left:10,top:10,right:110,bottom:60,width:100,height:50},opacity='1';
  const document={defaultView:{innerWidth:390,innerHeight:844,getComputedStyle:()=>({display:'block',visibility:'visible',opacity})},elementFromPoint:()=>hit};
  const element={ownerDocument:document,getBoundingClientRect:()=>rectangle,parentElement:null,contains:value=>value===hit&&value?.child===true};hit=element;
  assert.equal(replayOnScreen(element),true);rectangle={...rectangle,top:900,bottom:950};assert.equal(replayOnScreen(element),false);
  rectangle={...rectangle,top:10,bottom:60};hit={overlay:true};assert.equal(replayOnScreen(element),false);hit=element;opacity='0';assert.equal(replayOnScreen(element),false);
  const value=scenario();value.steps[2]={type:'expectVisible',target:{kind:'testId',value:'cta'}};assert.match(exportReplay(value),/expect.poll\(\(\) => target2.evaluate\(onScreen\)\)/);
});
