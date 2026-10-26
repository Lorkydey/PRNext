import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {createDevToolsServer} from './dev-tools-server.mjs';
import {createDevAssistantLease,runDevMcp} from './dev-tools-mcp.mjs';

async function waitFor(check,message='Expected asynchronous result'){
  const until=Date.now()+3000;
  while(Date.now()<until){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail(message);
}
async function fixture(t,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-mcp-lifecycle-'));
  const tools=await createDevToolsServer({root,session:'mcp-lifecycle-test',...options});tools.setAppUrl('http://127.0.0.1:3000');
  t.after(async()=>{await tools.close();await rm(root,{recursive:true,force:true});});
  const post=(endpoint,body={},headers={})=>fetch(tools.endpoint+endpoint,{method:'POST',headers:{Authorization:'Bearer '+tools.token,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const connection=()=>tools.executeTool('dev_connection');
  return {root,tools,post,connection};
}
function stdio(root,options={}){
  const input=new PassThrough(),replies=[];let id=0,buffer='',failure;
  const output=new Writable({write(chunk,encoding,next){
    buffer+=chunk;
    for(let split;(split=buffer.indexOf('\n'))!==-1;){replies.push(JSON.parse(buffer.slice(0,split)));buffer=buffer.slice(split+1);}
    next();
  }});
  const done=runDevMcp(root,{input,output,...options}).catch(error=>{failure=error;});
  const send=value=>input.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  async function rpc(method,params){const requestId=++id;send({id:requestId,method,params});return waitFor(()=>replies.find(reply=>reply.id===requestId),'MCP reply for '+method);}
  return {input,replies,rpc,send,
    async initialize(name='Test assistant'){
      const reply=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name,version:'1.0.0'}});assert.equal(reply.result.protocolVersion,'2025-06-18');
      send({method:'notifications/initialized'});const list=await rpc('tools/list');assert.ok(list.result.tools.some(tool=>tool.name==='dev_connection'));
    },
    async close(){if(!input.writableEnded)input.end();await done;if(failure)throw failure;assert.equal(buffer,'');},
  };
}

test('initialized stdio alone connects, leased tool calls do not linger after EOF',async t=>{
  const {root,tools,post,connection}=await fixture(t),session=stdio(root);
  try{
    await session.rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'Actual initialized assistant'}});
    assert.equal((await connection()).connected,false,'initialize response alone is not the completed MCP handshake');
    session.send({method:'notifications/initialized'});await session.rpc('tools/list');
    let state=await connection();assert.equal(state.connected,true);assert.equal(state.initialized,true);assert.equal(state.client,'Actual initialized assistant');assert.equal(state.clients.length,1);
    assert.doesNotMatch(JSON.stringify(state),/leaseId|instanceId|"token"/);
    const called=await session.rpc('tools/call',{name:'dev_connection'});assert.equal(called.result.structuredContent.connected,true);
    const queued=await post('/v1/tools/dev_ai_context',{kind:'selection',context:{label:'Save'}},{Origin:'http://localhost:3000'});assert.equal(queued.status,200);
    await session.close();state=await connection();assert.equal(state.connected,false);assert.equal(state.initialized,false);assert.equal(state.lastActivity,null,'leased calls never populate the legacy Host activity grace period');
    const refused=await post('/v1/tools/dev_ai_context',{kind:'selection',context:{label:'Another element'}},{Origin:'http://localhost:3000'});assert.equal(refused.status,409);assert.equal((await refused.json()).code,'assistant_required');
    assert.equal((await tools.executeTool('dev_snapshot')).ai.contexts.length,1,'disconnected attempts do not enqueue');
  }finally{await session.close();}
});

