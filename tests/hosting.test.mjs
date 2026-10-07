import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { standaloneFixture, binary, repositoryRoot } from './support.mjs';
import { build } from '../packages/prnext/build/index.mjs';

async function until(check, message) {
  for(let i=0;i<200;i++) { const value=await check();if(value)return value;await delay(50); }
  assert.fail(typeof message==='function'?message():message);
}
test('native host isolates apps, streams requests, evicts idle capacity, sleeps, and recycles excess RSS', {timeout:120000}, async () => {
  const folder=await mkdtemp(path.join(tmpdir(),'prnext-host-'));
  const fixtures=[];let child,closed;let output='';
  const file=path.join(folder,'apps.json'), status=path.join(folder,'apps.status.json');
  async function snapshot(){try{return JSON.parse(await readFile(status,'utf8'));}catch{return null;}}
  try {
    for(const name of ['one','two']) {
      const fixture=await standaloneFixture();fixtures.push(fixture);
      await mkdir(path.join(fixture.root,'pages/api'));
      await writeFile(path.join(fixture.root,'pages/api/state.js'), `export default function handler(req,res){res.json({name:process.env.APP_NAME,host:req.headers.host,worker:process.pid,server:process.ppid,private:process.env.HOST_PRIVATE_SECRET||null})}`);
      await writeFile(path.join(fixture.root,'pages/api/stream.js'), `export default async function handler(req,res){res.setHeader('Content-Type','text/plain');res.write('first');await new Promise(resolve=>setTimeout(resolve,2200));res.end('last')}`);
      await writeFile(path.join(fixture.root,'pages/api/allocate.js'), `export default function handler(req,res){globalThis.allocated=Buffer.alloc(400*1024*1024,1);res.json({allocated:globalThis.allocated.length})}`);
      await build(fixture.root);
    }
    await writeFile(file,JSON.stringify({port:0,memoryMb:256,apps:fixtures.map((fixture,index)=>({name:['one','two'][index],root:path.relative(folder,fixture.root),hosts:[`${['one','two'][index]}.localhost`],memoryMb:256,idleSeconds:1,env:{APP_NAME:['one','two'][index]}}))}));
    child=spawn(binary,['host',file,'--node',process.execPath,'--shutdown-on-stdin-eof'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,HOST_PRIVATE_SECRET:'must-not-inherit'}});
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const address=await until(()=>/http:\/\/(127\.0\.0\.1:\d+)/.exec(output)?.[1],()=>output);
    const get=(name,route,headers={})=>new Promise((resolve,reject)=>{
      const req=request(`http://${address}${route}`,{headers:{host:`${name}.localhost`,...headers},signal:AbortSignal.timeout(20000)},response=>{
        const chunks=[];const body=new Promise((done,fail)=>{response.on('data',chunk=>chunks.push(chunk));response.once('end',()=>done(Buffer.concat(chunks)));response.once('error',fail)});
        resolve({status:response.statusCode,text:async()=>(await body).toString(),json:async()=>JSON.parse((await body).toString()),arrayBuffer:()=>body});
      });req.once('error',reject);req.end();
    });
    assert.equal((await get('unknown','/')).status,421);
    assert.equal((await get('one','/',{upgrade:'websocket',connection:'upgrade'})).status,501);
    const first=await (await get('one','/api/state',{'x-forwarded-host':'two.localhost'})).json();
    assert.equal(first.name,'one');assert.equal(first.host,'one.localhost');assert.equal(first.private,null);
    const stream=await get('one','/api/stream');
    await delay(1100);
    assert.equal((await get('two','/api/state')).status,503,'busy streams retain their memory reservation');
    assert.equal(await stream.text(),'firstlast');
    const second=await (await get('two','/api/state')).json();assert.equal(second.name,'two');assert.notEqual(first.worker,second.worker);
    await until(async()=>{const report=await snapshot();return report?.apps.every(app=>app.pid===null)},()=>output);
    const wake=await (await get('two','/api/state')).json();assert.notEqual(wake.server,second.server);
    const allocated=await get('two','/api/allocate');assert.equal(allocated.status,200);
    await allocated.arrayBuffer();
    await until(async()=>{const report=await snapshot();return report?.apps[1]?.reason.includes('memory budget exceeded')},()=>output);
    assert.equal((await get('two','/api/state')).status,503,'memory violations have a cooldown');
    assert.equal((await get('one','/api/state')).status,200,'another app survives a memory violation');
    child.stdin.end();await closed;
    assert.equal(child.exitCode,0,output);
    await assert.rejects(fetch(`http://${address}/`,{signal:AbortSignal.timeout(1000)}));
    // Abrupt CLI termination still closes the supervisor's stdin pipe and must
    // release every application's process tree on Windows as well as Unix.
    output='';
    child=spawn(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'host',file],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,PRNEXT_BINARY:binary}});
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const restarted=await until(()=>/http:\/\/(127\.0\.0\.1:\d+)/.exec(output)?.[1],()=>output);
    // http.request permits an explicit Host even on Node releases whose fetch
    // implementation always derives it from the URL.
    const ids=await new Promise((resolve,reject)=>{const req=request(`http://${restarted}/api/state`,{headers:{host:'one.localhost'}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{try{resolve(JSON.parse(data))}catch(error){reject(error)}})});req.once('error',reject);req.end()});
    child.kill('SIGKILL');await closed;
    await until(()=>[ids.server,ids.worker].every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'Hosted descendants survived CLI termination');
  } finally {
    if(child?.exitCode===null&&!child.signalCode){if(child.stdin)child.stdin.end();else child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await closed.catch(()=>{});clearTimeout(timer);}
    for(const fixture of fixtures)await fixture.remove();
    await rm(folder,{recursive:true,force:true});
  }
});
