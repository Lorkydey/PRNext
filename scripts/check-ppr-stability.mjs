// Longer correctness/memory observation, separate from the repeated short A/B benchmark.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {repositoryRoot,binary} from '../tests/support.mjs';
import {start,processTree} from './bench-next-comparison.mjs';
import {workloadsFor} from './migration-load.mjs';

const reference=process.env.RUSTYX_NEXT_REFERENCE;if(!reference)throw new Error('Set RUSTYX_NEXT_REFERENCE');
const exec=promisify(execFile),require=createRequire(import.meta.url);
const output=path.resolve(process.env.MIGRATION_REPORT_DIR||'reports/next-migration-optimized');await mkdir(output,{recursive:true});
const root=await mkdtemp(path.join(tmpdir(),'rustyx-ppr-stability-'));
const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'};
const nextCli=path.join(reference,'dist/bin/next');
const commands={next:{start:port=>[process.execPath,[nextCli,'start',root,'--hostname','127.0.0.1','--port',String(port)]]},rustyx:{start:port=>[binary,['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1']]}};
const result={date:new Date().toISOString(),nextVersion:JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,
  binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),
  method:'One 120-second mixed PPR run per engine, concurrency 8, 400 warmup requests, new server, Next then Rustyx; same dashboard sources plus a readiness text file. Samples every ~1 second. Client CPU/RAM excluded. 15 seconds idle observation after load. This is a short stability observation, not proof of leak freedom or a production capacity test.',runs:[]};
async function client(options){const{stdout}=await exec(process.execPath,[path.join(repositoryRoot,'scripts/migration-load.mjs'),'--load',JSON.stringify(options)],{maxBuffer:1024*1024,timeout:150000});return JSON.parse(stdout)}
const save=()=>writeFile(path.join(output,'stability.json'),JSON.stringify(result,null,2)+'\n');
let server;
try{
  await cp(path.join(repositoryRoot,'examples/next-migration/dashboard'),root,{recursive:true});
  await writeFile(path.join(root,'public/ready.txt'),'benchmark-ready');
  await mkdir(path.join(root,'node_modules'));
  for(const name of ['next','react','react-dom'])await symlink(path.join(path.dirname(reference),name),path.join(root,'node_modules',name),'dir');
  for(const name of ['react-server-dom-webpack','scheduler'])await symlink(path.dirname(require.resolve(name+'/package.json')),path.join(root,'node_modules',name),'dir');
  for(const[engine,args]of [['next',[nextCli,'build',root,'--webpack']],['rustyx',[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',root]]]){
    const compiled=await exec(process.execPath,args,{env,cwd:root,maxBuffer:8*1024*1024});await writeFile(path.join(output,`stability-${engine}-build.log`),compiled.stdout+compiled.stderr);
  }
  for(const engine of ['next','rustyx']){
    console.log('Stability:',engine,'120 seconds at concurrency 8');
    server=await start(commands[engine],root,env);
    const workloads=workloadsFor('dashboard');const warmup=await client({base:server.base,workloads,concurrency:8,requests:400});if(warmup.errors)throw new Error(JSON.stringify(warmup.failures));
    const before=await processTree(server.child.pid),samples=[];let stop=false;const began=performance.now();
    const monitor=(async()=>{while(!stop){const point=await processTree(server.child.pid);samples.push({elapsedMs:performance.now()-began,...point});await delay(1000)}})();
    let load;
    try{load=await client({base:server.base,workloads,concurrency:8,durationMs:120000,requests:1000000})}finally{stop=true;await monitor}
    const after=await processTree(server.child.pid);await delay(15000);const idle=await processTree(server.child.pid);
    const cpuMs=after.cpuMs-before.cpuMs;
    const cpuValid=cpuMs>=0&&before.processes.every(p=>after.processes.some(q=>q.pid===p.pid));
    const median=points=>{const values=points.map(p=>p.rssMiB).sort((a,b)=>a-b);return values[Math.floor(values.length/2)]};
    result.runs.push({engine,...load,cpuValid,serverCpuMs:cpuValid?cpuMs:null,cpuMsPerRequest:cpuValid?cpuMs/load.requests:null,before,after,idle,
      first30sRssMiB:median(samples.filter(p=>p.elapsedMs<30000)),last30sRssMiB:median(samples.filter(p=>p.elapsedMs>=90000)),
      sampledPeakRssMiB:Math.max(...samples.map(s=>s.rssMiB)),samples});
    console.log(engine,load.requests,'valid requests,',load.errors,'errors; last30 RSS',result.runs.at(-1).last30sRssMiB);
    await server.close();server=undefined;await save();
  }
  result.status=result.runs.every(r=>!r.errors&&r.cpuValid&&r.attempts<1000000)?'passed':'failed';await save();
  if(result.status!=='passed')process.exitCode=1;
}catch(error){result.status='failed';result.error=error.stack;await save();throw error}
finally{await server?.close();await rm(root,{recursive:true,force:true})}