test('stdio rejects tools before initialized notification and ignores out-of-order initialization',async t=>{
  const {root,connection}=await fixture(t),session=stdio(root);
  try{
    session.send({method:'notifications/initialized'});
    assert.equal((await session.rpc('tools/list')).error.code,-32002);
    await session.rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'Handshake required'}});
    assert.equal((await session.rpc('tools/call',{name:'dev_connection'})).error.code,-32002);assert.equal((await connection()).connected,false);
    session.send({method:'notifications/initialized'});await session.rpc('tools/list');assert.equal((await connection()).connected,true);
  }finally{await session.close();}
});

test('independent initialized assistants disconnect without revoking the other session',async t=>{
  const {root,connection}=await fixture(t),left=stdio(root),right=stdio(root);
  try{
    await left.initialize('Left assistant');await right.initialize('Right assistant');assert.equal((await connection()).clients.length,2);
    await left.close();let state=await connection();assert.equal(state.connected,true);assert.deepEqual(state.clients.map(value=>value.client),['Right assistant']);
    await right.close();state=await connection();assert.equal(state.connected,false);assert.equal(state.clients.length,0);
    const fresh=stdio(root);try{await fresh.initialize('Reconnected assistant');assert.equal((await connection()).connected,true);}finally{await fresh.close();}
    assert.equal((await connection()).connected,false);
  }finally{await left.close();await right.close();}
});

test('idle initialized stdio renews a bounded lease beyond the legacy activity window',async t=>{
  let clock=100000,heartbeats=0;
  const {root,connection}=await fixture(t,{now:()=>clock});
  const assistant=createDevAssistantLease(root,{heartbeatMs:20,fetcher:async(...args)=>{const body=JSON.parse(args[1].body),response=await fetch(...args);if(body.event==='heartbeat')heartbeats++;return response;}});
  const session=stdio(root,{assistant});
  try{
    await session.initialize('Idle assistant');
    for(let i=0;i<4;i++){
      const previous=heartbeats;clock+=20000;await waitFor(()=>heartbeats>previous);
      assert.equal((await connection()).connected,true);
    }
    const state=await connection();assert.equal(state.lastActivity,100000);assert.equal(state.initialized,true);
    await session.close();assert.equal((await connection()).connected,false);
  }finally{await session.close();}
});

test('assistant lifecycle is native-only, bounded, independently leased and expires honestly',async t=>{
  let clock=1000;const {post,connection}=await fixture(t,{now:()=>clock});
  const body={event:'register',instanceId:'native-assistant-0001',client:'Native assistant'};
  const browser=await post('/v1/assistant',body,{Origin:'http://localhost:3000'});assert.equal(browser.status,403);assert.equal((await browser.json()).code,'native_assistant_required');
  assert.equal((await post('/v1/assistant',body,{Authorization:'Bearer wrong'})).status,401);
  assert.equal((await post('/v1/assistant',{...body,command:'anything'})).status,400);
  assert.equal((await post('/v1/assistant',{...body,client:'bad\nclient'})).status,400);
  const registered=await (await post('/v1/assistant',body)).json();assert.equal(registered.leaseMs,30000);assert.equal((await connection()).initialized,true);
  const bad=await post('/v1/assistant',{event:'unregister',instanceId:body.instanceId,leaseId:'wrong-lease'});assert.equal(bad.status,404);assert.equal((await connection()).connected,true);
  clock+=30001;assert.equal((await connection()).connected,false);
  const stale=await post('/v1/assistant',{event:'heartbeat',instanceId:body.instanceId,leaseId:registered.leaseId});assert.equal(stale.status,404);assert.equal((await stale.json()).code,'assistant_lease_expired');
  for(let i=0;i<16;i++)assert.equal((await post('/v1/assistant',{...body,instanceId:'native-assistant-'+String(i).padStart(4,'0')})).status,200);
  assert.equal((await connection()).clients.length,16);
  const overflow=await post('/v1/assistant',{...body,instanceId:'native-assistant-overflow'});assert.equal(overflow.status,429);assert.equal((await overflow.json()).code,'assistant_limit');
});

