// Streaming admission comparison. Reuse the dynamic parity fixture and client;
// keep the previous runtime-resources report and its frozen binaries untouched.
import {spawn} from 'node:child_process';
import {cp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {sha} from './dynamic-benchmark/harness.mjs';
import {compareParity} from './dynamic-benchmark/parity.mjs';
import {eligible} from './dynamic-benchmark/runner.mjs';
import {scenarios} from './dynamic-benchmark/protocol.mjs';
import {binary} from '../tests/support.mjs';

const output=path.resolve(process.env.RESOURCE_BENCH_OUTPUT||'reports/stream-optimization');
const variants=[
  {name:'baseline',engine:'baseline'},
  {name:'baseline-compact',engine:'baseline',env:{PRNEXT_MEMORY_PROFILE:'compact'}},
  {name:'candidate',engine:'candidate'},
  {name:'compact',engine:'candidate',env:{PRNEXT_MEMORY_PROFILE:'compact'}},
  {name:'next',engine:'next'},
];
async function execute(script,args=[],env={}){
  const child=spawn(process.execPath,[script,...args],{stdio:'inherit',env:{...process.env,RESOURCE_BENCH_OUTPUT:output,...env}});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0,script+' failed');
}
async function fingerprint(root){
  const rows=[];
  async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())rows.push([path.relative(root,file),sha(await readFile(file))]);}}
  await walk(path.join(root,'.prnext'));return sha(JSON.stringify(rows));
}
const mode=process.argv[2]||'run';
if(mode==='snapshot'){
  // Run BEFORE editing the runtime, with an up-to-date release binary.
  await execute('scripts/bench-runtime-resources.mjs',['snapshot']);
  await execute('scripts/bench-runtime-resources.mjs',['build']);
  const before=path.join(output,'projects/baseline');
  await rm(before,{recursive:true,force:true});
  await cp(path.join(output,'projects/candidate'),before,{recursive:true,verbatimSymlinks:true});
  const metadata=JSON.parse(await readFile(path.join(output,'baseline.json'),'utf8'));
  metadata.runtimeSha256=await fingerprint(before);
  await writeFile(path.join(output,'baseline.json'),JSON.stringify(metadata,null,2)+'\n');
}else if(mode==='build'){
  await execute('scripts/bench-runtime-resources.mjs',['build']);
}else if(mode==='validate'){
  for(const variant of variants)await execute('scripts/validate-runtime-resources.mjs',[variant.name]);
}else{
  assert.equal(mode,'run');
  const selected=scenarios.filter(s=>['stream','ssr','data'].includes(s.id));
  const next=JSON.parse(await readFile(path.join(output,'parity-next/results.json'),'utf8'));
  assert.equal(next.result.checks.length,21);assert.ok(next.result.checks.every(c=>c.pass));
  const evidence={};
  for(const variant of variants.filter(v=>v.engine!=='next')){
    const folder=path.join(output,'parity-'+variant.name),root=path.join(output,'projects',variant.engine);
    const parity=JSON.parse(await readFile(path.join(folder,'results.json'),'utf8'));
    assert.equal(parity.result.checks.length,21);assert.ok(parity.result.checks.every(c=>c.pass));
    assert.deepEqual(parity.environmentOverrides,variant.env||{});
    assert.equal(await fingerprint(path.join(folder,'projects/rustyx')),await fingerprint(root));
    const comparisons=compareParity(next.result,parity.result,{builds:[{unexpectedPrerender:[]}]});
    for(const scenario of selected)assert.ok(eligible(scenario,{comparisons}),variant.name+': '+scenario.id);
    evidence[variant.name]={sha256:sha(JSON.stringify(parity)),comparisons};
  }
  const baseline=JSON.parse(await readFile(path.join(output,'baseline.json'),'utf8'));
  assert.equal(sha(await readFile(path.join(output,'projects/baseline-binary/rustyx'))),baseline.binarySha256);
  const sourceFiles=['scripts/bench-stream-optimization.mjs','scripts/bench-runtime-resources.mjs','scripts/bench-next-comparison.mjs','scripts/dynamic-benchmark/harness.mjs','scripts/dynamic-benchmark/protocol.mjs','scripts/dynamic-benchmark/load.mjs','scripts/dynamic-benchmark/backend.mjs','scripts/dynamic-benchmark/fixture.mjs','scripts/dynamic-benchmark/parity.mjs','scripts/dynamic-benchmark/runner.mjs'];
  const sources=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,sha(await readFile(file))])));
  await writeFile(path.join(output,'method.json'),JSON.stringify({createdAt:new Date().toISOString(),machine:{cpu:os.cpus()[0].model,cores:os.cpus().length,ramGiB:os.totalmem()/1024**3,os:os.platform(),arch:os.arch(),node:process.version},binarySha256:sha(await readFile(binary)),sources,evidence},null,2)+'\n');
  await execute('scripts/bench-runtime-resources.mjs',[],{
    RESOURCE_REQUIRE_PARITY:'1',RESOURCE_SCENARIOS:'ssr,data,stream',RESOURCE_REPETITIONS:'3',
    RESOURCE_RESULT:'final-results.json',RESOURCE_PROFILE:'',RESOURCE_VARIANTS:JSON.stringify(variants),
  });
}
