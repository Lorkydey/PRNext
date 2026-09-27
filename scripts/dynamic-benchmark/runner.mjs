import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {processTree,sample} from '../bench-next-comparison.mjs';
import {launchBackend,prepare,prepared,launch,loadChild,directory,audit,clearAudit,backendControl,exec,sourceHash,sha} from './harness.mjs';
import {parityFor,compareParity} from './parity.mjs';
import {scenarios,verifyWork} from './protocol.mjs';

const engines=['next','rustyx'];
const profiles=[{id:'fixed-250',ratePerSecond:250,concurrency:32,durationMs:6000},{id:'concurrency-32',concurrency:32,durationMs:4000}];
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)]??null;
export function eligible(scenario,parity){
  const good=id=>parity.comparisons.some(row=>row.id===id&&row.directComparable);
  return good(scenario.id)&&good('ssr-10000')&&(scenario.id!=='stream'||good('streaming-order'))&&(!scenario.cycle||good('cache-cycle-10'));
}
async function measured(engine,backend,scenario,profile,repetition,runId){
  await backendControl(backend,{reset:true});
  const server=await launch(engine,backend,`${scenario.id}-${profile.id}-${repetition}`),prefix=`${runId}-${scenario.id}-${profile.id}-${repetition}`;
  const row={engine,scenario:scenario.id,profile:profile.id,repetition,concurrency:scenario.cycle?1:profile.concurrency,valid:false};
  try{
    row.idleCold=await processTree(server.child.pid);
    const warmPrefix=scenario.id==='cache-hit'?prefix:'warm-'+prefix;
    const warmup=await loadChild({base:server.url,scenario:scenario.id,concurrency:1,requests:32,prefix:warmPrefix});
    assert.deepEqual(warmup.errors,{},'warmup responses');row.warmupRequests=warmup.requests;
    await delay(100);row.idleWarm=await processTree(server.child.pid);
    await clearAudit(engine);await backendControl(backend,{clearEvents:true});
    const before=await processTree(server.child.pid),backendBefore=await processTree(backend.child.pid),monitor=sample(server.child.pid),backendMonitor=sample(backend.child.pid);
    let after,backendAfter,samples,backendSamples;
    try{
      Object.assign(row,await loadChild({base:server.url,scenario:scenario.id,...profile,concurrency:row.concurrency,prefix}));
      after=await processTree(server.child.pid);backendAfter=await processTree(backend.child.pid);
    }finally{[samples,backendSamples]=await Promise.all([monitor.stop(),backendMonitor.stop()])}
    const events=await audit(engine),backendEvents=(await backendControl(backend)).events;
    row.work=verifyWork(scenario,events,backendEvents,row.requests,{prefix});
    assert.deepEqual(row.errors,{},'load response errors');assert.equal(row.attempts,row.requests);assert.ok(!row.reachedCap);
    const gone=before.processes.filter(p=>!after.processes.some(q=>q.pid===p.pid));assert.deepEqual(gone,[],'unaccounted worker exited');
    row.serverCpuMs=after.cpuMs-before.cpuMs;assert.ok(row.serverCpuMs>=0);
    row.cpuMsPerResponse=row.serverCpuMs/row.requests;row.cpuPercentOneCore=row.serverCpuMs*100/row.elapsedMs;
    row.loadMedianRssMiB=median(samples.map(s=>s.rssMiB));row.loadPeakRssMiB=Math.max(...samples.map(s=>s.rssMiB));row.memorySamples=samples.length;
    row.idleColdRssMiB=row.idleCold.rssMiB;row.idleWarmRssMiB=row.idleWarm.rssMiB;row.processes=after.processes;
    row.backendCallsPerSecond=backendEvents.length*1000/row.elapsedMs;row.backendCpuMs=backendAfter.cpuMs-backendBefore.cpuMs;row.backendCpuMsPerResponse=row.backendCpuMs/row.requests;
    row.backendMedianRssMiB=median(backendSamples.map(s=>s.rssMiB));row.clientCpuPercent=row.clientCpuMs*100/row.elapsedMs;
    row.executionEvidenceSha256=sha(JSON.stringify(events));row.backendEvidenceSha256=sha(JSON.stringify(backendEvents));
    row.clientLimited=row.clientCpuPercent>=85;
    if(profile.ratePerSecond){assert.ok(Math.abs(row.requestsPerSecond/profile.ratePerSecond-1)<.05,'offered rate not sustained');assert.ok(row.scheduleLagP95Ms<10,'load generator arrival schedule lag')}
    row.valid=true;
  }catch(error){row.error={name:error.name,message:error.message,stack:error.stack};row.observedExecutionCounts=(await audit(engine)).reduce((counts,e)=>(counts[e.kind]=(counts[e.kind]||0)+1,counts),{});row.observedBackendCalls=(await backendControl(backend)).events.length}
  finally{await server.close()}
  return row;
}
export async function run(){
  await mkdir(directory,{recursive:true});const backend=await launchBackend();
  try{
    const preparation=process.argv.includes('--reuse-build')?await prepared():await prepare(backend);
    if(process.argv.includes('--prepare-only'))return preparation;
    const file=path.join(directory,'results.json');let data;
    if(process.argv.includes('--resume')){
      data=JSON.parse(await readFile(file,'utf8'));assert.equal(data.preparation.sourceHash,sourceHash);assert.equal(data.preparation.binarySha256,preparation.binarySha256);assert.equal(data.preparation.harnessSha256,preparation.harnessSha256);
    }else{
      const runId=String(Date.now()),parity={runId,preparation,engines:[]};
      for(const engine of engines){parity.engines.push(await parityFor(engine,backend,runId));await writeFile(path.join(directory,'parity.json'),JSON.stringify(parity,null,2)+'\n')}
      parity.comparisons=compareParity(...parity.engines,preparation);await writeFile(path.join(directory,'parity.json'),JSON.stringify(parity,null,2)+'\n');
      data={schema:1,status:'running',startedAt:new Date().toISOString(),runId,preparation,machine:{cpu:os.cpus()[0].model,cores:os.cpus().length,ramGiB:os.totalmem()/1024**3,os:os.platform(),release:os.release(),arch:os.arch(),node:process.version},gitCommit:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),parity,profiles,repetitions:3,runs:[],excluded:scenarios.filter(s=>!eligible(s,parity)).map(s=>s.id)};
    }
    const save=()=>writeFile(file,JSON.stringify(data,null,2)+'\n');await save();
    if(process.argv.includes('--parity-only')){data.status='parity-complete';await save();return data}
    data.status='running';await save();
    for(const scenario of scenarios){
      if(!eligible(scenario,data.parity)){console.log('EXCLUDED',scenario.id);continue}
      for(const profile of profiles)for(let repetition=1;repetition<=3;repetition++)for(const engine of repetition%2?engines:[...engines].reverse()){
        if(data.runs.some(r=>r.engine===engine&&r.scenario===scenario.id&&r.profile===profile.id&&r.repetition===repetition))continue;
        console.log('LOAD',engine,scenario.id,profile.id,repetition);
        const row=await measured(engine,backend,scenario,profile,repetition,data.runId);data.runs.push(row);await save();
        console.log('RESULT',row.valid?'VALID':'INVALID',Math.round(row.requestsPerSecond||0),'req/s',row.cpuMsPerResponse?.toFixed(3),'CPU ms/response',row.loadMedianRssMiB?.toFixed(1),'MiB',row.error?.message.slice(0,300)||'');
      }
    }
    data.status='complete';data.finishedAt=new Date().toISOString();data.invalidRuns=data.runs.filter(r=>!r.valid).length;await save();if(data.invalidRuns||!data.runs.length)process.exitCode=1;return data;
  }finally{await backend.close()}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
