import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {standaloneFixture,startServer,repositoryRoot} from './support.mjs';

async function fixture(memory) {
  const value=await standaloneFixture();
  try {
    const files={
      'prnext.config.mjs':`export default{workerRetirement:{keepWarm:true}${memory?',workerMemory:{maxRssMb:128}':''}}`,
      'pages/api/id.js':`export default(req,res)=>res.json({pid:process.pid,rss:process.memoryUsage().rss})`,
      'pages/api/allocate.js':`export default(req,res)=>{globalThis.__buffers||=[];globalThis.__buffers.push(Buffer.alloc(160*1024*1024,37));res.json({pid:process.pid,rss:process.memoryUsage().rss})}`,
      'pages/api/hold.js':`import{existsSync}from'node:fs';export default async(req,res)=>{res.setHeader('content-type','text/plain');res.write(String(process.pid)+'\\n');const until=Date.now()+20000;while(!existsSync('release-hold')&&Date.now()<until)await new Promise(r=>setTimeout(r,20));res.end('finished')}`,
      'pages/api/crash.js':`import{appendFileSync}from'node:fs';export default()=>{appendFileSync('crashes.jsonl',JSON.stringify({pid:process.pid,time:Date.now()})+'\\n');process.exit(17)}`,
    };
    for(const [name,source]of Object.entries(files)){const file=path.join(value.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',value.root],{maxBuffer:4*1024*1024});
    return value;
  } catch(error){await value.remove();throw error;}
}
test('soft RSS retirement replaces a production host while its existing stream finishes',{timeout:90000},async()=>{
  const value=await fixture(true);let server,reader,secondReader;
  try {
    server=await startServer(value.root,['--workers','1']);
    const held=await fetch(server.url+'/api/hold');reader=held.body.getReader();
    const first=await reader.read(),oldPid=Number(Buffer.from(first.value).toString().trim());assert.ok(oldPid>0);
    const allocation=await(await fetch(server.url+'/api/allocate')).json();assert.equal(allocation.pid,oldPid);assert.ok(allocation.rss>128*1024*1024);
    let newPid=oldPid;
    for(let i=0;i<70&&newPid===oldPid;i++){await delay(100);newPid=(await(await fetch(server.url+'/api/id')).json()).pid;}
    assert.notEqual(newPid,oldPid,'the high-RSS host stops accepting new requests');
    const secondHeld=await fetch(server.url+'/api/hold');secondReader=secondHeld.body.getReader();assert.equal(Number(Buffer.from((await secondReader.read()).value).toString().trim()),newPid);
    const second=await(await fetch(server.url+'/api/allocate')).json();assert.equal(second.pid,newPid);
    assert.ok(second.rss>128*1024*1024);
    for(let i=0;i<100&&(server.output().match(/draining Node worker above its soft RSS budget/g)||[]).length<2;i++)await delay(100);
    assert.equal((server.output().match(/draining Node worker above its soft RSS budget/g)||[]).length,2,server.output());
    let completed=false;const replacement=fetch(server.url+'/api/id').then(async response=>({status:response.status,...await response.json()})).then(value=>{completed=true;return value;});
    await delay(300);if(completed)console.error(JSON.stringify({oldPid,newPid,second,third:await replacement,logs:server.output()}));assert.equal(completed,false,'a third process generation must wait while both previous hosts drain');
    await writeFile(path.join(value.root,'release-hold'),'go');
    let tail='';for(;;){const item=await reader.read();if(item.done)break;tail+=Buffer.from(item.value).toString();}
    assert.equal(tail,'finished','retirement must not kill the active response');
    let secondTail='';for(;;){const item=await secondReader.read();if(item.done)break;secondTail+=Buffer.from(item.value).toString();}assert.equal(secondTail,'finished');
    const third=await replacement;assert.notEqual(third.pid,newPid);assert.notEqual(third.pid,oldPid);
    assert.equal((await(await fetch(server.url+'/api/id')).json()).pid,third.pid,'a healthy replacement remains reusable');
  } finally {await writeFile(path.join(value.root,'release-hold'),'go').catch(()=>{});await reader?.cancel().catch(()=>{});await secondReader?.cancel().catch(()=>{});await server?.close();await value.remove();}
});
test('repeated production crashes cool down new starts without replaying a mutation',{timeout:90000},async()=>{
  const value=await fixture(false);let server;
  try {
    server=await startServer(value.root,['--workers','1']);
    for(let i=0;i<6;i++){
      const response=await fetch(server.url+'/api/crash',{method:'POST',signal:AbortSignal.timeout(15000)});await response.body?.cancel();assert.ok(response.status>=500);
    }
    const crashes=(await readFile(path.join(value.root,'crashes.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(crashes.length,6,'each POST must run exactly once');
    assert.equal(new Set(crashes.map(row=>row.pid)).size,6);
    assert.ok(crashes[5].time-crashes[0].time>=2500,'restarts must be progressively delayed');
    const healthy=await fetch(server.url+'/api/id',{signal:AbortSignal.timeout(15000)});assert.equal(healthy.status,200);await healthy.body?.cancel();
  } finally {await server?.close();await value.remove();}
});
