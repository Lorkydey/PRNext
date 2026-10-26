import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {credentialPath,writeState} from './cloud/state.mjs';
import {startDevHostRelay} from './dev-host-relay.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-host-relay-')),env={PRNEXT_CLOUD_HOME:path.join(root,'credentials'),PRNEXT_CLOUD_URL:'https://host.example.test'};
  t.after(()=>rm(root,{recursive:true,force:true}));
  const logs=[],executed=[],tools={session:'local-development',addServerLog:(...args)=>logs.push(args),executeTool:async(...args)=>{executed.push(args);return {sequence:3,state:'ready'};}};
  return {root,env,logs,executed,tools};
}
const reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('Host relay is opt-in and missing login never sends a request or stops local tools',async t=>{
  const f=await fixture(t);let called=false;
  const relay=await startDevHostRelay({...f,fetcher:()=>{called=true;throw Error('Not expected');}});await relay.close();
  assert.equal(called,false);assert.match(f.logs[0][1],/Run prnext login/);
});
test('outbound relay reuses CLI login, never sends the local capability, and rejects unknown tools',async t=>{
  const f=await fixture(t),token='prn_'+'A'.repeat(43),requests=[],results=[];let polled=0;
  await writeState(credentialPath(f.env.PRNEXT_CLOUD_URL,f.env),{origin:f.env.PRNEXT_CLOUD_URL,accessToken:token,expiresAt:Date.now()+60000});
  f.tools.token='LOCAL_CAPABILITY_MUST_NOT_LEAVE';
  const fetcher=async(url,init)=>{
    const request=new Request(url,init),body=JSON.parse(await request.text());requests.push({path:new URL(url).pathname,body});assert.equal(request.headers.get('authorization'),'Bearer '+token);
    if(url.endsWith('/register'))return reply({id:'relay-id'});
    if(url.endsWith('/poll')){polled++;return reply({commands:polled===1?[{id:'bad',tool:'run_shell',args:{command:'bad'},expiresAt:Date.now()+30000}]:polled===2?[{id:'good',tool:'dev_snapshot',args:{},client:'Existing assistant',expiresAt:Date.now()+30000}]:[]});}
    if(url.endsWith('/result')){results.push(body);return reply({ok:true});}
    if(url.endsWith('/close'))return reply({ok:true});throw Error('Unexpected endpoint');
  };
  const relay=await startDevHostRelay({...f,fetcher,interval:5});t.after(()=>relay.close());
  for(let i=0;i<100&&results.length<2;i++)await delay(5);
  await relay.close();assert.equal(results.length,2);assert.match(results[0].error,/Unsupported/);assert.equal(results[1].result.sequence,3);
  assert.equal(f.executed.length,1);assert.deepEqual(f.executed[0],['dev_snapshot',{}, {client:'Host MCP: Existing assistant'}]);
  assert.ok(!JSON.stringify(requests).includes(f.tools.token));assert.ok(requests.some(request=>request.path.endsWith('/close')));
});
test('an older Host returns a clear unavailable message without disrupting local MCP',async t=>{
  const f=await fixture(t);await writeState(credentialPath(f.env.PRNEXT_CLOUD_URL,f.env),{origin:f.env.PRNEXT_CLOUD_URL,accessToken:'prn_'+'B'.repeat(43),expiresAt:Date.now()+60000});
  const relay=await startDevHostRelay({...f,fetcher:async()=>new Response(JSON.stringify({error:{message:'Not found'}}),{status:404,headers:{'content-type':'application/json'}})});
  await relay.close();assert.match(f.logs[0][1],/needs the local development relay update/);assert.equal(f.executed.length,0);
});
