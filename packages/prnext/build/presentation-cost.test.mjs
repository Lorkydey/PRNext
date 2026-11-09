import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationCost} from './presentation-cost.mjs';
import {analyzePresentation} from './presentation.mjs';

test('cost admission charges template transfer and grows row thresholds for expensive templates',()=>{
  const base={elements:2,maps:1,slots:1,repeatedElements:1,repeatedAttributeBytes:5};
  const small=presentationCost({...base,client:'export default()=>null'});
  const large=presentationCost({...base,client:Array.from({length:1500},(_,i)=>'public-'+(i*1234567).toString(36)).join(';')});
  assert.equal(small.minArrayEntries,32);assert.ok(large.minArrayEntries>small.minArrayEntries);
  assert.ok(large.templateGzipBytes>small.templateGzipBytes);assert.equal(large.decision,'compact');
});

test('scalar-only arrays stay ordinary; large static surroundings can make the same rows economical',()=>{
  const source='export default({rows})=><div>{rows.map(row=>row.name)}</div>';
  const ordinary=analyzePresentation(source,'Rows.jsx',{automatic:true});assert.equal(ordinary.eligible,false);assert.match(ordinary.reason,/cost/i);
  const surrounded=analyzePresentation(source.replace('<div>','<div>'+('<span>Public literal</span>'.repeat(70))),'Rows.jsx',{automatic:true});
  assert.equal(surrounded.eligible,true,surrounded.reason);assert.equal(surrounded.minArrayEntries,32);
});
