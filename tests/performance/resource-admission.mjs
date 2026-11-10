// Same source/binary in all three modes; planned-arrival latency includes queue
// time and drain. On Linux the generator stays outside the owned server cgroup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceAdmissionFixture } from '../resource-admission-fixture.mjs';
import { binary, startServer } from '../support.mjs';
import { isMainModule } from '../../scripts/main-module.mjs';

const percentile = (values, p) => { const s = [...values].sort((a,b)=>a-b); return s.length ? s[Math.min(s.length-1,Math.ceil(s.length*p)-1)] : null; };
const median = values => { const s=[...values].sort((a,b)=>a-b),n=s.length; return n ? n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2 : null; };
const phases = [ { name:'light',rps:24,routes:['light','page'] }, { name:'nominal',rps:36,routes:['light','page','io','heavy','light','stream'] }, { name:'burst',rps:72,routes:['heavy','light','heavy','io','page','heavy','stream','light'] } ];
const environment = mode => ({ PRNEXT_PROFILE:'balanced', PRNEXT_RESOURCE_ADMISSION:mode==='on'?'1':'0', PRNEXT_ADAPTIVE_ADMISSION:mode==='legacy'?'1':'0' });

export function checkResourceComparison(runs) {
  const cases=[];
  for(const phase of phases){
    const pairs=runs.filter(r=>r.mode==='off').map(off=>({off:off.phases.find(p=>p.phase===phase.name),on:runs.find(r=>r.mode==='on'&&r.cycle===off.cycle)?.phases.find(p=>p.phase===phase.name)}));
    const valid=pairs.length>0&&pairs.every(p=>p.off&&p.on&&p.off.usefulRps>0&&p.off.p95Ms>0&&Number.isFinite(p.on.p95Ms));
    const p95Ratio=valid?median(pairs.map(p=>p.on.p95Ms/p.off.p95Ms)):null;
    const usefulRatio=valid?median(pairs.map(p=>p.on.usefulRps/p.off.usefulRps)):null;
    const allowance=valid?5/median(pairs.map(p=>p.off.p95Ms)):0;
    cases.push({phase:phase.name,p95Ratio,usefulRatio,passed:valid&&p95Ratio<=1.15+allowance&&usefulRatio>=.90});
  }
  return {passed:cases.every(c=>c.passed),budgets:{usefulRatio:.90,p95Ratio:1.15,lowLatencyAllowanceMs:5},cases};
}

export async function arrivalWindow(url, phase, {seconds=3,memory=8}={}) {
  const routes={light:'/api/light',page:'/',io:'/api/io',stream:'/api/stream',heavy:`/catalogue?memory=${memory}&wait=120&cpu=8`};
  const started=performance.now(),stop=started+seconds*1000,tasks=[],rows=[];
  for(let index=0;index<phase.rps*seconds;index++) {
    const planned=started+index*1000/phase.rps;await delay(Math.max(0,planned-performance.now()));
    const kind=phase.routes[index%phase.routes.length],owner='probe-'+index+'-end';
    tasks.push((async()=>{
      const issued=performance.now();
      try {
        const response=await fetch(url+routes[kind],{headers:{'x-resource-owner':owner},signal:AbortSignal.timeout(15000)});
        const text=await response.text(),ended=performance.now();
        rows.push({kind,status:response.status,valid:response.status===200&&text.includes(owner)&&(kind!=='heavy'||text.includes('Product 999')),latencyMs:ended-planned,scheduleDelayMs:issued-planned,inWindow:ended<=stop,bytes:Buffer.byteLength(text)});
      }catch(error){rows.push({kind,status:0,valid:false,latencyMs:performance.now()-planned,scheduleDelayMs:issued-planned,inWindow:false,error:error.name});}
    })());
  }
  await Promise.all(tasks);const success=rows.filter(r=>r.valid);
  return {phase:phase.name,seconds,offeredRps:phase.rps,planned:tasks.length,success:success.length,failed:rows.length-success.length,
    usefulRps:success.filter(r=>r.inWindow).length/seconds,p95Ms:percentile(rows.map(r=>r.latencyMs),.95),p99Ms:percentile(rows.map(r=>r.latencyMs),.99),
    smallP95Ms:percentile(rows.filter(r=>r.kind==='light').map(r=>r.latencyMs),.95),scheduleP99Ms:percentile(rows.map(r=>r.scheduleDelayMs),.99),drainMs:Math.max(0,performance.now()-stop),rows};
}

