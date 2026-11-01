import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCgroupAccounting, parseCgroupCounters, summarizeCgroupSamples, startCgroupSampling } from './cgroup-accounting.mjs';
import {assertProbeObservation} from './cgroup-accounting-probe.mjs';

const scopeName='prnext-performance-1-1.scope', root='/sys/fs/cgroup/owned/'+scopeName;
const stat=(pid,parent,startId)=>{
  const fields=Array(22).fill('0');Object.assign(fields,{0:'S',1:String(parent),19:String(startId),21:'1'});
  return `${pid} (discarded private name) ${fields.join(' ')}`;
};
const cpu=value=>`usage_usec ${value}\nuser_usec ${value}\nsystem_usec 0\n`;
const counters=()=>({cpu:cpu(1000000),memory:'12345\n',events:'populated 1\nfrozen 0\n',memoryEvents:'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',processes:'21\n20\n'});
const frame=(overrides={})=>({state:'verified',at:new Date(1000).toISOString(),rootPid:20,rootStartId:'200',group:'/owned/'+scopeName+'/server-0-baseline-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',groupIdentity:'2:100',...parseCgroupCounters(counters()),...overrides});

// Kernel-file adapter, not an implementation replica: cgroup membership writes
// move a PID, expose counters/events, and rmdir refuses live groups. Injected
// errors occur on the actual I/O boundary exercised by the production helper.
function kernelFiles(){
  const files=new Map(),directories=new Map([[root,1]]),reads=[],writes=[],removed=[];let nextInode=1,hook;
  const missing=()=>Object.assign(Error('private details must not escape'),{code:'ENOENT'});
  const addGroup=directory=>{
    directories.set(directory,++nextInode);
    for(const [name,value]of Object.entries({'cgroup.procs':'','cgroup.events':'populated 0\n','cpu.stat':cpu(0),'memory.current':'0\n','memory.events':'oom 0\noom_kill 0\n'}))files.set(posix.join(directory,name),value);
  };
  const refresh=directory=>files.set(posix.join(directory,'cgroup.events'),`populated ${files.get(posix.join(directory,'cgroup.procs'))?.trim()?1:0}\n`);
  const exit=pid=>{
    for(const directory of directories.keys()){
      const name=posix.join(directory,'cgroup.procs');
      if(files.has(name)){files.set(name,files.get(name).split(/\s+/).filter(value=>value&&value!==String(pid)).join('\n'));refresh(directory);}
    }
    files.delete(`/proc/${pid}/stat`);files.delete(`/proc/${pid}/cgroup`);
  };
  const move=(pid,directory)=>{
    for(const previous of directories.keys()){
      const name=posix.join(previous,'cgroup.procs');
      if(files.has(name)){files.set(name,files.get(name).split(/\s+/).filter(value=>value&&value!==String(pid)).join('\n'));refresh(previous);}
    }
    const name=posix.join(directory,'cgroup.procs');files.set(name,files.get(name)+'\n'+pid);refresh(directory);
    files.set(`/proc/${pid}/cgroup`,'0::'+directory.slice('/sys/fs/cgroup'.length)+'\n');
  };
  files.set('/proc/self/cgroup','0::/owned/'+scopeName+'\n');
  files.set('/proc/self/mountinfo','1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n');
  files.set(posix.join(root,'cgroup.type'),'domain\n');files.set(posix.join(root,'cgroup.controllers'),'cpu memory io\n');
  files.set(posix.join(root,'cgroup.subtree_control'),'');files.set(posix.join(root,'cgroup.procs'),'11\n');
  for(const [pid,parent,start]of [[11,1,100],[20,11,200],[21,20,210]])files.set(`/proc/${pid}/stat`,stat(pid,parent,start));
  const io={
    async readFile(file){reads.push(file);hook?.(file);if(!files.has(file))throw missing();return files.get(file);},
    async realpath(file){return file;},
    async mkdir(directory){if(directories.has(directory))throw Object.assign(Error('exists'),{code:'EEXIST'});addGroup(directory);},
    async readdir(directory){return [...directories.keys()].filter(name=>name!==directory&&posix.dirname(name)===directory).map(name=>({name:posix.basename(name),isDirectory:()=>true}));},
    async lstat(directory){if(!directories.has(directory))throw missing();return {dev:2n,ino:BigInt(directories.get(directory)),isDirectory:()=>true,isSymbolicLink:()=>false};},
    async writeFile(file,value){writes.push([file,value]);if(file.endsWith('/cgroup.procs'))move(Number(value),posix.dirname(file));else files.set(file,value.replaceAll('+','').replaceAll('-cpu -memory',''));},
    async rmdir(directory){if(files.get(posix.join(directory,'cgroup.procs'))?.trim())throw Object.assign(Error('live'),{code:'EBUSY'});removed.push(directory);directories.delete(directory);for(const name of files.keys())if(posix.dirname(name)===directory)files.delete(name);},
  };
  return {io,files,directories,reads,writes,removed,exit,move,hook(value){hook=value;}};
}
async function owned(){
  const fs=kernelFiles(),accounting=await createCgroupAccounting({scopeName,io:fs.io,selfPid:11});
  const group=await accounting.createServerGroup('0-baseline');
  const launch=group.launch('/verified/native',['start','a path; $(never execute)']);
  const directory=launch.args[3];fs.move(20,directory);await group.bind(20);
  return {...fs,accounting,group,directory,launch,async close(){fs.hook(undefined);fs.exit(20);fs.exit(21);await group.close();await accounting.close();}};
}

