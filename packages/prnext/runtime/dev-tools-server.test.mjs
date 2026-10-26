import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDevToolsServer,redactDevText,devPath} from './dev-tools-server.mjs';
import {callLocalDevTool,readDevToolsConnection,devMcpReply,runDevMcp} from './dev-tools-mcp.mjs';
import {Readable,Writable} from 'node:stream';
import {request as httpRequest} from 'node:http';

async function fixture(t,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-tools-')),state={state:'ready',buildId:'build-one',sequence:1,typeErrors:[],routes:[{path:'/',kind:'page',compiled:true}]};
  const tools=await createDevToolsServer({root,session:'test-session',snapshot:()=>state,...options});tools.setAppUrl('http://127.0.0.1:3000');
  t.after(async()=>{await tools.close();await rm(root,{recursive:true,force:true});});
  const request=(name,body={},headers={})=>fetch(tools.endpoint+'/v1/tools/'+name,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tools.token,...headers},body:JSON.stringify(body)});
  const browser=(args={})=>tools.browserEvent({session:'test-session',clientId:'tab-1',buildId:state.buildId,sequence:state.sequence,path:'/',kind:'applied',hydrated:true,issues:0,errors:[],...args});
  return {root,state,tools,request,browser};
}

test('sidecar requires exact loopback host, capability, JSON and permitted origin',async t=>{
  const {tools,request}=await fixture(t);
  assert.equal((await request('dev_snapshot',{}, {Authorization:'Bearer wrong'})).status,401);
  assert.equal((await request('dev_snapshot',{}, {Origin:'https://evil.example'})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const req=httpRequest(tools.endpoint+'/v1/tools/dev_snapshot',{method:'POST',headers:{Host:'attacker.example','Content-Type':'application/json',Authorization:'Bearer '+tools.token}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});
  assert.equal(wrongHost,403);
  assert.equal((await request('dev_snapshot',{}, {'Content-Type':'text/plain'})).status,415);
  const response=await request('dev_snapshot',{}, {Origin:'http://localhost:3000'});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),'http://localhost:3000');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).session,'test-session');
  assert.equal((await request('dev_snapshot',{shell:'rm -rf /'})).status,400);
  assert.equal((await request('not_a_tool')).status,400);
  const preflight=await fetch(tools.endpoint+'/v1/browser',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:3000'}});assert.equal(preflight.status,204);
});

test('capability discovery is session scoped and local stdio traffic is actual AI activity',async t=>{
  const {root,tools,request}=await fixture(t);
  const connection=await readDevToolsConnection(root);assert.equal(connection.token,tools.token);
  assert.equal((await tools.executeTool('dev_connection')).connected,false);
  await request('dev_snapshot',{}, {Origin:'http://localhost:3000'});
  assert.equal((await tools.executeTool('dev_connection')).connected,false);
  const result=await callLocalDevTool(root,'dev_snapshot');assert.equal(result.session,'test-session');assert.equal(result.ai.connected,true);
  const config=await tools.executeTool('dev_connection');assert.ok(config.mcp.args.includes('mcp'));assert.equal(config.client,'PRNext stdio MCP');
  tools.setHostRelayState({enabled:true,linked:true,origin:'https://user:password@host.example/private?secret=yes',lastSeen:123,accessToken:'must-not-be-stored'});
  const relay=(await tools.executeTool('dev_snapshot')).ai.hostRelay;assert.equal(relay.origin,'https://host.example');assert.equal(relay.linked,true);assert.equal(relay.accessToken,undefined);
  await tools.close();await assert.rejects(readDevToolsConnection(root),/Start prnext dev/);
});

test('browser telemetry deduplicates logs, strips query and retains bounded records',async t=>{
  const {tools,browser}=await fixture(t);
  browser({logs:[{id:1,text:'one',level:'info',time:1}],droppedLogs:3});browser({logs:[{id:1,text:'one',level:'info',time:1}]});
  const logs=await tools.executeTool('dev_logs',{source:'browser'});assert.equal(logs.logs.length,1);assert.equal(logs.droppedBrowserLogs,3);
  for(let i=0;i<400;i++)browser({kind:'request',path:'/page?secret=yes',request:{path:'/api/test?token=123',method:'GET',status:200,duration:12}});
  const view=await tools.executeTool('dev_snapshot');assert.equal(view.requests.length,300);assert.equal(view.requests[0].path,'/api/test');assert.equal(view.browsers[0].path,'/page');
  assert.throws(()=>browser({session:'old-session'}),/Invalid browser session/);
});

