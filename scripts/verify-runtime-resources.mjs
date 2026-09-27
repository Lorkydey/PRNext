import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {scenarios} from './dynamic-benchmark/protocol.mjs';
import {binary} from '../tests/support.mjs';
const output=path.resolve(process.env.RESOURCE_BENCH_OUTPUT||'reports/runtime-resources');
const hash=value=>createHash('sha256').update(value).digest('hex');
const data=JSON.parse(await readFile(path.join(output,'final-results.json'),'utf8'));
assert.equal(data.valid,true);assert.equal(data.runs.length,144);assert.equal(data.repetitions,3);
const signatures=new Set();
for(const row of data.runs){
  const signature=[row.variant,row.scenario,row.profile,row.repetition].join('/');assert.ok(!signatures.has(signature));signatures.add(signature);
  assert.equal(row.valid,true);assert.deepEqual(row.errors,{});assert.ok(row.requests>0);assert.equal(row.attempts,row.requests);
  assert.ok(row.p50Ms<=row.p95Ms&&row.p95Ms<=row.p99Ms);assert.ok(row.ttfbP95Ms<=row.p95Ms);
  assert.ok(row.loadPeakRssMiB>=row.loadMedianRssMiB&&row.idleWarm.rssMiB>0);
  assert.ok(Math.abs(row.cpuPercentOneCore-row.cpuMsPerResponse*row.requestsPerSecond/10)<1e-8);
  const scenario=scenarios.find(s=>s.id===row.scenario);assert.ok(scenario);
  assert.deepEqual(row.encodings,{[row.scenario==='route-get'?'identity':'gzip']:row.requests});
  assert.equal(row.work.counts[scenario.event],row.requests);assert.equal(row.work.backendCalls,row.requests*scenario.backendPerRequest);
  if(row.profile==='fixed-250'){assert.ok(Math.abs(row.requestsPerSecond/250-1)<.05);assert.ok(row.scheduleLagP95Ms<10);}
}
for(const variant of ['next','baseline','candidate','compact']){
  const folder=path.join(output,'parity-'+variant),engine=variant==='next'?'next':'rustyx';
  const parity=JSON.parse(await readFile(path.join(folder,'results.json'),'utf8'));
  assert.equal(parity.result.checks.length,21);assert.ok(parity.result.checks.every(c=>c.pass));
  const lines=(await readFile(path.join(folder,engine+'-ssr-10000.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,10000);assert.ok(lines.every(e=>e.kind==='render:ssr'&&e.input.token==='constant'));
}
async function fingerprint(root){
  const rows=[];
  async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())rows.push([path.relative(root,file),hash(await readFile(file))]);}}
  await walk(path.join(root,'.prnext'));return hash(JSON.stringify(rows));
}
assert.equal(await fingerprint(path.join(output,'projects/candidate')),data.candidateSha256);
assert.equal(await fingerprint(path.join(output,'projects/baseline')),data.baseline.runtimeSha256);
assert.equal(hash(await readFile(binary)),data.binarySha256);
assert.equal(hash(await readFile(path.join(output,'projects/baseline-binary/rustyx'))),data.baseline.binarySha256);
const sourceFiles=['scripts/bench-runtime-resources.mjs','scripts/bench-next-comparison.mjs','scripts/dynamic-benchmark/harness.mjs','scripts/dynamic-benchmark/protocol.mjs','scripts/dynamic-benchmark/load.mjs','scripts/dynamic-benchmark/backend.mjs','scripts/dynamic-benchmark/fixture.mjs','scripts/dynamic-benchmark/parity.mjs','scripts/dynamic-benchmark/runner.mjs'];
const sources={};for(const file of sourceFiles){const info=await stat(file);assert.ok(info.mtimeMs<=Date.parse(data.createdAt),file+' changed during or after measurement');sources[file]=hash(await readFile(file));}
const require=createRequire(path.join(output,'projects/next/package.json'));
const versions=Object.fromEntries(['next','react','react-dom','react-server-dom-webpack'].map(name=>[name,require(name+'/package.json').version]));
const verification={checkedAt:new Date().toISOString(),runs:144,responses:data.runs.reduce((n,r)=>n+r.requests,0),errors:0,parityChecks:84,ssrProofPerVariant:10000,versions,sources,candidateSha256:data.candidateSha256,binarySha256:data.binarySha256};
await writeFile(path.join(output,'verification.json'),JSON.stringify(verification,null,2)+'\n');console.log(JSON.stringify(verification,null,2));