test('cgroup parsing requires every kernel counter and bounded unambiguous membership',()=>{
  assert.deepEqual(parseCgroupCounters(counters()),{cpuUsageUsec:'1000000',memoryCurrentBytes:12345,populated:1,oom:'0',oomKill:'0',pids:[20,21]});
  for(const mutate of [value=>{value.cpu='user_usec 1\nsystem_usec 0\n';},value=>{value.cpu+=cpu(1);},value=>{value.memory='9007199254740992';},value=>{value.processes='20 20';},value=>{value.processes='20 invalid';},value=>{value.memoryEvents='oom 0';},value=>{value.events='populated 2';}]){
    const value=counters();mutate(value);assert.throws(()=>parseCgroupCounters(value));
  }
});

test('documented dotted kernel counters are accepted without weakening required values or duplicate rejection',()=>{
  const value=counters();value.cpu+='core_sched.force_idle_usec 0\n';
  assert.equal(parseCgroupCounters(value).cpuUsageUsec,'1000000');
  for(const suffix of ['core_sched.force_idle_usec 1\ncore_sched.force_idle_usec 2\n','core_sched.force_idle_usec invalid\n','core_sched..force_idle_usec 0\n',`${'x'.repeat(65)} 0\n`]){
    const bad=counters();bad.cpu+=suffix;assert.throws(()=>parseCgroupCounters(bad));
  }
  const missing=counters();missing.cpu='user_usec 1\nsystem_usec 0\ncore_sched.force_idle_usec 0\n';assert.throws(()=>parseCgroupCounters(missing));
});

test('kernel CPU includes a departed child while sampled memory retains its distinct meaning',()=>{
  const first=frame(),last=frame({at:new Date(3000).toISOString(),pids:[20],cpuUsageUsec:'1500000',memoryCurrentBytes:10000});
  const value=summarizeCgroupSamples([first,last]);
  assert.equal(value.state,'verified');assert.equal(value.cpuSeconds,.5);assert.equal(value.processSetChanged,true);
  assert.equal(value.peakObservedMemoryCurrentBytes,12345);assert.equal(Object.hasOwn(value,'peakRssBytes'),false);
  assert.match(value.limitations.join(' '),/neither summed RSS nor an exact interval peak/);
});

