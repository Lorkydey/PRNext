import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createCgroupAccounting, summarizeCgroupSamples } from './cgroup-accounting.mjs';
import { isMainModule } from '../../scripts/main-module.mjs';

export function assertProbeObservation(value,stage,{outsidePid}={}){
  if(!['initial','unrelated-exit','live-child','child-exited'].includes(stage))throw Error('Invalid kernel probe observation stage.');
  if(value?.state!=='verified')throw Error(`Kernel cgroup observation was incomplete at ${stage}.`);
  if(outsidePid!==undefined&&value.pids.includes(outsidePid))throw Error(`An outside PID was present in the server cgroup at ${stage}.`);
}

/** Short, real-kernel preflight; no HTTP load and no replacement measurement. */
export async function probeCgroupAccounting() {
  const accounting=await createCgroupAccounting();
  let child,closed,group,outside,outsideClosed,result,failure;
  const observations={},cleanupFailures=[];
  try{
    group=await accounting.createServerGroup('0-baseline');
    const source=`const {spawn}=require('node:child_process');let worker;let hold=setInterval(()=>{},1000);process.on('message',message=>{if(message==='work'){worker=spawn(process.execPath,['-e',"const data=Buffer.alloc(16*1024*1024,1);const end=process.hrtime.bigint()+200000000n;while(process.hrtime.bigint()<end){};process.send('ready');process.on('message',()=>process.exit(data[0]===1?0:1));setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});worker.once('message',()=>process.send({stage:'worked',pid:worker.pid}));worker.once('close',()=>process.send({stage:'exited'}));}else if(message==='release'){worker.send('exit');}else if(message==='stop'){clearInterval(hold);process.disconnect();}});process.on('disconnect',()=>{worker?.kill();clearInterval(hold)});process.send({stage:'ready'});`;
    const launch=group.launch(process.execPath,['-e',source]);
    child=spawn(launch.command,launch.args,{stdio:['ignore','ignore','ignore','ipc'],detached:true});
    closed=once(child,'close');
    const message=async()=>{
      const [value]=await once(child,'message',{signal:AbortSignal.timeout(10000)});
      return value;
    };
    if((await message()).stage!=='ready')throw Error('The owned cgroup probe did not start.');
    let refusedExternalRoot=false;
    try{await group.bind(process.pid);}catch{refusedExternalRoot=true;}
    if(!refusedExternalRoot)throw Error('The kernel probe accepted a root outside the owned server group.');
    await group.bind(child.pid);
    const before=observations.initial=await group.observe();
    assertProbeObservation(before,'initial');
    // This child stays in the driver's sibling cgroup. Its real exit must not
    // invalidate or enter the server's accounting, regardless of host /proc churn.
    outside=spawn(process.execPath,['-e','const end=process.hrtime.bigint()+50000000n;while(process.hrtime.bigint()<end){}'],{stdio:'ignore'});
    outsideClosed=once(outside,'close');
    const [outsideCode,outsideSignal]=await outsideClosed;
    if(outsideCode!==0||outsideSignal!==null)throw Error('The external child probe did not finish normally.');
    const unrelatedExit=observations.unrelatedExit=await group.observe();
    assertProbeObservation(unrelatedExit,'unrelated-exit',{outsidePid:outside.pid});
    let next=message();child.send('work');const worked=await next;
    if(worked.stage!=='worked')throw Error('The owned cgroup probe did not complete CPU work.');
    const live=observations.liveChild=await group.observe();
    assertProbeObservation(live,'live-child');
    next=message();child.send('release');if((await next).stage!=='exited')throw Error('The owned cgroup probe child did not exit.');
    const after=observations.childExited=await group.observe();
    assertProbeObservation(after,'child-exited');
    const summary=summarizeCgroupSamples([before,unrelatedExit,live,after]);
    if(summary.state!=='verified'||!summary.processSetChanged||summary.cpuSeconds<=0||summary.peakObservedMemoryCurrentBytes<=0||!live.pids.includes(worked.pid)||after.pids.includes(worked.pid)||BigInt(after.cpuUsageUsec)<BigInt(live.cpuUsageUsec))throw Error('The kernel did not retain complete owned cgroup accounting after child exit.');
    result={version:2,complete:true,accounting:accounting.provenance,refusedExternalRoot,unrelatedExitVerified:true,unrelatedPid:outside.pid,childExited:true,exitedChildPid:worked.pid,observations,summary};
  }catch(error){failure=error;}
  const cleanup=async(stage,action)=>{try{await action();}catch(error){cleanupFailures.push({stage,message:String(error.message).slice(0,500),code:typeof error.code==='string'?error.code.slice(0,64):null});if(failure){failure.cleanupError=error;failure.message+=' Owned probe cleanup also failed.';}else failure=error;}};
  await cleanup('owned-process-stop',async()=>{
    if(outside&&outside.exitCode===null&&outside.signalCode===null){outside.kill('SIGKILL');await outsideClosed;}
    if(child?.pid&&child.exitCode===null&&child.signalCode===null){
      try{if(child.connected)child.send('stop');await Promise.race([closed,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Owned probe shutdown timed out.');})]);}
      catch(error){try{process.kill(-child.pid,'SIGKILL');}catch(killError){if(killError.code!=='ESRCH')throw killError;}await closed;throw error;}
    }
    if(closed){const [exitCode,signal]=await closed;if(exitCode!==0||signal!==null)throw Error('The owned kernel probe root did not exit normally.');}
  });
  await cleanup('server-cgroup-close',()=>group?.close());
  await cleanup('driver-scope-close',()=>accounting.close());
  if(failure)return {version:2,complete:false,accounting:accounting.provenance,observations,diagnostic:{message:String(failure.message).slice(0,2000),code:typeof failure.code==='string'?failure.code.slice(0,64):null},cleanupFailures};
  return result;
}

if(isMainModule(import.meta.url)){
  const output=process.argv[2];
  if(!output)throw Error('An owned preflight receipt filename is required.');
  let result;
  try{result=await probeCgroupAccounting();if(result.complete!==true)process.exitCode=1;}
  catch(error){result={complete:false,diagnostic:{message:String(error.message).slice(0,2000),code:typeof error.code==='string'?error.code:null}};process.exitCode=1;}
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({complete:result.complete,receipt:output}));
}
