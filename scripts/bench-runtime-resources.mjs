// Compare a frozen production runtime with a rebuilt candidate on the dynamic
// parity fixture. Each response and each server/backend execution is checked.
import {spawn} from 'node:child_process';
import {cp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {freePort,repositoryRoot,binary} from '../tests/support.mjs';
import {processTree,sample} from './bench-next-comparison.mjs';
import {launchBackend,backendControl,loadChild,exec,sha} from './dynamic-benchmark/harness.mjs';
import {scenarios,verifyWork} from './dynamic-benchmark/protocol.mjs';
import {files,dynamicRoutes} from './dynamic-benchmark/fixture.mjs';
import {compareParity} from './dynamic-benchmark/parity.mjs';
import {eligible} from './dynamic-benchmark/runner.mjs';

const output=path.resolve(process.env.RESOURCE_BENCH_OUTPUT||'reports/runtime-resources');
const fixtureProjects=path.resolve(process.env.RESOURCE_BENCH_SOURCE||'reports/dynamic-parity/projects');
const roots=Object.fromEntries(['baseline','candidate','next'].map(id=>[id,path.join(output,'projects',id)]));
const mode=process.argv[2]||'run';
const baselineBinary=path.join(output,'projects/baseline-binary/rustyx');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function fingerprint(root){
  const rows=[];
  async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())rows.push([path.relative(root,file),sha(await readFile(file))]);}}
  await walk(path.join(root,'.prnext'));return sha(JSON.stringify(rows));
}
async function setup(){
  await mkdir(output,{recursive:true});
  for(const id of Object.keys(roots)){
    const source=path.join(fixtureProjects,id==='next'?'next':'rustyx');
    try{await readFile(path.join(roots[id],'package.json'));throw new Error('Snapshot already exists: '+roots[id]);}catch(error){if(error.code!=='ENOENT')throw error;}
    await cp(source,roots[id],{recursive:true,verbatimSymlinks:true,filter:file=>!file.includes('/.prnext-cache')&&!file.includes('/.next/cache')});
  }
  await mkdir(path.dirname(baselineBinary),{recursive:true});await cp(binary,baselineBinary);
  const baseline={createdAt:new Date().toISOString(),binarySha256:sha(await readFile(binary)),runtimeSha256:await fingerprint(roots.baseline),fixtureSha256:sha(JSON.stringify(files)),node:process.version};
  await writeFile(path.join(output,'baseline.json'),JSON.stringify(baseline,null,2)+'\n');
  console.log('SNAPSHOT',baseline);
}
async function launch(id,backend,options,label){
  const root=roots[id],port=await freePort(),audit=path.join(output,`${id}.executions.ndjson`);
  await rm(path.join(root,id==='next'?'.next/cache/fetch-cache':'.prnext-cache'),{recursive:true,force:true});await writeFile(audit,'');
  const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',BENCH_AUDIT_FILE:audit,BENCH_BACKEND_URL:backend.url};
  for(const name of Object.keys(env))if(name.startsWith('PRNEXT_')||name==='NODE_OPTIONS')delete env[name];
  Object.assign(env,options);
  const require=createRequire(path.join(root,'package.json'));
  const executable=id==='next'?process.execPath:id==='baseline'?baselineBinary:binary;
  const args=id==='next'?[require.resolve('next/dist/bin/next'),'start',root]:['start',root];
  if(id!=='next'&&options.RESOURCE_NODE)args.push('--node',options.RESOURCE_NODE);
  args.push('--hostname','127.0.0.1','--port',String(port));
  const child=spawn(executable,args,{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  const url=`http://127.0.0.1:${port}`;
  const close=async()=>{if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM')}catch{};await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)]);try{process.kill(-child.pid,'SIGKILL')}catch{}}await writeFile(path.join(output,`${label}.log`),log);};
  try{for(let i=0;i<300;i++){if(child.exitCode!==null)throw new Error(log);try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(500)});if(await r.text()==='dynamic-parity-v1')return{child,url,audit,close};}catch{}await delay(25);}throw new Error('Server readiness timeout');}catch(error){await close();throw error;}
}
async function rebuild(backend){
  const root=roots.candidate,audit=path.join(output,'build.executions.ndjson');await writeFile(audit,'');
  const result=await exec(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root],{cwd:root,env:{...process.env,NODE_ENV:'production',BENCH_AUDIT_FILE:audit,BENCH_BACKEND_URL:backend.url},maxBuffer:8*1024**2});
  await writeFile(path.join(output,'build-candidate.log'),result.stdout+result.stderr);
  console.log('REBUILT',await fingerprint(root));
}
async function measure(variant,backend,scenario,profile,repetition){
  await backendControl(backend,{reset:true});
  const label=`${variant.name}-${scenario.id}-${profile.id}-${repetition}`,server=await launch(variant.engine,backend,variant.env||{},label);
  const row={variant:variant.name,engine:variant.engine,scenario:scenario.id,profile:profile.id,repetition,valid:false};
  try{
    row.idleCold=await processTree(server.child.pid);
    const prefix=`resources-${scenario.id}-${repetition}`;
    const warm=await loadChild({base:server.url,scenario:scenario.id,requests:64,concurrency:1,prefix:scenario.id==='cache-hit'?prefix:'warm-'+prefix});assert.deepEqual(warm.errors,{});
    await delay(100);row.idleWarm=await processTree(server.child.pid);await writeFile(server.audit,'');await backendControl(backend,{clearEvents:true});
    const before=await processTree(server.child.pid),monitor=sample(server.child.pid);let after,samples;
    try{Object.assign(row,await loadChild({base:server.url,scenario:scenario.id,...profile,concurrency:scenario.cycle?1:profile.concurrency,prefix}));after=await processTree(server.child.pid);}finally{samples=await monitor.stop();}
    assert.deepEqual(row.errors,{});assert.equal(row.attempts,row.requests);assert.equal(row.reachedCap,false);
    const events=(await readFile(server.audit,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),backendEvents=(await backendControl(backend)).events;
    row.work=verifyWork(scenario,events,backendEvents,row.requests,{prefix});
    assert.ok(before.processes.every(p=>after.processes.some(q=>p.pid===q.pid)),'worker disappeared during measurement');
    row.cpuMsPerResponse=(after.cpuMs-before.cpuMs)/row.requests;row.cpuPercentOneCore=(after.cpuMs-before.cpuMs)*100/row.elapsedMs;
    row.loadMedianRssMiB=median(samples.map(s=>s.rssMiB));row.loadPeakRssMiB=Math.max(...samples.map(s=>s.rssMiB));row.processes=after.processes;
    row.clientCpuPercent=row.clientCpuMs*100/row.elapsedMs;row.clientLimited=row.clientCpuPercent>=85;
    row.executionEvidenceSha256=sha(JSON.stringify(events));row.backendEvidenceSha256=sha(JSON.stringify(backendEvents));
    if(profile.ratePerSecond){assert.ok(Math.abs(row.requestsPerSecond/profile.ratePerSecond-1)<.05);assert.ok(row.scheduleLagP95Ms<10);}
    row.valid=true;
  }catch(error){row.error={message:error.message,stack:error.stack};}finally{await server.close();}
  console.log(label,row.valid?'VALID':'INVALID',row.loadMedianRssMiB?.toFixed(1),'MiB',row.cpuMsPerResponse?.toFixed(3),'CPU ms',Math.round(row.requestsPerSecond||0),'req/s',row.error?.message||'');
  return row;
}
if(mode==='snapshot'){await setup();}
else{
  const backend=await launchBackend();
  try{
    if(mode==='build'){await rebuild(backend);}
    else{
      const variants=JSON.parse(process.env.RESOURCE_VARIANTS||'[{"name":"baseline","engine":"baseline"},{"name":"candidate","engine":"candidate"},{"name":"next","engine":"next"}]');
      const selected=(process.env.RESOURCE_SCENARIOS||'ssr,data,route-get,pages-get,cache-hit,stream').split(',');
      const profiles=JSON.parse(process.env.RESOURCE_LOAD_PROFILES||'[{"id":"fixed-250","ratePerSecond":250,"concurrency":32,"durationMs":6000},{"id":"concurrency-32","concurrency":32,"durationMs":4000}]').filter(p=>!process.env.RESOURCE_PROFILE||p.id===process.env.RESOURCE_PROFILE);
      const data={createdAt:new Date().toISOString(),node:process.version,baseline:JSON.parse(await readFile(path.join(output,'baseline.json'),'utf8')),candidateSha256:await fingerprint(roots.candidate),binarySha256:sha(await readFile(binary)),variants,profiles,repetitions:Number(process.env.RESOURCE_REPETITIONS||3),runs:[]};
      assert.equal(await fingerprint(roots.baseline),data.baseline.runtimeSha256,'baseline changed');
      for(const root of Object.values(roots))for(const [name,source] of Object.entries(files))assert.equal(await readFile(path.join(root,name),'utf8'),source,'fixture sources changed');
      const target=path.join(output,process.env.RESOURCE_RESULT||'results.json');
      if(process.env.RESOURCE_REQUIRE_PARITY==='1'){
        const candidates=variants.filter(v=>v.engine!=='next');
        const evidence=Object.fromEntries(await Promise.all(['next',...candidates.map(v=>v.name)].map(async id=>[id,JSON.parse(await readFile(path.join(output,'parity-'+id,'results.json'),'utf8'))])));
        data.parity={};
        for(const variant of candidates){
          const id=variant.name,actual=variant.engine;
          assert.deepEqual(evidence[id].environmentOverrides,variant.env||{},'parity profile differs: '+id);
          if(process.env.RESOURCE_STRICT_PARITY==='1')assert.equal(evidence[id].binarySha256,sha(await readFile(actual==='baseline'?baselineBinary:binary)),'parity binary differs: '+id);
          assert.equal(await fingerprint(path.join(output,'parity-'+id,'projects/rustyx')),await fingerprint(roots[actual]),'parity artifact differs: '+id);
          const manifest=JSON.parse(await readFile(path.join(roots[actual],'.prnext/manifest.json'),'utf8'));
          const nextManifest=JSON.parse(await readFile(path.join(roots.next,'.next/prerender-manifest.json'),'utf8'));
          const unexpectedPrerender=dynamicRoutes.filter(route=>JSON.stringify(manifest.prerendered).includes('"'+route+'"')||Object.hasOwn(nextManifest.routes,route)||Object.hasOwn(nextManifest.dynamicRoutes,route));
          const comparisons=compareParity(evidence.next.result,evidence[id].result,{builds:[{unexpectedPrerender}]});
          assert.ok(evidence[id].result.checks.every(check=>check.pass));
          for(const scenario of scenarios.filter(s=>selected.includes(s.id)))assert.ok(eligible(scenario,{comparisons}),id+' not equivalent: '+scenario.id);
          data.parity[id]={comparisons,evidenceSha256:sha(JSON.stringify(evidence[id]))};
        }
      }
      for(const scenario of scenarios.filter(s=>selected.includes(s.id)))for(const profile of profiles)for(let repetition=1;repetition<=data.repetitions;repetition++)for(const variant of repetition%2?variants:[...variants].reverse()){
        data.runs.push(await measure(variant,backend,scenario,profile,repetition));await writeFile(target,JSON.stringify(data,null,2)+'\n');
      }
      data.finishedAt=new Date().toISOString();data.valid=data.runs.length>0&&data.runs.every(r=>r.valid);await writeFile(target,JSON.stringify(data,null,2)+'\n');if(!data.valid)process.exitCode=1;
    }
  }finally{await backend.close();}
}
