import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeBuild, parseAnalysisArgs } from './analyze.mjs';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
const report=(buildId,jsBytes,gzipBytes,brotliBytes)=>({version:1,buildId,totalJsBytes:jsBytes,routes:[{route:'/',files:['index.js'],jsBytes,gzipBytes,brotliBytes}],files:[{file:'index.js',bytes:jsBytes,gzipBytes,brotliBytes,imports:[],modules:[{file:'src/index.ts',bytes:jsBytes}]}]});
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'prnext-analysis-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'.prnext'));await writeFile(path.join(root,'.prnext/build-analysis.json'),JSON.stringify(report('current',2000,1200,600)));return root;}

test('analysis compares explicit baseline with selected metric and per-route overrides',async t=>{
  const root=await fixture(t);await writeFile(path.join(root,'baseline.json'),JSON.stringify(report('base',1000,1000,600)));
  await writeFile(path.join(root,'budgets.json'),JSON.stringify({'/':{maxJs:1.3,maxIncreaseBytes:201,maxIncreasePercent:20}}));
  const value=await analyzeBuild(root,{baseline:'baseline.json',metric:'gzip',maxJs:0,budgets:'budgets.json'});
  assert.equal(value.ok,true);assert.equal(value.baseline.buildId,'base');assert.equal(value.routes[0].selectedBytes,1200);assert.equal(value.routes[0].deltaBytes,200);assert.equal(value.routes[0].deltaPercent,20);
  assert.equal((await analyzeBuild(root,{baseline:'baseline.json',metric:'raw',maxIncreasePercent:99})).ok,false);
  assert.equal((await analyzeBuild(root,{baseline:'baseline.json',metric:'brotli',maxIncreaseBytes:0})).ok,true);
  const exceeded=await analyzeBuild(root,{maxJs:1});assert.deepEqual(exceeded.budget.exceeded,['/']);assert.equal(exceeded.metric,'raw');
});

test('analysis refuses invalid/bounded inputs and unavailable comparisons',async t=>{
  const root=await fixture(t);
  await assert.rejects(analyzeBuild(root,{maxIncreaseBytes:0}),/require.*baseline/);
  for(const args of [['--metric','unknown'],['--max-increase-bytes','0.5'],['--max-js','NaN'],['--max-js','1','--max-js','2'],['--baseline']])assert.throws(()=>parseAnalysisArgs(args));
  const invalid=report('bad',1,1,1);invalid.routes.push({...invalid.routes[0]});await writeFile(path.join(root,'invalid.json'),JSON.stringify(invalid));
  await assert.rejects(analyzeBuild(root,{baseline:'invalid.json'}),/duplicate/);
  await writeFile(path.join(root,'budgets.json'),'{"/missing":{"maxJs":1}}');await assert.rejects(analyzeBuild(root,{budgets:'budgets.json'}),/does not match/);
  await writeFile(path.join(root,'budgets.json'),'{"/":{"maxJs":-1}}');await assert.rejects(analyzeBuild(root,{budgets:'budgets.json'}),/nonnegative/);
  await writeFile(path.join(root,'large.json'),' '.repeat(16*1024*1024+1));await assert.rejects(analyzeBuild(root,{baseline:'large.json'}),/16 MiB/);
  const zero=report('zero',0,0,0);await writeFile(path.join(root,'zero.json'),JSON.stringify(zero));
  const value=await analyzeBuild(root,{baseline:'zero.json',maxIncreasePercent:100});assert.equal(value.ok,false);assert.equal(value.routes[0].deltaPercent,null);assert.match(JSON.stringify(value),/maxIncreasePercent/);
  zero.routes=[];await writeFile(path.join(root,'zero.json'),JSON.stringify(zero));assert.deepEqual((await analyzeBuild(root,{baseline:'zero.json',maxIncreaseBytes:1})).routes[0].budget.exceeded,['baseline-missing']);
});

test('analysis CLI uses deterministic success/budget/input exit codes and machine-readable failures',async t=>{
  const root=await fixture(t);assert.equal(JSON.parse((await execute(process.execPath,[cli,'analyze',root,'--json','--max-js','3'])).stdout).ok,true);
  await assert.rejects(execute(process.execPath,[cli,'analyze',root,'--json','--max-js','0']),error=>{assert.equal(error.code,1);assert.equal(JSON.parse(error.stdout).ok,false);return true;});
  await assert.rejects(execute(process.execPath,[cli,'analyze',root,'--json','--baseline','absent.json']),error=>{assert.equal(error.code,2);assert.equal(JSON.parse(error.stdout).ok,false);return true;});
});
