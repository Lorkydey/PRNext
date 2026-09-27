// Isolated GC experiment. Never changes framework sources or main benchmark builds.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {binary,freePort} from '../tests/support.mjs';
import {benchmarkWorkload,workloadsFor} from './migration-load.mjs';
const output=path.resolve('reports/admission-ppr/experiments');
const root=path.join(output,'dashboard'),source=path.resolve('reports/admission-ppr/projects/dashboard');
await mkdir(output,{recursive:true});await rm(root,{recursive:true,force:true});
await cp(source,root,{recursive:true,filter:file=>!path.relative(source,file).split(path.sep).includes('.prnext-cache')});
const file=path.join(root,'.prnext/runtime/app-render.mjs'),original=await readFile(file,'utf8');
assert.equal((original.match(/maxYoungGenerationSizeMb: \d+/g)||[]).length,1);
const result={date:new Date().toISOString(),binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),runtimeOriginalSha256:createHash('sha256').update(original).digest('hex'),method:{durationMs:30000,concurrency:64,repetitions:2,warmupRequests:200,warmupConcurrency:4,notes:'Same copied production dashboard build; only V8 RSC maxYoungGenerationSizeMb differs (8/16/32). Sequential fresh servers, no profiler or tests. First order 8/16/32, second 32/16/8. RSS/CPU full server tree. Exploratory, not included in the main 108 trials.'},runs:[]};
const save=()=>writeFile(path.join(output,'heap.json'),JSON.stringify(result,null,2)+'\n');
for(let repetition=1;repetition<=2;repetition++)for(const heap of repetition===1?[8,16,32]:[32,16,8]){
 await writeFile(file,original.replace(/maxYoungGenerationSizeMb: \d+/,`maxYoungGenerationSizeMb: ${heap}`));await rm(path.join(root,'.prnext-cache'),{recursive:true,force:true});
 const port=await freePort(),url=`http://127.0.0.1:${port}`;let log='';
 const child=spawn(binary,['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1'],{env:{...process.env,NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});for(const pipe of[child.stdout,child.stderr])pipe.on('data',chunk=>log=(log+chunk).slice(-100000));
 const done=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
 try{
  let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(log);try{const r=await fetch(url+'/health.txt');await r.arrayBuffer();if(r.status===200){ready=true;break}}catch{}await delay(25)}assert.ok(ready,log);
  console.log('HEAP',heap,repetition);
  const row={heap,repetition,...await benchmarkWorkload({url,child},workloadsFor('dashboard'),{durationMs:30000,concurrency:64,warmupRequests:200,warmupConcurrency:4,maxRequests:10000000})};
  result.runs.push(row);await save();console.log('RESULT',heap,repetition,row.requestsPerSecond,row.cpuMsPerRequest,row.loadMedianRssMiB,row.errors);assert.ok(!row.errors&&row.cpuValid&&!row.reachedCap);
 }finally{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done}finally{clearTimeout(timer)}}
}
result.completed=true;await save();
