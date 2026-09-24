import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {directory,harnessHash} from './harness.mjs';
import {scenarios,eventCounts} from './protocol.mjs';
import {compareParity} from './parity.mjs';
import {eligible} from './runner.mjs';

const data=JSON.parse(await readFile(path.join(directory,'results.json'),'utf8'));
assert.equal(data.status,'complete');
assert.equal(data.preparation.harnessSha256,await harnessHash(),'harness changed after measurements');
assert.deepEqual(compareParity(...data.parity.engines,data.preparation),data.parity.comparisons);
const selected=scenarios.filter(s=>eligible(s,data.parity));
assert.equal(data.runs.length,selected.length*data.profiles.length*data.repetitions*2);
const signatures=new Set();
for(const row of data.runs){
  const signature=[row.scenario,row.profile,row.repetition,row.engine].join('/');assert.ok(!signatures.has(signature));signatures.add(signature);
  assert.equal(row.valid,true,signature+' invalid');assert.deepEqual(row.errors,{});assert.ok(row.requests>0);assert.equal(row.requests,row.attempts);
  assert.ok(row.p50Ms<=row.p95Ms&&row.p95Ms<=row.p99Ms);assert.ok(row.ttfbP95Ms<=row.p95Ms);
  assert.ok(row.memorySamples>0&&row.loadPeakRssMiB>=row.loadMedianRssMiB&&row.idleWarmRssMiB>0);
  assert.ok(Math.abs(row.cpuMsPerResponse*row.requests-row.serverCpuMs)<.00001);
  assert.ok(Math.abs(row.backendCallsPerSecond*row.elapsedMs/1000-row.work.backendCalls)<.00001);
  const scenario=scenarios.find(s=>s.id===row.scenario);
  if(scenario.cycle){
    assert.equal(row.requests,row.cycles*4);assert.deepEqual(row.encodings,{gzip:row.cycles*3,identity:row.cycles});
    assert.deepEqual(row.work.counts,{'render:cache':row.cycles*3,'cache-fill':row.cycles*2,revalidate:row.cycles});assert.equal(row.work.backendCalls,row.cycles*2);
  }else{
    assert.deepEqual(row.encodings,{[row.scenario.startsWith('route-')?'identity':'gzip']:row.requests});
    assert.equal(row.work.counts[scenario.event],row.requests);assert.equal(row.work.backendCalls,row.requests*scenario.backendPerRequest);
  }
}
for(const engine of ['next','rustyx']){
  const lines=(await readFile(path.join(directory,engine+'-ssr-10000.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,10000);assert.deepEqual(eventCounts(lines),{'render:ssr':10000});assert.ok(lines.every(e=>e.input.token==='constant'));
}
const verification={checkedAt:new Date().toISOString(),runs:data.runs.length,validResponses:data.runs.reduce((n,r)=>n+r.requests,0),responseErrors:0,executionMismatches:0,encodingMismatches:0,proof:{next:10000,rustyx:10000},pairedScenarios:selected.map(s=>s.id),excludedControls:data.parity.comparisons.filter(r=>!r.directComparable).map(r=>r.id),harnessSha256:data.preparation.harnessSha256};
await writeFile(path.join(directory,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification,null,2));