test('reports are bounded and obvious credentials are redacted without hiding ordinary logs',async t=>{
  const {tools,browser}=await fixture(t);
  for(let i=0;i<350;i++)tools.addServerLog('info','Request finished '+i);
  tools.addServerLog('error','token=secret123 password="hello there" Authorization: Bearer abcdefghijk sk_test_abc123');
  const view=await tools.executeTool('dev_snapshot');assert.equal(view.serverLogs.length,300);assert.match(view.serverLogs[0].text,/Request finished/);
  assert.doesNotMatch(view.serverLogs.at(-1).text,/secret123|hello there|abcdefghijk|sk_test_abc123/);
  await tools.executeTool('dev_ai_context',{kind:'selection',context:{label:'Save',token:'secret',nested:{password:'x'}}},{client:'Unit MCP'});
  const context=(await tools.executeTool('dev_snapshot')).ai.contexts[0].context;assert.equal(context.label,'Save');assert.equal(context.token,'[redacted]');assert.equal(context.nested.password,'[redacted]');
  assert.equal(redactDevText('https://bob:secret@example.test/a'),'https://[redacted]@example.test/a');
  browser({logs:[{id:9,text:'debug config '+tools.token}]});assert.doesNotMatch(JSON.stringify(await tools.executeTool('dev_logs',{source:'browser'})),new RegExp(tools.token));
  tools.addServerLog('error',"(node:123) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.");
  tools.addServerLog('error','(Use `node --trace-warnings ...` to show where the warning was created)');
  tools.addServerLog('warn','Actual application warning');
  assert.deepEqual((await tools.executeTool('dev_snapshot')).serverLogs.slice(-3).map(log=>log.level),['warn','info','warn']);
});

test('route operations use validated local paths and explicit handlers only',async t=>{
  const calls=[];const {tools}=await fixture(t,{ensureRoute:async value=>{calls.push(['ensure',value]);return {buildId:'new'};},invalidateRoute:async value=>{calls.push(['invalidate',value]);return {persistentTransformsPreserved:true};}});
  await tools.executeTool('dev_route_ensure',{path:'/products/1?secret=yes'});
  const result=await tools.executeTool('dev_cache_invalidate',{path:'/products/1'});assert.equal(result.invalidated,true);assert.equal(result.persistentTransformsPreserved,true);
  assert.deepEqual(calls,[['ensure','/products/1'],['invalidate','/products/1']]);
  for(const value of ['https://example.test','//example.test/a','/a\\b','/a\0b'])assert.throws(()=>devPath(value));
  await assert.rejects(tools.executeTool('dev_route_ensure',{path:'/a',command:'pwd'}),/Unknown argument/);
});

test('verification cannot succeed from compilation alone, stale browser or old generation',async t=>{
  const {tools,state,browser}=await fixture(t);browser();
  assert.equal((await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:100})).state,'inconclusive');
  state.sequence=2;state.buildId='build-two';
  assert.match((await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:100})).reason,/No browser/);
  browser({buildId:'build-one',sequence:1});
  assert.equal((await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:100})).verified,false);
  browser();const verified=await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:600});assert.equal(verified.verified,true);assert.equal(verified.browser.clientId,'tab-1');
});

test('verification scopes historic errors, catches current errors and requires the requested browser/path',async t=>{
  const {tools,state,browser}=await fixture(t);state.sequence=2;state.buildId='build-two';
  tools.recordBuild({buildId:'build-two',startedAt:Date.now()-50});
  browser({errors:[{message:'historic',time:Date.now()-1000}]});
  assert.equal((await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:600})).verified,true);
  browser({issues:1,errors:[{message:'current',time:Date.now()}]});
  const result=await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:600});assert.equal(result.state,'failed');assert.ok(result.errors.length>=1);
  browser({issues:0});assert.equal((await tools.executeTool('dev_verify',{sinceSequence:1,path:'/other',timeoutMs:100})).state,'inconclusive');
  state.state='error';state.error='Cannot compile';assert.equal((await tools.executeTool('dev_verify',{sinceSequence:1,timeoutMs:100})).state,'failed');
});

