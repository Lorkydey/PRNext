import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {freePort,repositoryRoot,binary} from '../tests/support.mjs';
import {benchmarkWorkload} from './migration-load.mjs';
import {auditCases,auditMixed} from './next-audit-cases.mjs';
import {inspectSite} from './migration-browser-checks.mjs';

const output=path.resolve('reports/resource-optimization');
const baseline=JSON.parse(await readFile(path.join(output,'baseline.json'),'utf8'));
const next=process.env.PRNEXT_NEXT_REFERENCE;
assert.ok(next,'Set PRNEXT_NEXT_REFERENCE');
const phase=process.env.RESOURCE_PHASE||'load';
const selected=(process.env.RESOURCE_ENGINES||'before,rustyx,next,adaptive,mimalloc,pgo').split(',');
const native={before:path.join(baseline.directory,'rustyx'),rustyx:binary,adaptive:binary,mimalloc:path.resolve('target/mimalloc/release/prnext'),pgo:path.resolve('target/pgo/optimized/release/prnext')};
const rootFor=(site,engine)=>path.resolve(engine==='before'?`reports/admission-ppr/projects/${site}`:engine==='next'?`reports/current-comparison/projects/${site}/next`:`reports/resource-optimization/projects/${site}`);
const sha=data=>createHash('sha256').update(data).digest('hex');
async function digest(root){const h=createHash('sha256');async function visit(dir){for(const entry of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='node_modules'||entry.name.startsWith('.prnext')||entry.name.startsWith('.next'))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()){h.update(path.relative(root,file));h.update(await readFile(file))}}}await visit(root);return h.digest('hex')}
const hashes={binary:sha(await readFile(binary)),baseline:sha(await readFile(native.before)),runtime:await digest('packages/prnext'),client:sha(await readFile('scripts/migration-load.mjs'))};
assert.equal(hashes.baseline,baseline.binarySha256);
await mkdir(output,{recursive:true});
const file=path.join(output,'results.json');
const report=phase==='prepare'?{date:new Date().toISOString(),hashes,variants:{},sites:[],runs:[],machine:{cpu:os.cpus()[0].model,ramMiB:os.totalmem()/1024/1024,cores:os.cpus().length,os:os.platform(),arch:os.arch()},versions:{node:process.version,next:JSON.parse(await readFile(path.join(next,'package.json'),'utf8')).version},method:{durationMs:6000,repetitions:2,warmupRequests:200,warmupConcurrency:4,workers:1,responseQueueMiB:8,notes:'Successive servers, alternating engine order, identical sources, valid responses only in throughput. CPU/RSS include server descendants, load client excluded but shares host. Two short repetitions; sustained tests are one observation per engine. Allocator and PGO measured on this Mac, not Linux. Adaptive mode remains experimental.'}}:JSON.parse(await readFile(file,'utf8'));
assert.deepEqual(report.hashes,hashes,'Source or binary changed; prepare a new campaign');
const save=()=>writeFile(file,JSON.stringify(report,null,2)+'\n');
async function server(site,engine) {
  const root=rootFor(site,engine),port=await freePort();
  const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',PRNEXT_ADAPTIVE_ADMISSION:engine==='adaptive'?'1':'0',PRNEXT_RESPONSE_BUFFER_MIB:'8'};
  const child=spawn(engine==='next'?process.execPath:native[engine],engine==='next'?[path.join(next,'dist/bin/next'),'start',root,'--hostname','127.0.0.1','--port',String(port)]:['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>log=(log+chunk).slice(-65536));
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  const close=async()=>{if(child.exitCode!==null||child.signalCode)return;child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done}finally{clearTimeout(timer)}};
  const url=`http://127.0.0.1:${port}`;
  try{for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(log);try{const r=await fetch(url+'/health.txt',{signal:AbortSignal.timeout(1000)});await r.arrayBuffer();if(r.ok)return{child,url,close,log:()=>log}}catch{}await delay(25)}throw new Error('Readiness timeout')}catch(e){await close();throw e}
}
let active;
try {
  if(phase==='prepare') {
    const browser=await chromium.launch();
    try{for(const site of ['portail','dashboard','journal']) {
      const sourceSha256=await digest(rootFor(site,'before'));
      for(const engine of ['rustyx','next'])assert.equal(await digest(rootFor(site,engine)),sourceSha256);
      const item={name:site,sourceSha256,engines:{}};
      for(const engine of ['next','rustyx']){active=await server(site,engine);item.engines[engine]=await inspectSite(site,engine,active,{browser,output});await active.close();active=undefined}
      item.comparisons=item.engines.next.checks.map(c=>{const d=item.engines.rustyx.checks.find(x=>x.label===c.label);assert.ok(c.ok&&d?.ok);assert.deepEqual(c.value,d.value);return{label:c.label,equal:true}});
      report.sites.push(item);await save();console.log('CHECKED',site,item.comparisons.length);
    }}finally{await browser.close()}
  } else {
    for(const engine of selected){assert.ok(engine==='next'||native[engine],engine);if(engine!=='next'){const hash=sha(await readFile(native[engine]));if(report.variants[engine])assert.equal(report.variants[engine],hash);else report.variants[engine]=hash}}
    await save();
    const scenarios=[];
    for(const site of ['portail','dashboard','journal']) {
      const one=id=>auditCases(site).find(x=>x.id===id);
      const rows=site==='portail'?[{...one('api-async'),id:'async-512',concurrency:512},{id:'mixed-128',concurrency:128,workloads:auditMixed(site)},one('api-fast')]:site==='dashboard'?[one('ppr-html'),one('ppr-flight'),{id:'mixed-64',concurrency:64,workloads:auditMixed(site)}]:[one('api-pages')];
      for(const row of rows)scenarios.push({site,...row});
    }
    if(phase==='sustained')scenarios.splice(0,scenarios.length,...['portail','dashboard'].map(site=>({site,id:site==='portail'?'sustained-async':'sustained-ppr',concurrency:site==='portail'?512:64,workloads:site==='portail'?auditCases(site).find(x=>x.id==='api-async').workloads:auditMixed(site),sustained:true})));
    const filter=process.env.RESOURCE_SCENARIOS?.split(',');
    for(const scenario of scenarios){if(filter&&!filter.includes(scenario.id))continue;for(let repetition=1;repetition<=(scenario.sustained?1:report.method.repetitions);repetition++){
      const order=repetition%2?selected:[...selected].reverse();
      for(const engine of order){if(report.runs.some(r=>r.site===scenario.site&&r.scenario===scenario.id&&r.engine===engine&&r.repetition===repetition))continue;
        const row={site:scenario.site,scenario:scenario.id,engine,repetition};console.log('LOAD',row.site,row.scenario,engine,repetition);
        try {
          assert.equal(await digest(rootFor(row.site,engine)),report.sites.find(x=>x.name===row.site).sourceSha256);
          await rm(path.join(rootFor(row.site,engine),'.prnext-cache'),{recursive:true,force:true});
          active=await server(row.site,engine);
          Object.assign(row,await benchmarkWorkload(active,scenario.workloads,{durationMs:scenario.sustained?30000:report.method.durationMs,concurrency:scenario.concurrency||4,warmupRequests:200,warmupConcurrency:4,maxRequests:10000000}));
          if(scenario.sustained){await delay(1500);row.recovery=await benchmarkWorkload(active,scenario.workloads,{durationMs:2000,concurrency:4,warmupRequests:16,warmupConcurrency:4,maxRequests:1000000})}
          console.log('RESULT',row.site,row.scenario,engine,Math.round(row.requestsPerSecond),row.cpuMsPerRequest.toFixed(4),row.loadMedianRssMiB.toFixed(1),row.errors);
        } catch(e){row.error=e.stack;console.error(e)} finally {if(active){if(row.errors||row.error)await writeFile(path.join(output,`${row.site}-${row.scenario}-${engine}-${repetition}.log`),active.log());await active.close();active=undefined}}
        report.runs.push(row);await save();
      }
    }}
    report.finishedAt=new Date().toISOString();
    report.invalid=report.runs.filter(r=>r.error||!r.cpuValid||r.reachedCap||r.recovery?.errors);
    report.responseFailures=report.runs.filter(r=>r.errors).map(r=>({site:r.site,scenario:r.scenario,engine:r.engine,failures:r.failures}));
    await save();if(report.invalid.length||report.responseFailures.length)process.exitCode=1;
  }
} finally {await active?.close()}
