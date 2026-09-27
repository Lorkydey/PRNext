// Reproducible multi-project audit: persistent, identical source copies, one
// engine at a time. This script does not change the PRNext implementation.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,writeFile,readdir,rm,symlink,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import sharp from 'sharp';
import {repositoryRoot,binary,freePort} from '../tests/support.mjs';
import {processTree,sample} from './bench-next-comparison.mjs';
import {benchmarkWorkload} from './migration-load.mjs';
import {inspectSite} from './migration-browser-checks.mjs';
import {auditSites,auditCases,auditMixed} from './next-audit-cases.mjs';

const reference=process.env.PRNEXT_NEXT_REFERENCE;
assert.ok(reference,'Set PRNEXT_NEXT_REFERENCE');
const require=createRequire(import.meta.url),exec=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const output=path.resolve(process.env.AUDIT_REPORT_DIR||'reports/next-audit');await mkdir(output,{recursive:true});
const phase=process.env.AUDIT_PHASE||'all';assert.ok(['all','prepare','load'].includes(phase));
const selected=(process.env.AUDIT_SITES||auditSites.join(',')).split(',');assert.ok(selected.every(s=>auditSites.includes(s)));
const selectedScenarios=process.env.AUDIT_SCENARIOS?.split(',');
const repetitions=Number(process.env.AUDIT_REPETITIONS||3),durationMs=Number(process.env.AUDIT_DURATION_MS||3000),mixedMs=Number(process.env.AUDIT_MIXED_MS||10000);
const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'};
const versions={node:process.version,next:JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,react:JSON.parse(await readFile(path.join(reference,'../react/package.json'),'utf8')).version,rustyx:JSON.parse(await readFile(path.join(repositoryRoot,'packages/prnext/package.json'),'utf8')).version};
assert.equal(versions.next,'16.3.5');assert.equal(versions.react,'19.3.0');
if(phase!=='load'||selectedScenarios?.includes('image-hot')){
 const nextRequire=createRequire(path.join(reference,'package.json'));
 // Next silently returns the original image when its optional native Sharp
 // dependency cannot load. Catch that broken reference before benchmarking.
 const nextSharp=nextRequire('sharp');
 assert.equal(nextSharp.versions.sharp,sharp.versions.sharp,'Both image test environments must use the same Sharp version');
}
async function files(directory){let list=[];for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name==='node_modules'||entry.name.startsWith('.next')||entry.name.startsWith('.prnext'))continue;const file=path.join(directory,entry.name);if(entry.isDirectory())list.push(...await files(file));else list.push(file)}return list.sort()}
async function digest(directory){const hash=createHash('sha256');for(const file of await files(directory)){hash.update(path.relative(directory,file));hash.update(await readFile(file))}return hash.digest('hex')}
async function bytes(directory){let n=0;for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())n+=await bytes(file);else if(entry.isFile())n+=(await stat(file)).size}return n}
async function packageRoot(name){let folder=path.dirname(require.resolve(name));for(;;){try{if(JSON.parse(await readFile(path.join(folder,'package.json'),'utf8')).name===name)return folder}catch{}const parent=path.dirname(folder);if(parent===folder)throw new Error('Cannot locate package '+name);folder=parent}}
let report=phase==='load'?JSON.parse(await readFile(path.join(output,'results.json'),'utf8')):{date:new Date().toISOString(),versions,machine:{os:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,cores:os.cpus().length,totalMemoryMiB:os.totalmem()/1024/1024},binarySha256:sha(await readFile(binary)),frameworkSourceSha256:await digest(path.join(repositoryRoot,'packages/prnext')),runnerSha256:sha(await readFile(new URL(import.meta.url))),loadScriptSha256:sha(await readFile(new URL('./migration-load.mjs',import.meta.url))),method:{repetitions,durationMs,mixedMs,concurrency:4,warmupRequests:200,capacityConcurrency:[1,16,128],capacityDurationMs:4000,longDurationMs:60000,rustyxWorkers:1,note:'Identical Next sources and dependency files in persistent Next/PRNext copies. Separate production builds; Next --webpack. One server/benchmark at a time; load client excluded from CPU/RSS but shares the machine. Three short runs per route and longer mixed runs, alternating engine order, fresh server per trial. Capacity curves and sustained tests have one pass per engine/point. Build times and sampled peak RSS are single observations. No runtime performance fixes during this audit.'},sites:[]};
assert.equal(report.binarySha256,sha(await readFile(binary)),'Binary changed since preparation');
assert.equal(report.frameworkSourceSha256,await digest(path.join(repositoryRoot,'packages/prnext')),'Runtime changed since preparation');
if(phase==='load'){
 assert.equal(repetitions,report.method.repetitions,'Resume must preserve AUDIT_REPETITIONS');
 assert.equal(durationMs,report.method.durationMs,'Resume must preserve AUDIT_DURATION_MS');
 assert.equal(mixedMs,report.method.mixedMs,'Resume must preserve AUDIT_MIXED_MS');
 assert.deepEqual(versions,report.versions,'Reference versions changed since preparation');
}
const save=()=>writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
const rootFor=(name,engine)=>path.join(output,'projects',name,engine);
function launch(command,args,cwd){const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log=(log+v).slice(-8*1024*1024));child.stderr.on('data',v=>log=(log+v).slice(-8*1024*1024));child.log=()=>log;child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});return child}
async function build(name,engine,kind){
 const root=rootFor(name,engine),args=engine==='next'?[path.join(reference,'dist/bin/next'),'build',root,'--webpack']:[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root];
 const start=performance.now(),child=launch(process.execPath,args,root),monitor=sample(child.pid);let timer=setTimeout(()=>child.kill('SIGTERM'),180000);
 let outcome,samples,wallMs;try{outcome=await child.done;wallMs=performance.now()-start}finally{clearTimeout(timer);samples=await monitor.stop()}
 const log=`${name}-${engine}-build-${kind}.log`;await writeFile(path.join(output,log),child.log());
 return{kind,ok:outcome.code===0,exit:outcome,wallMs,sampledPeakRssMiB:Math.max(0,...samples.map(s=>s.rssMiB)),samples:samples.length,log,...outcome.code===0?{outputBytes:await bytes(path.join(root,engine==='next'?'.next':'.prnext'))}:{}};
}
async function server(name,engine){
 const root=rootFor(name,engine),port=await freePort(),url=`http://127.0.0.1:${port}`,began=performance.now();
 const child=launch(engine==='next'?process.execPath:binary,engine==='next'?[path.join(reference,'dist/bin/next'),'start',root,'--port',String(port),'--hostname','127.0.0.1']:['start',root,'--port',String(port),'--hostname','127.0.0.1','--workers','1'],root);
 const close=async()=>{if(child.exitCode!==null||child.signalCode)return;const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.kill('SIGTERM');try{await child.done}finally{clearTimeout(timer)}};
 try{for(let i=0;i<300;i++){if(child.exitCode!==null)throw new Error(child.log());try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(1000)});if(r.status===200){await r.arrayBuffer();return{child,url,close,startupMs:performance.now()-began}}}catch{}await delay(25)}throw new Error('Readiness timeout')}catch(error){await close();throw error}
}
async function coldRequest(srv,spec){const start=performance.now(),response=await fetch(new URL(spec.endpoint,srv.url),{headers:spec.headers}),headersMs=performance.now()-start,body=Buffer.from(await response.arrayBuffer());return{status:response.status,headersMs,completeMs:performance.now()-start,decodedBytes:body.length,contentType:response.headers.get('content-type'),contentEncoding:response.headers.get('content-encoding'),...(spec.image?{image:await sharp(body).metadata()}:{})}}
async function comparePixels(name){try{const [a,b]=await Promise.all(['next','rustyx'].map(engine=>sharp(path.join(output,`${name}-${engine}.png`)).ensureAlpha().raw().toBuffer({resolveWithObject:true})));if(a.info.width!==b.info.width||a.info.height!==b.info.height)return{sameDimensions:false};let changed=0;for(let i=0;i<a.data.length;i+=4)if([0,1,2].some(c=>Math.abs(a.data[i+c]-b.data[i+c])>16))changed++;return{sameDimensions:true,changedPercent:100*changed/(a.info.width*a.info.height)}}catch{return{unavailable:true}}}
let active;
try{
 if(phase!=='load'){
  const browser=await chromium.launch();
  try{for(const name of selected){
   const source=path.join(repositoryRoot,'examples/next-migration',name),sourceSha256=await digest(source),site={name,sourceSha256,sourceFiles:(await files(source)).length,engines:{},runs:[]};report.sites.push(site);
   for(const engine of ['next','rustyx']){
    const root=rootFor(name,engine);console.log('PREPARE',name,engine);
    try{await stat(root);throw new Error('Destination exists; use a new AUDIT_REPORT_DIR or AUDIT_PHASE=load')}catch(error){if(error.code!=='ENOENT')throw error}
    await cp(source,root,{recursive:true});await mkdir(path.join(root,'node_modules'));
    for(const dep of ['next','react','react-dom'])await symlink(path.join(path.dirname(reference),dep),path.join(root,'node_modules',dep),'dir');
    for(const dep of ['react-server-dom-webpack','scheduler','clsx'])await symlink(await packageRoot(dep),path.join(root,'node_modules',dep),'dir');
    assert.equal(await digest(root),sourceSha256);
    const data=site.engines[engine]={sourceSha256,project:path.relative(output,root),builds:[]};
    const cold=await build(name,engine,'cold');data.builds.push(cold);await save();if(!cold.ok)continue;
    data.builds.push(await build(name,engine,'unchanged'));
    const page=path.join(root,['journal','documentation'].includes(name)?'pages/index.jsx':'app/page.jsx'),original=await readFile(page,'utf8');assert.ok(original.includes('<h1>'));
    try{await writeFile(page,original.replace('<h1>','<h1>Audit incrémental · '));data.builds.push(await build(name,engine,'page-edit'))}finally{await writeFile(page,original);data.restoredBuild=await build(name,engine,'restored')}
    assert.equal(await digest(root),sourceSha256);if(!data.restoredBuild.ok)continue;
    active=await server(name,engine);data.startupMs=active.startupMs;data.idle=await processTree(active.child.pid);data.coldHome=await coldRequest(active,{endpoint:'/'});data.afterColdHome=await processTree(active.child.pid);
    Object.assign(data,await inspectSite(name,engine,active,{browser,output}));data.afterJourney=await processTree(active.child.pid);
    await active.close();await writeFile(path.join(output,`${name}-${engine}-functional.log`),active.child.log());active=undefined;
    if(name==='boutique'&&data.imageResponse?.src){await rm(path.join(root,engine==='next'?'.next/cache/images':'.prnext-cache/images'),{recursive:true,force:true});active=await server(name,engine);data.imageCold=await coldRequest(active,{endpoint:data.imageResponse.src,headers:{accept:'image/webp'},image:true});data.imageWarm=await coldRequest(active,{endpoint:data.imageResponse.src,headers:{accept:'image/webp'},image:true});await active.close();active=undefined}
    await save();
   }
   const labels=new Set(Object.values(site.engines).flatMap(e=>(e.checks||[]).map(c=>c.label)));
   site.comparisons=[...labels].map(label=>{const next=site.engines.next?.checks?.find(c=>c.label===label),rustyx=site.engines.rustyx?.checks?.find(c=>c.label===label);let equal=false;try{assert.ok(next?.ok&&rustyx?.ok);assert.deepEqual(next.value,rustyx.value);equal=true}catch{}return{label,equal,next,rustyx}});
   site.visual=await comparePixels(name);console.log('FUNCTIONAL',name,site.comparisons.filter(c=>c.equal).length+'/'+site.comparisons.length);await save();
   await writeFile(path.join(output,'projects',name,'README.md'),`# ${name}\n\nIdentical source SHA-256: ${sourceSha256}. Dependencies are local symlinks.\n\nNext: cd next && npm start -- --port 3100\n\nPRNext from repository root: node packages/prnext/cli.mjs start ${path.relative(repositoryRoot,rootFor(name,'rustyx'))} --port 3200\n`);
  }}finally{await browser.close()}
  report.prepared=true;await save();
 }
 if(phase!=='prepare'){
  for(const site of report.sites.filter(s=>selected.includes(s.name))){
   const name=site.name;
   const matrix=auditCases(name,site.engines.next);
   const jobs=[];
   for(let repetition=1;repetition<=repetitions;repetition++)for(const scenario of matrix)for(const engine of repetition%2?['next','rustyx']:['rustyx','next'])jobs.push({engine,repetition,scenario,durationMs:scenario.kind==='mixed'?mixedMs:durationMs});
   for(const concurrency of report.method.capacityConcurrency)for(const engine of concurrency===16?['rustyx','next']:['next','rustyx'])jobs.push({engine,repetition:1,scenario:{id:'capacity-'+concurrency,label:'Mixte / concurrence '+concurrency,kind:'capacity',concurrency,workloads:auditMixed(name)},durationMs:report.method.capacityDurationMs});
   if(['dashboard','portail'].includes(name))for(const engine of ['next','rustyx'])jobs.push({engine,repetition:1,scenario:{id:'sustained',label:'Mixte prolongé 60 s / concurrence 8',kind:'sustained',concurrency:8,workloads:auditMixed(name)},durationMs:report.method.longDurationMs});
   for(const job of jobs){
    const {engine,repetition,scenario}=job;if(site.runs.some(r=>r.engine===engine&&r.repetition===repetition&&r.scenario===scenario.id))continue;
    if(selectedScenarios&&!selectedScenarios.includes(scenario.id))continue;
    const engineData=site.engines[engine];if(!engineData?.restoredBuild?.ok)continue;
    const root=rootFor(name,engine);assert.equal(await digest(root),site.sourceSha256);
    let workloads=scenario.workloads;if(scenario.id==='image-hot')workloads=auditCases(name,engineData).find(c=>c.id==='image-hot').workloads;
    const row={engine,repetition,scenario:scenario.id,label:scenario.label,kind:scenario.kind,workloads,runnerSha256:sha(await readFile(new URL(import.meta.url))),casesSha256:sha(await readFile(new URL('./next-audit-cases.mjs',import.meta.url)))};
    console.log('LOAD',name,engine,scenario.id,repetition);
    try{
     await rm(path.join(root,'.prnext-cache'),{recursive:true,force:true});
     active=await server(name,engine);
     Object.assign(row,await benchmarkWorkload(active,workloads,{durationMs:job.durationMs,concurrency:scenario.concurrency,warmupRequests:scenario.id==='stream'?16:scenario.id==='api-async'?40:200,warmupConcurrency:4,maxRequests:2000000}));
     if(scenario.kind==='sustained'){await delay(15000);row.afterIdle=await processTree(active.child.pid)}
     console.log('RESULT',name,engine,scenario.id,Math.round(row.requestsPerSecond),'req/s',row.cpuMsPerRequest?.toFixed(4),'ms CPU',row.loadMedianRssMiB?.toFixed(1),'MiB',row.errors,'errors');
    }catch(error){row.error=error.stack;console.error('FAILED',name,engine,scenario.id,error.message)}
    finally{if(active){await active.close();if(row.error||row.errors)await writeFile(path.join(output,`${name}-${engine}-${scenario.id}-${repetition}-failure.log`),active.child.log());active=undefined}}
    site.runs.push(row);await save();
   }
  }
  report.completed=true;report.finishedAt=new Date().toISOString();await save();
 }
}catch(error){report.error=error.stack;await save();throw error}finally{await active?.close()}
console.log('Audit saved:',output);
if(report.sites.some(s=>Object.values(s.engines).some(e=>!e.restoredBuild?.ok)||(s.comparisons||[]).some(c=>!c.equal)||s.runs.some(r=>r.error||r.kind!=='capacity'&&r.errors)))process.exitCode=1;
