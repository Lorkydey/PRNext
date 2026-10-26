import test from 'node:test';
import assert from 'node:assert/strict';
import {compactDependencyGraph,publishDependencyGraph,affectedDependencies,canSkipUnopenedRoutes} from './dev-dependency-graph.mjs';

test('large dependency graphs are compacted into bounded atomic control frames',async()=>{
  const files=Array.from({length:9000},(_,i)=>`components/deep/component-${i}.tsx`);
  const manifest={buildId:'graph-test',devDependencies:[{route:'/wide',files},{route:'/other',files}],devModules:files.map((file,i)=>({route:file,module:true,files:[file,...i?[files[i-1]]:[]]}))};
  const graph=compactDependencyGraph(manifest);assert.equal(graph.files.length,9000);assert.equal(graph.edges,35999);
  const calls=[];const gateway={async request(command,values){calls.push({command,...values});assert.ok(Buffer.byteLength(JSON.stringify({id:1,command,...values}))<65536);return true;}};
  await publishDependencyGraph(gateway,manifest);
  assert.equal(calls[0].command,'graph-begin');assert.equal(calls.at(-1).command,'graph-commit');
  assert.ok(calls.filter(call=>call.command==='graph-files').length>2);
  assert.ok(calls.filter(call=>call.command==='graph-records').length>2);
  const chunks=calls.filter(call=>call.command==='graph-records').flatMap(call=>call.records).filter(record=>record.route==='/wide');
  assert.equal(chunks.flatMap(chunk=>chunk.files).length,9000);
});
test('failed publication aborts without committing, and explicit saturation is reported',async()=>{
  const calls=[];await assert.rejects(publishDependencyGraph({async request(command){calls.push(command);if(command==='graph-records')throw Error('Rejected graph');}}, {buildId:'failure',devDependencies:[{route:'/',files:['a.ts']}]}),/Rejected/);
  assert.equal(calls.at(-1),'graph-abort');assert.ok(!calls.includes('graph-commit'));
  assert.throws(()=>compactDependencyGraph({devDependencyStatus:{complete:false,reason:'Capacity exhausted'}}),/Capacity exhausted/);
});
test('an unavailable index never treats an imported dormant page as safe to skip',()=>{
  const files=['pages/unused.jsx'],dormant=new Set(files),result={unknown:files,complete:true};
  assert.equal(canSkipUnopenedRoutes(result,files,dormant,true),true);
  assert.equal(canSkipUnopenedRoutes(result,files,dormant,false),false);
  assert.equal(canSkipUnopenedRoutes({...result,complete:false},files,dormant,true),false);
});
test('affected lookups batch long filenames and respect native saturation',async()=>{
  const files=Array.from({length:750},(_,i)=>`components/${'x'.repeat(1900)}-${i}.ts`);let requests=0;
  const found=await affectedDependencies({async request(command,value){assert.equal(command,'affected');assert.equal(value.transitive,true);assert.ok(value.files.length<=512);assert.ok(Buffer.byteLength(JSON.stringify(value))<65536);requests++;return {routes:['/'],modules:['shared.ts'],unknown:[],complete:requests!==2};}},files);
  assert.ok(requests>20);assert.equal(found.complete,false);assert.deepEqual(found.modules,[]);
});
