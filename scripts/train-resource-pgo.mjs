// Native profile training on preserved local fixtures; these timings are not
// benchmarks. Use a different trainer for different production applications.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {freePort} from '../tests/support.mjs';
import {auditCases,auditMixed} from './next-audit-cases.mjs';
import {benchmarkWorkload} from './migration-load.mjs';
const binary=process.env.PRNEXT_PGO_BINARY;
assert.ok(binary,'Run through scripts/build-pgo.mjs');
for(const site of ['portail','dashboard','journal']) {
  const root=path.resolve('reports/resource-optimization/projects',site),port=await freePort();
  const child=spawn(binary,['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1'],{env:{...process.env,NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
  let log='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>log=(log+chunk).slice(-16384));
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  const server={child,url:`http://127.0.0.1:${port}`};
  try {
    let ready=false;
    for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(log);try{const response=await fetch(server.url+'/health.txt');await response.arrayBuffer();if(response.ok){ready=true;break}}catch{}await delay(25)}
    assert.ok(ready,'PGO server readiness');
    const workloads=[auditMixed(site),...auditCases(site).filter(s=>['api-fast','api-async','ppr-html','ppr-flight','api-pages'].includes(s.id)).map(s=>s.workloads)];
    for(const workload of workloads) {
      const result=await benchmarkWorkload(server,workload,{durationMs:3000,concurrency:16,warmupRequests:50,warmupConcurrency:4,maxRequests:1000000});
      assert.equal(result.errors,0,JSON.stringify(result.failures));
    }
  } finally {child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done}finally{clearTimeout(timer)}}
}