test('identity reuse, missing reads, CPU regression, OOM and caps never certify kernel accounting',()=>{
  const first=frame(),last=frame({at:new Date(3000).toISOString(),cpuUsageUsec:'1500000'});
  for(const change of [{groupIdentity:'2:101'},{rootStartId:'201'},{cpuUsageUsec:'1'},{oom:'1'},{oomKill:'1'},{state:'unknown',cpuUsageUsec:null,memoryCurrentBytes:null,failure:{operation:'read',code:'ENOENT'}}]){
    const value=summarizeCgroupSamples([first,{...last,...change}]);assert.equal(value.state,'unknown');assert.equal(value.cpuSeconds,null);assert.equal(value.peakObservedMemoryCurrentBytes,null);
  }
  assert.equal(summarizeCgroupSamples([first,last],{limitReached:true}).state,'unknown');
  assert.equal(summarizeCgroupSamples([first]).state,'unknown');
  for(const change of [{pids:[20,20]},{cpuUsageUsec:'-1'},{memoryCurrentBytes:1.5},{populated:0},{pids:[21]}])assert.throws(()=>summarizeCgroupSamples([first,{...last,...change}]));
});

test('only a canonical exclusive explicitly named scope can enable child accounting',async()=>{
  for(const configure of [fs=>fs.files.set('/proc/self/cgroup','0::/unrelated.scope\n'),fs=>fs.files.set(root+'/cgroup.procs','11\n99'),fs=>fs.files.set(root+'/cgroup.controllers','cpu'),fs=>fs.files.set(root+'/cgroup.subtree_control','cpu'),fs=>{fs.io.realpath=async()=>'/elsewhere';}]){
    const fs=kernelFiles();configure(fs);await assert.rejects(createCgroupAccounting({scopeName,io:fs.io,selfPid:11}));assert.deepEqual(fs.writes,[]);
  }
  await assert.rejects(createCgroupAccounting({scopeName:'arbitrary.scope'}));
});

