import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn}from'node:child_process';
import{createConnection}from'node:net';
import{randomBytes}from'node:crypto';
import {once}from'node:events';
import {createInterface}from'node:readline';
import {setTimeout as delay}from'node:timers/promises';
import {binary}from'./support.mjs';
import {devFixture}from'./dev-fixture.mjs';

for(const abrupt of [false,true])test(`native dev runtime supervisor ${abrupt?'contains a blocked child on termination':'drains on parent EOF'}`,{timeout:12000,skip:abrupt&&!['linux','win32'].includes(process.platform)},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'prnext-spare-guard-'));let guard,pid;
 try{
  const script=path.join(root,'child.mjs');await writeFile(script,`process.stdin.resume();process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');process.stdin.once('data',()=>{${abrupt?'while(true){}':''}});process.stdin.once('end',()=>process.exit(0));`);
  guard=spawn(binary,['dev-spare',root,'--node',process.execPath,'--script',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});guard.stderr.resume();
  const closed=once(guard,'close'),lines=createInterface({input:guard.stdout});
  const [line]=await once(lines,'line');pid=JSON.parse(line).pid;
  if(abrupt){guard.stdin.write('block\n');await delay(50);guard.kill('SIGKILL');}else guard.stdin.end();
  await closed;
  for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{pid=undefined;break;}await delay(20);}
  assert.equal(pid,undefined,'supervised Node child must not survive its native owner');
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}if(guard&&guard.exitCode===null)guard.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});

test('authenticated native control reaps a development worker with a blocked JS loop',{timeout:12000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'prnext-spare-force-')),token=randomBytes(32).toString('base64url');let guard,pid,socket;
 try{
  const script=path.join(root,'child.mjs');await writeFile(script,`process.stdin.resume();process.stdout.write(JSON.stringify({type:'warm',port:1234,pid:process.pid})+'\\n');process.stdin.once('data',()=>{while(true){}});`);
  guard=spawn(binary,['dev-spare',root,'--node',process.execPath,'--script',script],{env:{...process.env,PRNEXT_DEV_SPARE_TOKEN:token},stdio:['pipe','pipe','pipe'],windowsHide:true});guard.stderr.resume();
  const closed=once(guard,'close'),lines=createInterface({input:guard.stdout}),[line]=await once(lines,'line'),ready=JSON.parse(line);pid=ready.pid;
  guard.stdin.write('block\n');await delay(50);
  socket=createConnection({host:'127.0.0.1',port:ready.guardPort});await once(socket,'connect');const response=once(socket,'data');socket.write(token+'\n');
  assert.equal(String((await response)[0]),'stopped\n');await closed;
  assert.throws(()=>process.kill(pid,0));pid=undefined;
 }finally{socket?.destroy();if(pid)try{process.kill(pid,'SIGKILL');}catch{}if(guard?.exitCode===null)guard.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});

test('development generation retirement drains after() cache work before closing the native cache bridge',{timeout:45000},async()=>{
 const fixture=await devFixture({files:{'app/api/background/route.js':`import{after}from'next/server';import{writeFile,access}from'node:fs/promises';export const dynamic='force-dynamic';export function GET(){after(async()=>{for(let i=0;i<400;i++){if(await access('.release-after').then(()=>true,()=>false))break;await new Promise(resolve=>setTimeout(resolve,50));}const response=await fetch(process.env.PRNEXT_CACHE_URL,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.PRNEXT_CACHE_TOKEN},body:JSON.stringify({op:'generation'})});if(!response.ok)throw Error('Cache bridge closed during after work');await writeFile('.after-finished','done');});return new Response('queued');}`}});
 try{
  const response=await fetch(fixture.url+'/docs/api/background');assert.equal(await response.text(),'queued');
  const before=JSON.parse(await fixture.read('.prnext-dev.json'));
  await fixture.write('pages/pages.jsx',(await fixture.read('pages/pages.jsx')).replace('page-server-one','page-server-two'));
  let ready;for(let i=0;i<400;i++){ready=JSON.parse(await fixture.read('.prnext-dev.json'));if(ready.state==='ready'&&ready.buildId!==before.buildId)break;await delay(50);}
  assert.notEqual(ready.buildId,before.buildId);await fixture.write('.release-after','ready');
  for(let i=0;i<100;i++){if(await fixture.read('.after-finished').catch(()=>undefined)==='done')break;await delay(50);}
  assert.equal(await fixture.read('.after-finished').catch(()=>fixture.output()),'done');
 }finally{await fixture.close();}
});
