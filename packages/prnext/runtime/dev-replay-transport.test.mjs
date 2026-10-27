import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {createDevToolsServer,devToolDefinitions} from './dev-tools-server.mjs';
import {callLocalDevTool,runDevMcp,devMcpReply} from './dev-tools-mcp.mjs';

const scenario=()=>({version:1,name:'Heading remains visible',viewport:{width:390,height:844},steps:[
  {type:'visit',path:'/'},{type:'expectVisible',target:{kind:'role',role:'heading',name:'Welcome'}},
]});
async function fixture(t,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-replay-transport-'));
  const tools=await createDevToolsServer({root,session:'replay-transport',snapshot:()=>({state:'ready',buildId:'build-one',sequence:1,typeErrors:[]}),...options});
  tools.setAppUrl('http://127.0.0.1:3000');
  t.after(async()=>{await tools.close();await rm(root,{recursive:true,force:true});});
  const request=(name,args={},headers={})=>fetch(tools.endpoint+'/v1/tools/'+name,{method:'POST',headers:{Authorization:'Bearer '+tools.token,'Content-Type':'application/json',...headers},body:JSON.stringify(args)});
  return {root,tools,request};
}

test('Replay capability API persists reviewed definitions and enforces strict authenticated input',async t=>{
  const {root,tools,request}=await fixture(t);
  await writeFile(path.join(root,'.env'),'DO_NOT_CHANGE=private\n');
  assert.equal((await request('dev_replay_list',{}, {Authorization:'Bearer wrong'})).status,401);
  assert.equal((await request('dev_replay_save',{scenario:scenario()}, {Origin:'https://outside.example'})).status,403);
  for(const [name,args] of [
    ['dev_replay_save',{scenario:{...scenario(),command:'arbitrary'}}],
    ['dev_replay_save',{scenario:{...scenario(),steps:[{type:'visit',path:'https://outside.example'},scenario().steps[1]]}}],
    ['dev_replay_save',{scenario:{...scenario(),steps:[{type:'visit',path:'/'},{type:'fill',target:{kind:'label',value:'Name'},parameter:'name',value:'never save this'},scenario().steps[1]]}}],
    ['dev_replay_result',{id:'../../.env'}],['dev_replay_run',{id:'../../.env'}],
    ['dev_replay_delete',{id:'../../.env'}],['dev_replay_export',{id:'../../.env'}],
    ['dev_replay_list',{shell:'anything'}],
  ])assert.equal((await request(name,args)).status,400,name);
  const saved=await (await request('dev_replay_save',{scenario:scenario()})).json();
  assert.equal(saved.session,'replay-transport');assert.match(saved.scenario.id,/^[a-f0-9-]{36}$/);
  const id=saved.scenario.id;
  const listed=await (await request('dev_replay_list')).json();assert.equal(listed.scenarios.length,1);assert.equal(listed.scenarios[0].id,id);
  const disk=JSON.parse(await readFile(path.join(root,'.prnext-replays','scenarios',id+'.json'),'utf8'));
  assert.deepEqual(disk,saved.scenario);assert.doesNotMatch(JSON.stringify(disk),new RegExp(tools.token));
  const exported=await (await request('dev_replay_export',{id})).json();assert.match(exported.code,/from '@playwright\/test'/);assert.match(exported.code,/Welcome/);
  assert.equal((await (await request('dev_replay_result',{id})).json()).run,undefined);
  assert.equal((await (await request('dev_replay_delete',{id})).json()).removed,true);
  assert.deepEqual(await readdir(path.join(root,'.prnext-replays','scenarios')),[]);
  assert.equal(await readFile(path.join(root,'.env'),'utf8'),'DO_NOT_CHANGE=private\n');
});

test('Replay CLI reads do not claim an assistant is connected',async t=>{
  const {root,tools}=await fixture(t);
  const listed=await callLocalDevTool(root,'dev_replay_list',{}, {client:'PRNext replay CLI'});
  assert.deepEqual(listed.scenarios,[]);assert.equal((await tools.executeTool('dev_connection')).connected,false);
  await callLocalDevTool(root,'dev_replay_list',{}, {client:'Actual test assistant'});
  assert.equal((await tools.executeTool('dev_connection')).connected,true);
});