test('AI context is queued honestly and source helpers are narrowly delegated',async t=>{
  const seen=[];const {tools}=await fixture(t,{sourceTools:{source:async args=>{seen.push(args);return {file:'app/page.tsx',line:2,frame:'2 | code'};},editor:async args=>({editorUrl:'vscode://file/'+args.file})}});
  await assert.rejects(tools.executeTool('dev_ai_context',{kind:'error',context:{message:'bug'}}),error=>error.code==='assistant_required');
  const context=await tools.executeTool('dev_ai_context',{kind:'error',prompt:'Fix this',context:{message:'bug'}},{client:'Unit MCP'});assert.equal(context.queued,true);assert.equal(context.connected,true);
  assert.equal((await tools.executeTool('dev_source',{file:'app/page.tsx',line:2})).frame,'2 | code');assert.equal(seen.length,1);
  assert.match((await tools.executeTool('dev_open_editor',{file:'app/page.tsx'})).editorUrl,/^vscode:/);
});

test('selection PNGs stay complete and snapshots remain bounded under log pressure',async t=>{
  const {tools,request}=await fixture(t);
  const png=Buffer.alloc(240*1024,31);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  const screenshot={mimeType:'image/png',data:png.toString('base64'),width:300,height:200};
  for(let i=0;i<300;i++)tools.addServerLog('info','message '+i+' '+'.'.repeat(15900));
  const posted=await request('dev_ai_context',{kind:'element',context:{screenshot,label:'Save'}},{'X-PRNext-Client':'Unit MCP'});assert.equal(posted.status,200);
  const snapshot=await tools.executeTool('dev_snapshot');assert.equal(snapshot.ai.contexts[0].context.screenshot.data,screenshot.data);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<480*1024);assert.ok(snapshot.truncated.serverLogs);
  await tools.executeTool('dev_ai_context',{kind:'element',context:{screenshot,label:'Cancel'}});
  const next=await tools.executeTool('dev_snapshot');assert.equal(next.ai.contexts.at(-1).context.screenshot.data,screenshot.data);assert.equal(next.ai.contexts[0].context.screenshot.omitted,true);
  await assert.rejects(tools.executeTool('dev_ai_context',{kind:'element',context:{screenshot:{...screenshot,data:'not-a-PNG'}}}),/Screenshot must be/);
});

test('stdio MCP supports initialization, tools, structured replies and tool errors',async()=>{
  const init=devMcpReply({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}},()=>{});assert.equal(init.result.protocolVersion,'2025-03-26');
  const list=devMcpReply({jsonrpc:'2.0',id:2,method:'tools/list'},()=>{});assert.ok(list.result.tools.some(tool=>tool.name==='dev_verify'));
  const called=await devMcpReply({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'dev_snapshot'}},async()=>({version:1,state:'ready'}));assert.equal(called.result.structuredContent.state,'ready');
  const failed=await devMcpReply({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'missing'}},async()=>{throw Error('Unknown tool');});assert.equal(failed.result.isError,true);
  assert.equal(devMcpReply({jsonrpc:'2.0',method:'notifications/initialized'},()=>{}),undefined);
});

test('MCP transport emits protocol JSON only and handles malformed input',async()=>{
  let output='';await runDevMcp('.',{
    input:Readable.from(['bad JSON\n'+[
      {jsonrpc:'2.0',id:1,method:'ping'},
      {jsonrpc:'2.0',id:3,method:'initialize',params:{clientInfo:{name:'Test MCP'}}},
      {jsonrpc:'2.0',method:'notifications/initialized'},
      {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'dev_routes'}},
    ].map(value=>JSON.stringify(value)).join('\n')+'\n']),
    output:new Writable({write(chunk,encoding,next){output+=chunk;next();}}),invoke:async()=>({routes:[]}),assistant:{start:async()=>true,close:async()=>{}},
  });
  const replies=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,4);assert.equal(replies[0].error.code,-32700);assert.ok(replies.some(reply=>reply.id===2&&reply.result.structuredContent.routes.length===0));
});

test('MCP drops an oversized fragmented line then accepts the next request',async()=>{
  let output='';await runDevMcp('.',{
    input:Readable.from(['x'.repeat(150000),'x'.repeat(150000),'\n'+JSON.stringify({jsonrpc:'2.0',id:7,method:'ping'})+'\n']),
    output:new Writable({write(chunk,encoding,next){output+=chunk;next();}}),
  });
  const replies=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,2);assert.equal(replies[0].error.message,'Request too large');assert.equal(replies[1].id,7);
});

test('capability reader rejects remotely redirected discovery',async t=>{
  const {root}=await fixture(t);const filename=path.join(root,'.prnext-dev','tools.json'),value=JSON.parse(await readFile(filename,'utf8'));
  await writeFile(filename,JSON.stringify({...value,endpoint:'https://attacker.example'}));await assert.rejects(readDevToolsConnection(root),/Invalid development connection/);
});
