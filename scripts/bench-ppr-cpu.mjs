// Repeated production A/B comparison. Optional baseline: a binary plus the
// previous runtime/ and compat/ directories, captured before changing them.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,readdir,writeFile,symlink,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {repositoryRoot,binary} from '../tests/support.mjs';
import {start,processTree} from './bench-next-comparison.mjs';
import {workloadsFor} from './migration-load.mjs';

const reference=process.env.PRNEXT_NEXT_REFERENCE;
if(!reference)throw new Error('Set PRNEXT_NEXT_REFERENCE to an installed next package');
const baseline=process.env.PPR_BASELINE_DIR;
const durationMs=Number(process.env.PPR_DURATION_MS||30000), repetitions=Number(process.env.PPR_REPETITIONS||3);
if(!Number.isSafeInteger(durationMs)||durationMs<1000||durationMs>600000||!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>10)throw new Error('Invalid PPR duration or repetitions');
const output=path.resolve(process.env.MIGRATION_REPORT_DIR||'reports/next-migration-cpu');
await mkdir(output,{recursive:true});
const root=await mkdtemp(path.join(os.tmpdir(),'rustyx-ppr-cpu-'));
const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'};
const exec=promisify(execFile),require=createRequire(import.meta.url),nextCli=path.join(reference,'dist/bin/next');
const engines=baseline?['next','rustyx-before','rustyx']:['next','rustyx'];
const commands={next:{start:port=>[process.execPath,[nextCli,'start',root,'--hostname','127.0.0.1','--port',String(port)]]}};
for(const engine of engines.filter(e=>e!=='next'))commands[engine]={start:port=>[engine==='rustyx-before'?path.resolve(baseline,'rustyx'):binary,['start',root,'--hostname','127.0.0.1','--port',String(port),'--workers','1']]};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const result={date:new Date().toISOString(),versions:{node:process.versions.node,next:JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,react:JSON.parse(await readFile(path.join(reference,'../react/package.json'),'utf8')).version},
  machine:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,cores:os.cpus().length},
  method:{durationMs,repetitions,concurrency:8,warmupRequests:400,samplingMs:1000,engines,note:'Identical dashboard sources and application bundles; baseline restores its own binary and runtime/compat modules. New server and private data-cache database per run. Rotating engine order. Server process-tree CPU/RSS; load client excluded. Every response checks status, content and visitor nonce. No profiler or other test suite during measurement. Local synthetic benchmark, not a production capacity guarantee.'},sources:{},binaries:{rustyx:sha(await readFile(binary))},runtime:{},runs:[]};
if(baseline)result.binaries['rustyx-before']=sha(await readFile(path.join(baseline,'rustyx')));
const save=()=>writeFile(path.join(output,'cpu-results.json'),JSON.stringify(result,null,2)+'\n');
async function client(options){const {stdout}=await exec(process.execPath,[path.join(repositoryRoot,'scripts/migration-load.mjs'),'--load',JSON.stringify(options)],{maxBuffer:1024*1024,timeout:durationMs+30000});return JSON.parse(stdout)}
async function sources(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const name=path.posix.join(prefix,entry.name),file=path.join(directory,entry.name);
    if(entry.isDirectory())await sources(file,name);else result.sources[name]=sha(await readFile(file));
  }
}
const runtime=new Map();let server;
try{
  const source=path.join(repositoryRoot,'examples/next-migration/dashboard');await sources(source);
  await cp(source,root,{recursive:true});await writeFile(path.join(root,'public/ready.txt'),'benchmark-ready');
  await mkdir(path.join(root,'node_modules'));
  for(const name of ['next','react','react-dom'])await symlink(path.join(path.dirname(reference),name),path.join(root,'node_modules',name),'dir');
  for(const name of ['react-server-dom-webpack','scheduler'])await symlink(path.dirname(require.resolve(name+'/package.json')),path.join(root,'node_modules',name),'dir');
  for(const [engine,args] of [['next',[nextCli,'build',root,'--webpack']],['rustyx',[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root]]]){
    const compiled=await exec(process.execPath,args,{env,cwd:root,maxBuffer:8*1024*1024});await writeFile(path.join(output,`cpu-${engine}-build.log`),compiled.stdout+compiled.stderr);
  }
  for(const directory of ['runtime','compat'])for(const name of await readdir(path.join(root,'.prnext',directory))){
    if(!name.endsWith('.mjs')&&!name.endsWith('.cjs'))continue;
    const relative=path.join(directory,name),current=await readFile(path.join(root,'.prnext',relative));
    const before=baseline?await readFile(path.join(baseline,relative)).catch(error=>{if(error.code==='ENOENT')return current;throw error}):current;
    runtime.set(relative,{current,before});result.runtime[relative]={rustyx:sha(current),...(baseline?{'rustyx-before':sha(before)}:{})};
  }
  for(let repetition=0;repetition<repetitions;repetition++)for(let offset=0;offset<engines.length;offset++){
    const engine=engines[(offset+repetition)%engines.length];
    for(const [relative,versions] of runtime)await writeFile(path.join(root,'.prnext',relative),engine==='rustyx-before'?versions.before:versions.current);
    // Neither run inherits cache rows or invalidation generations from another.
    await rm(path.join(root,'.prnext-cache'),{recursive:true,force:true});
    console.log(`PPR ${repetition+1}/${repetitions}: ${engine}, ${durationMs/1000}s, concurrency 8`);
    server=await start(commands[engine],root,env);
    const workloads=workloadsFor('dashboard'),warmup=await client({base:server.base,workloads,concurrency:8,requests:400});
    if(warmup.errors)throw new Error('Warmup: '+JSON.stringify(warmup.failures)+'\n'+server.child.output());
    const before=await processTree(server.child.pid),samples=[],began=performance.now();let stopped=false;
    const monitor=(async()=>{while(!stopped){samples.push({elapsedMs:performance.now()-began,...await processTree(server.child.pid)});await delay(1000)}})();
    let load,after;try{load=await client({base:server.base,workloads,concurrency:8,durationMs,requests:1000000});after=await processTree(server.child.pid)}finally{stopped=true;await monitor}
    const cpuMs=after.cpuMs-before.cpuMs,cpuValid=cpuMs>=0&&before.processes.every(p=>after.processes.some(q=>q.pid===p.pid));
    const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)]??null;
    const row={engine,repetition:repetition+1,...load,cpuValid,serverCpuMs:cpuValid?cpuMs:null,cpuMsPerRequest:cpuValid?cpuMs/load.requests:null,
      loadMedianRssMiB:median(samples.map(s=>s.rssMiB)),lastThirdRssMiB:median(samples.filter(s=>s.elapsedMs>=durationMs*2/3).map(s=>s.rssMiB)),sampledPeakRssMiB:Math.max(...samples.map(s=>s.rssMiB)),before,after,samples};
    result.runs.push(row);console.log(`${engine}: ${Math.round(row.requestsPerSecond)} req/s; ${row.cpuMsPerRequest?.toFixed(4)} ms CPU/response; ${row.loadMedianRssMiB.toFixed(1)} MiB RSS; ${row.errors} errors`);
    await server.close();await writeFile(path.join(output,`cpu-${engine}-${repetition+1}.log`),server.child.output());server=undefined;await save();
    if(load.errors||!cpuValid||load.attempts>=1000000)throw new Error('Invalid load trial');
  }
  result.status='passed';await save();
}catch(error){result.status='failed';result.error=error.stack;await save();throw error}
finally{await server?.close();await rm(root,{recursive:true,force:true})}