test('MCP discovers actionable Replay tools and carries saved scenario context over stdio',async t=>{
  const {root,tools}=await fixture(t);
  const definitions=devToolDefinitions.filter(tool=>tool.name.startsWith('dev_replay_'));
  assert.equal(definitions.length,6);
  for(const name of ['dev_replay_run','dev_replay_delete']){
    const tool=definitions.find(value=>value.name===name);assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.destructiveHint,true);
  }
  let output='';
  await runDevMcp(root,{
    input:Readable.from([
      {jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'Replay integration'}}},
      {jsonrpc:'2.0',method:'notifications/initialized'},
      {jsonrpc:'2.0',id:2,method:'tools/list'},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'dev_replay_save',arguments:{scenario:scenario()}}},
    ].map(value=>JSON.stringify(value)+'\n')),
    output:new Writable({write(chunk,encoding,next){output+=chunk;next();}}),
    assistant:{start:async()=>true,close:async()=>{}},
    invoke:(name,args)=>callLocalDevTool(root,name,args),
  });
  const replies=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,3);
  assert.match(replies.find(value=>value.id===1).result.instructions,/dev_replay/);
  assert.equal(replies.find(value=>value.id===2).result.tools.filter(tool=>tool.name.startsWith('dev_replay_')).length,6);
  const saved=replies.find(value=>value.id===3).result.structuredContent;assert.equal(saved.scenario.name,scenario().name);
  assert.equal((await callLocalDevTool(root,'dev_replay_list')).scenarios[0].id,saved.scenario.id);
  assert.doesNotMatch(output,new RegExp(tools.token));
});

test('Replay dispatch bounds evidence without corrupting the stored result and always closes the manager',async t=>{
  const id='11223344-1122-4122-8122-112233445566',runId='22334455-2233-4233-8233-223344556677',calls=[];
  const original={id,run:{runId,screenshots:{before:{mimeType:'image/png',data:'A'.repeat(300000)},after:{mimeType:'image/png',data:'B'.repeat(300000)}}}};
  const replayManager={list:async()=>({scenarios:[]}),save:async value=>({scenario:value}),start:async args=>{calls.push(args);return {id,runId,state:'running'};},result:async()=>original,export:async()=>({code:'test'}),remove:async()=>({removed:true}),close:async()=>{calls.push('close');}};
  const {root,tools,request}=await fixture(t,{replayManager});
  const response=await request('dev_replay_run',{id,parameters:{field1:'temporary fixture'}});assert.equal(response.status,200);assert.deepEqual(calls[0],{id,parameters:{field1:'temporary fixture'}});
  const result=await tools.executeTool('dev_replay_result',{id,runId});assert.equal(result.run.screenshots.omitted,true);assert.equal(original.run.screenshots.after.data.length,300000);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<470*1024);
  await tools.close();assert.equal(calls.filter(value=>value==='close').length,1);
  await assert.rejects(readFile(path.join(root,'.prnext-dev','tools.json'),'utf8'),{code:'ENOENT'});
});

test('Dev server revokes its capability even if browser teardown fails',async t=>{
  const {root,tools}=await fixture(t,{replayManager:{close:async()=>{throw Error('Browser teardown failed');}}});
  await assert.rejects(tools.close(),/Browser teardown failed/);
  await assert.rejects(readFile(path.join(root,'.prnext-dev','tools.json'),'utf8'),{code:'ENOENT'});
  await assert.rejects(fetch(tools.endpoint+'/v1/tools/dev_replay_list'));
});

test('Replay MCP bounds the final text plus structured envelope without silently dropping expectations',async t=>{
  const {tools}=await fixture(t),large=scenario();
  large.steps.push(...Array.from({length:12},()=>({type:'expectText',target:{kind:'testId',value:'details'},text:'"'.repeat(1900)})));
  let count=0;
  for(let index=0;index<10;index++)try{await tools.executeTool('dev_replay_save',{scenario:{...large,name:'Large '+index}});count++;}catch(error){assert.match(error.message,/library size limit/);break;}
  assert.ok(count>0&&count<10);
  const call={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dev_replay_list',arguments:{}}};
  const listed=await devMcpReply(call,(name,args)=>tools.executeTool(name,args));
  assert.equal(listed.result.isError,false);assert.equal(listed.result.structuredContent.scenarios.length,count);
  assert.ok(Buffer.byteLength(JSON.stringify(listed))<512*1024);
  const oversized=await devMcpReply(call,async()=>({scenarios:[{steps:'x'.repeat(280000)}]}));
  assert.equal(oversized.result.isError,true);assert.match(oversized.result.content[0].text,/response limit/);assert.ok(Buffer.byteLength(JSON.stringify(oversized))<1024);
});
