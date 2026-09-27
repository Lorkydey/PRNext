// Run servers successively so CPU/RSS samples include all server descendants.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {freePort} from '../tests/support.mjs';
import {benchmarkWorkload} from './migration-load.mjs';
import {auditCases,auditMixed} from './next-audit-cases.mjs';
import {processTree} from './bench-next-comparison.mjs';
const output=path.resolve('reports/hot-path-optimization');
const reference=JSON.parse(await readFile('reports/next-runtime-comparison/results.json','utf8'));
const next=process.env.PRNEXT_NEXT_REFERENCE || '/var/folders/l5/krrw45cj7cz6hnmz1ny2ssxw0000gn/T/rustyx-next-reference-QNsB3F/node_modules/next';
const engines=(process.env.HOT_ENGINES||'before,rustyx,next').split(',');
const filter=process.env.HOT_SCENARIOS?.split(',');
const repetitions=Number(process.env.HOT_REPETITIONS||3),durationMs=Number(process.env.HOT_DURATION_MS||5000);
const results=[];
await mkdir(output,{recursive:true});
const file=path.join(output,process.env.HOT_OUTPUT||'results.json');
const hashes={};for(const [name,file] of Object.entries({before:'reports/hot-path-optimization/baseline/target/release/prnext',rustyx:'target/release/prnext',client:'scripts/migration-load.mjs'}))hashes[name]=createHash('sha256').update(await readFile(file)).digest('hex');
const machine={cpu:os.cpus()[0].model,cores:os.cpus().length,ramMiB:os.totalmem()/1048576,node:process.version,next:JSON.parse(await readFile(path.join(next,'package.json'),'utf8')).version};
async function digest(root){const hash=createHash('sha256');async function visit(directory){for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='node_modules'||entry.name.startsWith('.next')||entry.name.startsWith('.prnext'))continue;const file=path.join(directory,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()){hash.update(path.relative(root,file)+'\0');hash.update(await readFile(file))}}}await visit(root);return hash.digest('hex')}
const projects={};
for(const site of ['boutique','journal','documentation','dashboard','portail']){
 const source=await digest(path.resolve(`reports/hot-path-optimization/projects/${site}`));
 for(const engine of ['next','rustyx'])assert.equal(await digest(path.resolve(`reports/next-runtime-comparison/projects/${site}/${engine}`)),source,site+' source parity');
 const root=path.resolve(`reports/hot-path-optimization/projects/${site}/.prnext`);
 projects[site]={source,runtime:await digest(path.join(root,'runtime')),compat:await digest(path.join(root,'compat')),manifest:createHash('sha256').update(await readFile(path.join(root,'manifest.json'))).digest('hex')};
}
const scenarios=[['documentation','isr-hit'],['boutique','image-hot'],['journal','api-pages'],['documentation','api-pages'],['dashboard','ppr-flight'],['dashboard','ppr-html'],['portail','api-async'],['journal','upload'],['dashboard','mixed-64'],['portail','async-512'],['documentation','mixed-64']];
async function start(site,engine){
  const candidate=engine==='rustyx';
  const root=path.resolve(candidate?`reports/hot-path-optimization/projects/${site}`:`reports/next-runtime-comparison/projects/${site}/${engine==='next'?'next':'rustyx'}`);
  const port=await freePort(),env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',PRNEXT_RESPONSE_BUFFER_MIB:'8',PRNEXT_ADAPTIVE_ADMISSION:'0'};
  delete env.TOKIO_WORKER_THREADS;
  if(process.env.HOT_NODE_OPTIONS)env.NODE_OPTIONS=[env.NODE_OPTIONS,process.env.HOT_NODE_OPTIONS].filter(Boolean).join(' ');
  if(candidate&&process.env.HOT_NODE_PRELOAD)env.NODE_OPTIONS=[env.NODE_OPTIONS,`--require=${path.resolve(process.env.HOT_NODE_PRELOAD)}`].filter(Boolean).join(' ');
  if(engine.startsWith('threads-'))env.TOKIO_WORKER_THREADS=engine.slice(8);
  const executable=engine==='next'?process.execPath:path.resolve(candidate?'target/release/prnext':'reports/hot-path-optimization/baseline/target/release/prnext');
  const args=engine==='next'?[path.join(next,'dist/bin/next'),'start',root,'--hostname','127.0.0.1','--port',String(port)]:['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1'];
  const child=spawn(executable,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',c=>log=(log+c).slice(-65536));
  const done=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
  const close=async()=>{if(child.exitCode!==null||child.signalCode)return;child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done}finally{clearTimeout(timer)}};
  const url=`http://127.0.0.1:${port}`;
  try{for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(1000)});await r.arrayBuffer();if(r.ok)return{url,child,close,log:()=>log}}catch{}await delay(25)}throw Error('Readiness timeout: '+log)}catch(e){await close();throw e}
}
let active;
try{
 if(process.env.HOT_PHASE==='check'){
  const {chromium}=await import('@playwright/test'),{inspectSite}=await import('./migration-browser-checks.mjs');
  const browser=await chromium.launch(),sites=[];
  try{for(const name of ['boutique','journal','documentation','dashboard','portail']){
    const site={name,engines:{}};
    for(const engine of ['next','rustyx']){active=await start(name,engine);site.engines[engine]=await inspectSite(name,engine,active,{browser,output});await active.close();active=undefined}
    site.comparisons=site.engines.next.checks.map(a=>{const b=site.engines.rustyx.checks.find(b=>a.label===b.label);assert.ok(a.ok&&b?.ok,a.label);assert.deepEqual(a.value,b.value);return{label:a.label,equal:true}});
    sites.push(site);await writeFile(path.join(output,'functional.json'),JSON.stringify({date:new Date().toISOString(),hashes,sites},null,2)+'\n');console.log('CHECKED',name,site.comparisons.length);
  }}finally{await browser.close()}
 } else {
 for(const [site,id] of scenarios){
  if(filter&&!filter.includes(id)&&!filter.includes(site+':'+id))continue;
  for(let repetition=1;repetition<=repetitions;repetition++)for(const engine of repetition%2?engines:[...engines].reverse()){
   const inspection=reference.sites.find(s=>s.name===site).engines[engine==='next'?'next':'rustyx'];
   let scenario=auditCases(site,inspection).find(s=>s.id===id);
   if(id==='upload')scenario={concurrency:4,workloads:[{endpoint:'/api/contact',method:'POST',body:JSON.stringify({email:'bench@example.test',padding:'x'.repeat(32768)}),status:201,marker:'"subscribed":"bench@example.test"'}]};
   if(id==='mixed-64')scenario={concurrency:64,workloads:auditMixed(site)};
   if(id==='async-512')scenario={concurrency:512,workloads:auditCases(site).find(s=>s.id==='api-async').workloads};
   assert.ok(scenario,id);
   active=await start(site,engine);
   const row={site,scenario:id,engine,repetition,...await benchmarkWorkload(active,scenario.workloads,{durationMs,concurrency:scenario.concurrency,warmupRequests:200,warmupConcurrency:4,maxRequests:10000000})};
   if(process.env.HOT_RECOVERY==='1'){
     await delay(15000);row.idleAfter=await processTree(active.child.pid);
     row.recovery=await benchmarkWorkload(active,scenario.workloads,{durationMs:2000,concurrency:4,warmupRequests:16,warmupConcurrency:4,maxRequests:1000000});
   }
   results.push(row);
   await writeFile(file,JSON.stringify({date:new Date().toISOString(),durationMs,repetitions,nodeOptions:process.env.HOT_NODE_OPTIONS||null,hashes,machine,projects,results},null,2)+'\n');
   console.log(site,id,engine,repetition,'rps',Math.round(row.requestsPerSecond),'cpu',row.cpuMsPerRequest.toFixed(4),'rss',row.loadMedianRssMiB.toFixed(1),'errors',row.errors);
   if(row.errors||!row.cpuValid||row.reachedCap||row.recovery?.errors){console.error(active.log());throw Error('Invalid measurement')}
   await active.close();active=undefined;
  }
 }
 }
}finally{await active?.close()}
