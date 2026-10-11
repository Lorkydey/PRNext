import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { standaloneFixture, startServer, repositoryRoot } from './support.mjs';
let fixture;
before(async()=>{
  fixture=await standaloneFixture('prnext-retirement-');
  await mkdir(path.join(fixture.root,'pages/api'),{recursive:true});
  await writeFile(path.join(fixture.root,'pages/api/pid.js'),"export default function(req,res){res.setHeader('Cache-Control','private, no-store');res.json({pid:process.pid,nonce:crypto.randomUUID(),user:req.cookies.user||'anonymous'})}");
  await writeFile(path.join(fixture.root,'next.config.mjs'),"export default {workerRetirement:{idleSeconds:1,laneIdleSeconds:1,keepWarm:false}}");
  await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root]);
});
after(async()=>fixture?.remove());
const value=async(server,user='probe')=>{const r=await fetch(server.url+'/api/pid',{headers:{cookie:'user='+user}});assert.equal(r.status,200);const value=await r.json();assert.equal(value.user,user);return value};
test('configuration, environment and CLI implement the documented retirement precedence',async()=>{
  const cases=[
    {args:[],env:{},retires:true},
    {args:[],env:{PRNEXT_WORKER_IDLE_SECONDS:'0'},retires:false},
    {args:['--worker-idle-seconds','1'],env:{PRNEXT_WORKER_IDLE_SECONDS:'0'},retires:true},
    {args:['--keep-warm'],env:{PRNEXT_KEEP_WARM:'false'},retires:false},
    {args:['--keep-warm','false'],env:{PRNEXT_KEEP_WARM:'true'},retires:true},
    {args:['--worker-idle-seconds','0','--lane-idle-seconds','0'],env:{},retires:false},
  ];
  for(const config of cases){
    const server=await startServer(fixture.root,config.args,config.env);
    try {const first=await value(server);await delay(2300);const second=await value(server);assert.notEqual(first.nonce,second.nonce);assert.equal(first.pid!==second.pid,config.retires,JSON.stringify(config));}
    finally{await server.close();}
  }
});
test('concurrent requests after retirement all succeed with one fresh host and isolated cookies',async()=>{
  const server=await startServer(fixture.root);
  try {
    let previous=(await value(server)).pid;
    for(let cycle=0;cycle<3;cycle++){
      await delay(2300);
      const replies=await Promise.all(Array.from({length:64},(_,index)=>value(server,'user'+index)));
      assert.equal(new Set(replies.map(r=>r.pid)).size,1);assert.equal(new Set(replies.map(r=>r.nonce)).size,64);assert.notEqual(replies[0].pid,previous);previous=replies[0].pid;
    }
  }finally{await server.close();}
});
test('invalid retirement settings fail instead of silently selecting a profile default',async()=>{
  for(const env of [{PRNEXT_WORKER_IDLE_SECONDS:''},{PRNEXT_WORKER_IDLE_SECONDS:'-1'},{PRNEXT_LANE_IDLE_SECONDS:'1.5'},{PRNEXT_KEEP_WARM:'yes'}])await assert.rejects(startServer(fixture.root,[],env),/must be/);
  await assert.rejects(startServer(fixture.root,['--worker-idle-seconds','604801']),/604800/);
});