test('owned launch is before exec with structured arguments; external exits are never inspected',async()=>{
  const value=await owned();
  try{
    assert.equal(value.launch.command,'/bin/sh');assert.deepEqual(value.launch.args.slice(4),['/verified/native','start','a path; $(never execute)']);
    assert.match(value.launch.args[1],/cgroup.procs.*exec/);
    await assert.rejects(value.group.bind(99));
    const sample=await value.group.observe();assert.equal(sample.state,'verified');assert.deepEqual(sample.pids,[20]);
    assert.equal(value.reads.some(file=>/^\/proc\/(?:99|30)\//.test(file)),false);
    assert.equal(value.reads.includes('/proc'),false);
    assert.equal(value.files.get(root+'/cgroup.procs').trim(),'');
  }finally{await value.close();}
  assert.equal(value.files.get(root+'/cgroup.procs').trim(),'11');assert.equal(value.files.get(root+'/cgroup.subtree_control'),'');
});

test('real I/O errors, root migration/reuse and replaced cgroup identities remain explicit unknown',async()=>{
  const value=await owned();
  try{
    value.hook(file=>{if(file===value.directory+'/cpu.stat')throw Object.assign(Error('secret must not escape'),{code:'EIO'});});
    const failed=await value.group.observe();assert.equal(failed.state,'unknown');assert.deepEqual(failed.failure,{operation:'counters',code:'EIO',reason:'read-failed'});assert.equal(JSON.stringify(failed).includes('secret'),false);
    value.hook(undefined);value.files.set('/proc/20/stat',stat(20,11,201));assert.equal((await value.group.observe()).state,'unknown');
    value.files.set('/proc/20/stat',stat(20,11,200));value.files.set('/proc/20/cgroup','0::/outside\n');assert.equal((await value.group.observe()).state,'unknown');
    value.files.set('/proc/20/cgroup','0::'+value.directory.slice('/sys/fs/cgroup'.length)+'\n');
    value.directories.set(value.directory,999);assert.equal((await value.group.observe()).state,'unknown');value.directories.set(value.directory,3);
  }finally{await value.close();}
});

test('a failed kernel counter retains its bounded file/key/reason and is not called an outside PID',async()=>{
  const value=await owned();
  try{
    value.files.set(value.directory+'/cpu.stat',cpu(0)+'core_sched.force_idle_usec 0\ncore_sched.force_idle_usec 1\n');
    const observed=await value.group.observe();
    assert.equal(observed.state,'unknown');assert.deepEqual(observed.failure,{operation:'counters',code:'INVALID',reason:'duplicate-counter',file:'cpu.stat',key:'core_sched.force_idle_usec'});
    assert.throws(()=>assertProbeObservation(observed,'initial',{outsidePid:99}),/observation was incomplete at initial/);
    assert.throws(()=>assertProbeObservation(frame(),'unrelated-exit',{outsidePid:21}),/outside PID was present/);
    assert.doesNotThrow(()=>assertProbeObservation(frame(),'unrelated-exit',{outsidePid:99}));
    const retained=JSON.parse(JSON.stringify({complete:false,observations:{initial:observed}}));
    assert.deepEqual(retained.observations.initial.failure,observed.failure);
    assert.equal(summarizeCgroupSamples([observed,observed]).state,'unknown');
    const corrupt=structuredClone(observed);corrupt.failure.key='arbitrary data with spaces';assert.throws(()=>summarizeCgroupSamples([corrupt,corrupt]),/diagnostics/);
  }finally{await value.close();}
});

test('teardown waits for live membership to drain before removing only owned groups',async()=>{
  const value=await owned();let reads=0;
  value.hook(file=>{if(file===value.directory+'/cgroup.procs'&&++reads===2)value.exit(20);});
  await value.group.close();assert.ok(reads>=2);assert.deepEqual(value.removed,[value.directory]);
  await value.accounting.close();assert.equal(value.removed.length,2);assert.equal(value.files.get(root+'/cgroup.procs').trim(),'11');
});

test('an accounting enable failure restores this driver and never migrates another PID',async()=>{
  const fs=kernelFiles(),write=fs.io.writeFile;
  fs.io.writeFile=async(file,value)=>{if(value==='+cpu +memory')throw Object.assign(Error('denied'),{code:'EPERM'});return write(file,value);};
  await assert.rejects(createCgroupAccounting({scopeName,io:fs.io,selfPid:11}),error=>error.code==='EPERM');
  assert.equal(fs.files.get(root+'/cgroup.procs').trim(),'11');assert.equal(fs.writes.filter(([name])=>name.endsWith('/cgroup.procs')).every(([,value])=>value==='11'),true);
  assert.equal([...fs.directories.keys()].length,1);
});

test('serial cgroup sampling starts before load and stops idempotently without hiding failed reads',async()=>{
  let calls=0,active=0,max=0;
  const sampler=startCgroupSampling({async observe(){active++;max=Math.max(max,active);try{await delay(2);calls++;return frame({at:new Date(1000+calls).toISOString(),cpuUsageUsec:String(1000000+calls)});}finally{active--;}}},{intervalMs:1});
  await sampler.ready;assert.equal(calls,1);await delay(8);
  const stopping=sampler.stop();assert.equal(sampler.stop(),stopping);const value=await stopping;
  assert.equal(value.state,'verified');assert.equal(max,1);const count=calls;await delay(5);assert.equal(calls,count);
});

test('an unexpected observer rejection cannot become a complete cgroup summary',async()=>{
  const error=Error('owned observer failed');
  const sampler=startCgroupSampling({async observe(){throw error;}});
  await assert.rejects(sampler.ready,value=>value===error);
  await assert.rejects(sampler.stop(),value=>value===error);
});
