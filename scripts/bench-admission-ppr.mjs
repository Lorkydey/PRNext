// Admission and PPR A/B/Next comparison, with independently preserved production builds.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp,mkdir,readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {freePort,repositoryRoot,binary} from '../tests/support.mjs';
import {benchmarkWorkload} from './migration-load.mjs';
import {auditCases,auditMixed} from './next-audit-cases.mjs';
import {inspectSite} from './migration-browser-checks.mjs';
const reference=process.env.RUSTYX_NEXT_REFERENCE;
assert.ok(reference,'Set RUSTYX_NEXT_REFERENCE');
const baseline=path.resolve(process.env.ADMISSION_BASELINE||'/tmp/rustyx-before-admission-ppr');
const original=path.resolve('reports/current-comparison');
const output=path.resolve(process.env.ADMISSION_REPORT||'reports/admission-ppr');
const phase=process.env.ADMISSION_PHASE||'all';
const sites=['portail','dashboard','journal'];
const sha=data=>createHash('sha256').update(data).digest('hex');
async function digest(root){const hash=createHash('sha256');async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='node_modules'||entry.name.startsWith('.rustyx')||entry.name.startsWith('.next'))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){hash.update(path.relative(root,file));hash.update(await readFile(file))}}}await walk(root);return hash.digest('hex')}
const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'};
function launch(command,args,cwd){const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>log=(log+chunk).slice(-1024*1024));child.log=()=>log;child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});return child}
function rootFor(site,engine){return engine==='rustyx'?path.join(output,'projects',site):engine==='before'?path.join(original,'projects',site,'rustyx'):path.join(original,'projects',site,'next')}
async function server(site,engine){const root=rootFor(site,engine),port=await freePort(),url=`http://127.0.0.1:${port}`;const child=launch(engine==='next'?process.execPath:engine==='before'?path.join(baseline,'rustyx'):binary,engine==='next'?[path.join(reference,'dist/bin/next'),'start',root,'--hostname','127.0.0.1','--port',String(port)]:['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1'],root);const close=async()=>{if(child.exitCode!==null||child.signalCode)return;const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.kill('SIGTERM');try{await child.done}finally{clearTimeout(timer)}};try{for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(child.log());try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(1000)});if(r.status===200){await r.arrayBuffer();return{url,child,close}}}catch{}await delay(25)}throw new Error('readiness timeout')}catch(e){await close();throw e}}
await mkdir(output,{recursive:true});
const hashes={binary:sha(await readFile(binary)),baselineBinary:sha(await readFile(path.join(baseline,'rustyx'))),runtime:await digest(path.join(repositoryRoot,'packages/rustyx')),client:sha(await readFile(new URL('./migration-load.mjs',import.meta.url)))};
const report=phase==='load'?JSON.parse(await readFile(path.join(output,'results.json'),'utf8')):{date:new Date().toISOString(),hashes,versions:{next:JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,node:process.version},machine:{cpu:os.cpus()[0].model,cores:os.cpus().length,ramMiB:os.totalmem()/1024/1024,os:os.platform(),arch:os.arch()},method:{repetitions:3,durationMs:6000,capacityMs:6000,sustainedMs:45000,rustyxWorkers:1,apiLanes:512,renderLanes:16,warmupConcurrency:4,notes:'Identical sources, production builds, one server at a time, cyclic engine order, new server each run. Before uses preserved current-comparison build AND the saved native binary. Next uses its preserved Next 16.3.5 webpack build. CPU and RSS sum server descendants including RSC threads, load client excluded but shares host. RSS shared pages may be counted twice. Three short trials per scenario; sustained and overload one trial. Old Rustyx C512 overload can reject requests; CPU per success then includes rejected work. Latency includes successful responses only. No profiler/build/test jobs during load.'},sites:[],runs:[]};
assert.deepEqual(report.hashes,hashes,'Cannot mix source/binary versions');
report.method.rscYoungGenerationMiB=Number((await readFile(path.join(repositoryRoot,'packages/rustyx/runtime/app-render.mjs'),'utf8')).match(/maxYoungGenerationSizeMb: (\d+)/)[1]);
const save=()=>writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
let active;
try{
 if(phase!=='load'){
  const browser=await chromium.launch();
  try{for(const site of sites){const root=rootFor(site,'rustyx'),source=rootFor(site,'before');
   await mkdir(path.dirname(root),{recursive:true}); await rm(root,{recursive:true,force:true});
   await cp(source,root,{recursive:true,filter:file=>!path.relative(source,file).split(path.sep).some(part=>part==='node_modules'||part.startsWith('.rustyx')||part.startsWith('.next')),errorOnExist:true,force:false});
   await symlink(path.join(source,'node_modules'),path.join(root,'node_modules'),'dir');
   const item={name:site,sourceSha256:await digest(source),engines:{}};assert.equal(await digest(root),item.sourceSha256);assert.equal(await digest(rootFor(site,'next')),item.sourceSha256);
   const build=launch(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',root],root);const start=performance.now(),result=await build.done;item.buildMs=performance.now()-start;await writeFile(path.join(output,site+'-build.log'),build.log());assert.equal(result.code,0,build.log());
   for(const engine of ['next','rustyx']){active=await server(site,engine);item.engines[engine]=await inspectSite(site,engine,active,{browser,output});await active.close();active=undefined}
   item.comparisons=item.engines.next.checks.map(check=>{const other=item.engines.rustyx.checks.find(c=>c.label===check.label);let equal=false;try{assert.ok(check.ok&&other?.ok);assert.deepEqual(check.value,other.value);equal=true}catch{}return{label:check.label,equal}});assert.ok(item.comparisons.every(c=>c.equal),JSON.stringify(item));report.sites.push(item);await save();console.log('PREPARED',site,item.comparisons.length,'checks');
  }}finally{await browser.close()}
 }
 if(phase!=='prepare'){
  const select=process.env.ADMISSION_SCENARIOS?.split(',');
  const jobs=[];
  for(const site of sites){
   const one=id=>auditCases(site).find(s=>s.id===id);
   const scenarios=site==='portail' ? [one('api-fast'),one('api-async'),
    { ...one('api-async'),id:'async-64',concurrency:64 },
    { ...one('api-async'),id:'async-512',concurrency:512 },
    { ...one('proxy'),id:'proxy-64',concurrency:64 },
    {id:'mixed-64',kind:'capacity',concurrency:64,workloads:auditMixed(site)},
    {id:'mixed-128',kind:'capacity',concurrency:128,workloads:auditMixed(site)},
    { ...one('api-async'),id:'sustained-async',kind:'sustained',concurrency:512 },
    { ...one('api-async'),id:'overload-1024',kind:'overload',concurrency:1024 }]
   :site==='dashboard' ? [one('ppr-html'),one('ppr-flight'),
    {id:'mixed-64',kind:'capacity',concurrency:64,workloads:auditMixed(site)},
    {id:'sustained-ppr',kind:'sustained',concurrency:64,workloads:auditMixed(site)}]
   :[one('api-pages')];
   for(const scenario of scenarios){if(select&&!select.includes(scenario.id))continue;for(let repetition=1;repetition<=(['sustained','overload'].includes(scenario.kind)?1:3);repetition++){const engines=['before','next','rustyx'];for(const engine of engines.slice(repetition-1).concat(engines.slice(0,repetition-1)))jobs.push({site,engine,repetition,scenario})}}
  }
  for(const {site,engine,repetition,scenario} of jobs){if(report.runs.some(r=>r.site===site&&r.engine===engine&&r.repetition===repetition&&r.scenario===scenario.id))continue;
   const row={site,engine,repetition,scenario:scenario.id,kind:scenario.kind,workloads:scenario.workloads};console.log('LOAD',site,engine,scenario.id,repetition);
   try{assert.equal(await digest(rootFor(site,engine)),report.sites.find(s=>s.name===site).sourceSha256);await rm(path.join(rootFor(site,engine),'.rustyx-cache'),{recursive:true,force:true});active=await server(site,engine);Object.assign(row,await benchmarkWorkload(active,scenario.workloads,{durationMs:scenario.kind==='sustained'?report.method.sustainedMs:scenario.kind==='capacity'?report.method.capacityMs:report.method.durationMs,concurrency:scenario.concurrency,warmupRequests:scenario.id==='stream'?16:scenario.id==='api-async'?40:200,warmupConcurrency:4,maxRequests:10000000}));if(scenario.kind==='overload'||scenario.kind==='sustained'){await delay(1500);row.recovery=await benchmarkWorkload(active,scenario.workloads,{durationMs:2000,concurrency:4,warmupRequests:16,warmupConcurrency:4,maxRequests:1000000})}console.log('RESULT',site,engine,scenario.id,Math.round(row.requestsPerSecond),row.cpuMsPerRequest?.toFixed(4),row.loadMedianRssMiB?.toFixed(1),row.errors)}catch(e){row.error=e.stack;console.error(e)}finally{if(active){await active.close();if(row.errors||row.error)await writeFile(path.join(output,[site,engine,scenario.id,repetition].join('-')+'.log'),active.child.log());active=undefined}}
   report.runs.push(row);await save();


  }
 }
 report.finishedAt=new Date().toISOString();await save();
 const invalid=report.runs.some(r=>r.error||!r.cpuValid||r.reachedCap||r.recovery?.errors||['rustyx','next'].includes(r.engine)&&r.scenario!=='overload-1024'&&r.errors||Object.keys(r.failures||{}).some(k=>k!=='HTTP 503'&&!(r.engine==='next'&&r.scenario==='overload-1024'&&k==='ETIMEDOUT')));
 report.completed=report.runs.length===108&&!invalid;
 report.overloadFailures=report.runs.filter(r=>r.scenario==='overload-1024').map(r=>({engine:r.engine,failures:r.failures,recoveryErrors:r.recovery?.errors}));
 await save(); if(invalid)process.exitCode=1;
}finally{await active?.close()}