test('an initialized adapter recovers expired leases and a restarted development sidecar',async t=>{
  let clock=1000;const {root,tools,connection}=await fixture(t,{now:()=>clock});
  const assistant=createDevAssistantLease(root,{heartbeatMs:20});let replacement;
  try{
    await assistant.start({name:'Persistent initialized assistant'});assert.equal((await connection()).connected,true);
    clock+=30001;assert.equal((await connection()).connected,false);
    assert.equal((await assistant.call('dev_connection')).initialized,true,'a rejected expired-lease tool can safely reinitialize before execution');
    await tools.close();replacement=await createDevToolsServer({root,session:'restarted-session'});replacement.setAppUrl('http://127.0.0.1:3000');
    await waitFor(async()=>(await replacement.executeTool('dev_connection')).initialized,'heartbeat should reread the new private capability');
    const result=await assistant.call('dev_connection');assert.equal(result.session,'restarted-session');assert.equal(result.client,'Persistent initialized assistant');
    await assistant.close();assert.equal((await replacement.executeTool('dev_connection')).connected,false);
  }finally{await assistant.close();await replacement?.close();}
});

test('a transient failed heartbeat still retains the lease needed for EOF cleanup',async t=>{
  const {root,connection}=await fixture(t);let failed=false;
  const assistant=createDevAssistantLease(root,{heartbeatMs:20,fetcher:async(...args)=>{
    if(JSON.parse(args[1].body).event==='heartbeat'){failed=true;throw Error('Temporary network failure');}return fetch(...args);
  }});
  try{
    await assistant.start({name:'Temporary failure assistant'});await waitFor(()=>failed);assert.equal((await connection()).connected,true);
    await assistant.close();assert.equal((await connection()).connected,false);
  }finally{await assistant.close();}
});

test('initialized stdio may wait for dev startup without claiming an assistant is connected',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-mcp-late-dev-'));let tools;
  const assistant=createDevAssistantLease(root,{heartbeatMs:20}),session=stdio(root,{assistant});
  try{
    await session.initialize('Waiting assistant');
    tools=await createDevToolsServer({root,session:'late-dev-start'});
    await waitFor(async()=>(await tools.executeTool('dev_connection')).initialized,'an initialized adapter should register when dev starts');
    await session.close();assert.equal((await tools.executeTool('dev_connection')).connected,false);
  }finally{await session.close();await tools?.close();await rm(root,{recursive:true,force:true});}
});

test('browser transport, copied metadata and linked Host relay cannot establish an assistant',async t=>{
  let clock=1000;const {tools,post,connection}=await fixture(t,{now:()=>clock});
  tools.setHostRelayState({enabled:true,linked:true,lastSeen:clock});
  await post('/v1/browser',{session:tools.session,clientId:'browser-only',kind:'heartbeat',path:'/',hydrated:true});
  assert.equal((await post('/v1/tools/dev_connection',{}, {Origin:'http://localhost:3000','X-PRNext-Client':'Impersonated assistant'})).status,200);
  assert.equal((await post('/v1/tools/dev_connection')).status,200);assert.equal((await connection()).connected,false);
  let response=await post('/v1/tools/dev_ai_context',{context:{text:'No assistant yet'}},{Origin:'http://localhost:3000'});assert.equal(response.status,409);assert.equal((await response.json()).code,'assistant_required');
  assert.equal((await tools.executeTool('dev_snapshot')).ai.contexts.length,0);
  response=await post('/v1/tools/dev_ai_context',{context:{text:'A real Host MCP tool call'}},{'X-PRNext-Client':'Host MCP: Connected assistant'});assert.equal(response.status,200);assert.equal((await connection()).connected,true);assert.equal((await connection()).initialized,false);
  clock+=60001;assert.equal((await connection()).connected,false);
  assert.equal((await post('/v1/tools/dev_ai_context',{context:{}},{Origin:'http://localhost:3000'})).status,409);
});