async function controlledServer(root,directory,mode,{cpu,memory,local}) {
  const inspect=path.join(directory,'inspection');
  if(local)return {...await startServer(root,['--workers','1'],{...environment(mode),PRNEXT_INSPECT_DIR:inspect}),group:undefined};
  assert.equal(process.platform,'linux');
  const unit=`prnext-resource-${process.pid}-${randomUUID().slice(0,8)}.service`,log=path.join(directory,'server.log');
  const systemctl=(...args)=>execFileSync('sudo',['systemctl',...args,unit],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  execFileSync('sudo',['systemd-run','--quiet','--collect','--unit='+unit,'--uid='+process.getuid(),'--gid='+process.getgid(),
    '--property=CPUQuota='+cpu+'%','--property=MemoryMax='+memory*1024*1024,'--property=MemorySwapMax=0','--property=WorkingDirectory='+root,
    '--property=StandardOutput=append:'+log,'--property=StandardError=append:'+log,'/usr/bin/env','NODE_ENV=production','PATH='+process.env.PATH,'PRNEXT_INSPECT_DIR='+inspect,
    ...Object.entries(environment(mode)).map(([k,v])=>k+'='+v),binary,'start',root,'--hostname','127.0.0.1','--port','0','--node',process.execPath,'--workers','1'],{stdio:['ignore','pipe','pipe']});
  const close=async()=>{assert.match(unit,/^prnext-resource-\d+-[0-9a-f-]+\.service$/);try{systemctl('stop');}catch(error){if(!/not loaded|not found/i.test(String(error.stderr)))throw error;}};
  try {
    let url;for(let i=0;i<100;i++){url=(await readFile(log,'utf8').catch(()=>'' )).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(url)break;await delay(100);}
    assert.ok(url,'owned server must reach readiness');
    const relative=systemctl('show','--property=ControlGroup','--value');assert.ok(relative.startsWith('/')&&!relative.split('/').includes('..')&&relative.includes(unit));
    const group='/sys/fs/cgroup'+relative;
    assert.equal(Number(await readFile(path.join(group,'memory.max'),'utf8')),memory*1024*1024);
    const quota=(await readFile(path.join(group,'cpu.max'),'utf8')).trim().split(/\s+/).map(Number);assert.ok(Math.abs(quota[0]/quota[1]-cpu/100)<.001);
    return {url,group,unit,close};
  }catch(error){await close();throw error;}
}
async function sampleGroup(group) {
  if(!group)return undefined;
  const [current,peak,events,cpu,procs]=await Promise.all(['memory.current','memory.peak','memory.events','cpu.stat','cgroup.procs'].map(name=>readFile(path.join(group,name),'utf8')));
  const fields=text=>Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line=>{const[k,v]=line.split(/\s+/);return[k,Number(v)];}));
  let rss=0,unknown=0;for(const pid of procs.trim().split(/\s+/).filter(Boolean)){
    const match=(await readFile(`/proc/${pid}/status`,'utf8').catch(()=>'' )).match(/^VmRSS:\s+(\d+) kB$/m);if(match)rss+=Number(match[1])*1024;else unknown++;
  }
  return {current:Number(current),peak:Number(peak),events:fields(events),cpu:fields(cpu),rss,unknown};
}
async function oneRun(fixture,output,mode,cycle,options) {
  const directory=path.join(output,`${cycle}-${mode}`);await mkdir(directory,{recursive:true});
  const server=await controlledServer(fixture.root,directory,mode,options);
  const result={mode,cycle,unit:server.unit,samples:[],sampleErrors:[],phases:[]};let sampling=true;
  const sampler=(async()=>{while(sampling){try{const sample=await sampleGroup(server.group);if(sample)result.samples.push({at:performance.now(),...sample});}catch(error){result.sampleErrors.push(error.message);}await delay(100);}})();
  try {
    for(const route of ['/','/api/light','/api/io','/catalogue?memory=1']){const response=await fetch(server.url+route);assert.equal(response.status,200);await response.arrayBuffer();}
    await delay(1200);
    for(const phase of phases){
      const start=result.samples.length,measured=await arrivalWindow(server.url,phase,{seconds:options.seconds,memory:Math.min(24,options.memory/32)}),samples=result.samples.slice(start);
      measured.windowMemoryMax=samples.length?Math.max(...samples.map(s=>s.current)):null;measured.windowRssMax=samples.length?Math.max(...samples.map(s=>s.rss)):null;
      result.phases.push(measured);await delay(750);
    }
    result.finalKernel=await sampleGroup(server.group);
  }catch(error){result.error=error.message;}
  finally{
    sampling=false;await sampler;await server.close();
    const inspect=path.join(directory,'inspection'),names=await readdir(inspect).catch(()=>[]);
    const logs=await Promise.all(names.filter(name=>/^native-\d+\.jsonl$/.test(name)).map(name=>readFile(path.join(inspect,name),'utf8')));
    result.admission=logs.flatMap(text=>text.trim().split('\n').filter(Boolean).map(JSON.parse)).filter(e=>e.type==='resource-admission');
    await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');
  }
  return result;
}
export async function compareResourceAdmission(output,options) {
  const fixture=await resourceAdmissionFixture(),runs=[];
  const result={version:1,complete:false,options,environment:{node:process.version,platform:process.platform,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},runs};
  try{
    await fixture.build();
    for(let cycle=0;cycle<options.cycles;cycle++)for(const mode of cycle%2?['on','legacy','off']:['off','legacy','on'])runs.push(await oneRun(fixture,output,mode,cycle,options));
    result.complete=runs.every(r=>!r.error&&r.phases.length===phases.length&&!r.sampleErrors.length);
    result.summary=phases.map(phase=>({phase:phase.name,modes:Object.fromEntries(['off','legacy','on'].map(mode=>{
      const values=runs.filter(r=>r.mode===mode).map(r=>r.phases.find(p=>p.phase===phase.name)).filter(Boolean);
      return[mode,{usefulRps:median(values.map(p=>p.usefulRps)),p95Ms:median(values.map(p=>p.p95Ms)),smallP95Ms:median(values.map(p=>p.smallP95Ms)),failed:values.reduce((n,p)=>n+p.failed,0),memoryMax:options.local?null:median(values.map(p=>p.windowMemoryMax))}];
    }))}));
    result.functionalPassed=result.complete&&runs.filter(r=>r.mode==='on').every(r=>r.phases.every(p=>!p.failed)&&!r.finalKernel?.events.oom_kill&&r.admission.some(e=>e.rss>0));
    result.performanceGate=checkResourceComparison(runs);
    result.caveats=['Synthetic mixed workload, not production SLOs or Next.js.','Latency includes planned-arrival queue time and drain; usefulRps counts only successful in-window completions.','memory.current includes charged page cache; RSS is summed by PID, never by RSC thread.','Unknown PID samples, errors, timeouts and kernel counters are retained.',options.local?'No enforced Linux caps in this local diagnostic.':'Generator is outside each owned server cgroup.'];
  }finally{await fixture.remove();}
  return result;
}
if(isMainModule(import.meta.url)){
  const outputFile=path.resolve(process.argv[2]),flags=process.argv.slice(3),value=(flag,fallback)=>{const index=flags.indexOf(flag);return index<0?fallback:Number(flags[index+1]);};
  const options={cpu:value('--cpu',100),memory:value('--memory',512),cycles:value('--cycles',2),seconds:value('--seconds',3),local:flags.includes('--local')};
  assert.ok([50,100,200].includes(options.cpu)&&[256,512,1024].includes(options.memory)&&[1,2,3].includes(options.cycles)&&[2,3,4].includes(options.seconds));
  const output=path.dirname(outputFile);await mkdir(output,{recursive:true});const report=await compareResourceAdmission(output,options);
  await writeFile(outputFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({complete:report.complete,functionalPassed:report.functionalPassed,performanceGate:report.performanceGate,summary:report.summary},null,2));if(!report.functionalPassed||!report.performanceGate.passed)process.exitCode=1;
}
