import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {analyzeSource,analyzeSourceSummary,sourceAnalysisStats} from './source-analysis.mjs';

test('typed summaries retain exact read-only facts without retaining a mutable AST',()=>{
  const source=`'use client';import type {T} from 'types';import value from './value';export {value};export * from './exports';require('runtime');require(dynamic);export default()=> <button/>`;
  const full=analyzeSource(source,'summary-public.tsx'),summary=analyzeSourceSummary(source,'summary-public.tsx');
  assert.equal(Object.hasOwn(summary,'program'),false);
  assert.deepEqual(summary,Object.fromEntries(Object.entries(full).filter(([key])=>key!=='program')));
  assert.throws(()=>summary.imports[0].path='poison',TypeError);
  assert.throws(()=>summary.runtimeExports.push('poison'),TypeError);
  full.program.body.length=0;
  assert.deepEqual(summary.runtimeExports,['value','default']);
  assert.equal(analyzeSourceSummary(source,'summary-public.tsx'),summary);
  assert.notEqual(analyzeSourceSummary(source+';export const changed=1','summary-public.tsx'),summary);
  assert.throws(()=>analyzeSourceSummary('const value=<number>1','typed-summary.mts'),/reserved in files with the \.mts or \.cts extension/);
  assert.deepEqual(analyzeSourceSummary('export default()=> <main/>','jsx-summary.cjs').runtimeExports,['default']);
});

test('summary reuse survives AST eviction while both independent payload budgets stay bounded',()=>{
  const count=120,source=index=>`import value from './item-${index}';export const item${index}=value;`;
  const expected=Array.from({length:count},(_,index)=>analyzeSourceSummary(source(index),'large-graph-'+index+'.js'));
  for(let index=0;index<70;index++)analyzeSource(`export const unrelated${index}=1`,'full-only-'+index+'.js');
  const before=sourceAnalysisStats();
  for(let index=0;index<count;index++)assert.equal(analyzeSourceSummary(source(index),'large-graph-'+index+'.js'),expected[index]);
  const after=sourceAnalysisStats();
  assert.equal(after.misses,before.misses,'summary hits must not reparse evicted ASTs');
  assert.equal(after.summaries.hits-before.summaries.hits,count);
  for(let index=0;index<4200;index++)analyzeSourceSummary(`export const item${index}=1`,'bounded-summary-'+index+'.js');
  const bounded=sourceAnalysisStats();
  assert.ok(bounded.entries<=64&&bounded.bytes<=16*1024*1024);
  assert.ok(bounded.summaries.entries<=4096&&bounded.summaries.bytes<=8*1024*1024);
});

test('oversized summary facts remain accepted without being retained or repeatedly parsed',()=>{
  const source=Array.from({length:4100},(_,index)=>`import 'dependency-${index}';`).join('\n');
  const before=sourceAnalysisStats();
  const value=analyzeSourceSummary(source,'uncached-large-summary.js');
  assert.equal(value.imports.length,4100);
  assert.equal(sourceAnalysisStats().misses-before.misses,1);
});

test('fresh processes replay versioned summaries from the bounded persistent transform store',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-summary-disk-'));
  try{
    await writeFile(path.join(root,'package.json'),'{"private":true}');
    const script=`import {withPersistentTransforms,transformCacheStats} from ${JSON.stringify(new URL('./transform-cache.mjs',import.meta.url).href)};
      import {analyzeSourceSummary,sourceAnalysisStats} from ${JSON.stringify(new URL('./source-analysis.mjs',import.meta.url).href)};
      await withPersistentTransforms(${JSON.stringify(root)},{},async()=>{for(let i=0;i<100;i++)analyzeSourceSummary('export const n='+i,'disk-source-'+i+'.js')});
      console.log(JSON.stringify({analysis:sourceAnalysisStats(),transforms:transformCacheStats()}));`;
    const execute=promisify(execFile),run=async()=>JSON.parse((await execute(process.execPath,['--input-type=module','-e',script],{timeout:30000,maxBuffer:1024*1024})).stdout);
    const first=await run(),second=await run();
    assert.equal(first.analysis.misses,100);assert.ok(first.transforms.diskWrites>0);
    assert.equal(second.analysis.misses,0);assert.equal(second.analysis.summaries.replays,100);assert.equal(second.transforms.diskHits,100);
  }finally{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^prnext-summary-disk-/);
    await rm(root,{recursive:true,force:true});
  }
});
