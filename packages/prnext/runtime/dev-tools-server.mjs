import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {open,lstat,realpath,rename,rm,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReplayManager} from './dev-replay-runner.mjs';
import {replayScenarioSchema} from './dev-replay-model.mjs';

const object={type:'object',additionalProperties:false,properties:{}};
const pathProperty={type:'string',maxLength:1024,description:'Local pathname, without a host.'};
const sourceProperties={file:{type:'string',maxLength:2048},source:{type:'string',maxLength:2048},url:{type:'string',maxLength:4096},stack:{type:'string',maxLength:16000},line:{type:'integer',minimum:1},column:{type:'integer',minimum:1},error:{type:'object'},editor:{type:'string',enum:['vscode','cursor']}};
/** Shared by the local stdio adapter and the optional existing Host MCP relay. */
export const devToolDefinitions=[
  {name:'dev_snapshot',description:'Current local development generation, errors, browser confirmations, logs, routes and measured build timings.',inputSchema:object},
  {name:'dev_connection',description:'Actual local AI connection activity and stdio setup for this project.',inputSchema:object},
  {name:'dev_logs',description:'Bounded, redacted development server/browser logs and request timings.',inputSchema:{...object,properties:{source:{type:'string',enum:['server','browser','all']},level:{type:'string'},limit:{type:'integer',minimum:1,maximum:500}}}},
  {name:'dev_routes',description:'Discovered routes and which routes are currently compiled.',inputSchema:object},
  {name:'dev_route_ensure',description:'Compile a local development pathname on demand. Does not navigate a browser.',inputSchema:{...object,properties:{path:pathProperty},required:['path']}},
  {name:'dev_cache_invalidate',description:'Expire native data/page cache entries associated with one local route. Preserves unrelated entries, the running development generation, persistent transform caches and project files.',inputSchema:{...object,properties:{path:pathProperty},required:['path']}},
  {name:'dev_verify',description:'Wait for a NEW ready generation after sinceSequence AND a browser confirmation of that exact generation. Missing browser evidence is inconclusive, never success.',inputSchema:{...object,properties:{path:pathProperty,sinceSequence:{type:'integer',minimum:0},clientId:{type:'string',maxLength:100},timeoutMs:{type:'integer',minimum:100,maximum:30000}}}},
  {name:'dev_replay_list',description:'List this project\'s recorded functional scenarios and their latest observed result. Does not run the application.',inputSchema:object,annotations:{readOnlyHint:true}},
  {name:'dev_replay_save',description:'Save a reviewed local scenario with explicit expectations. Fill steps contain fixture parameter names, never recorded values.',inputSchema:{...object,properties:{scenario:replayScenarioSchema},required:['scenario']},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
  {name:'dev_replay_run',description:'Start one recorded local browser scenario. Clicks and fills perform the recorded application interactions. Supply explicit test fixture parameters; poll dev_replay_result for functional assertions and exact-generation evidence.',inputSchema:{...object,properties:{id:{type:'string',maxLength:36},parameters:{type:'object',maxProperties:50,additionalProperties:{type:'string',maxLength:4096},description:'Named fill fixtures for this run only. Never included in saved scenarios or reports.'}},required:['id']},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'dev_replay_result',description:'Read a scenario and its current or selected replay result, previous result and bounded screenshots. Only verified=true proves the recorded expectations for that exact generation.',inputSchema:{...object,properties:{id:{type:'string',maxLength:36},runId:{type:'string',maxLength:36}},required:['id']},annotations:{readOnlyHint:true}},
  {name:'dev_replay_export',description:'Return an ordinary reviewable Playwright test for a saved scenario. Does not execute it or write another file.',inputSchema:{...object,properties:{id:{type:'string',maxLength:36}},required:['id']},annotations:{readOnlyHint:true}},
  {name:'dev_replay_delete',description:'Remove the selected saved scenario and its bounded local replay evidence.',inputSchema:{...object,properties:{id:{type:'string',maxLength:36}},required:['id']},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'dev_ai_context',description:'Queue selected element or error context for the connected local assistant. Does not claim the assistant has acted.',inputSchema:{...object,properties:{kind:{type:'string',maxLength:32},context:{type:'object'},prompt:{type:'string',maxLength:4000}}}},
  {name:'dev_source',description:'Resolve a project source location and a small code frame. Secret and external files are excluded.',inputSchema:{...object,properties:sourceProperties}},
  {name:'dev_open_editor',description:'Validate a project source location and return an editor deep link. Never runs a shell.',inputSchema:{...object,properties:sourceProperties}},
];

export function redactDevText(value,limit=16000){
  return String(value??'').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g,'[redacted key]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi,'[redacted authorization]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,'$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/g,'$1[redacted]@')
    .slice(0,limit);
}
export function devPath(value='/'){
  if(typeof value!=='string'||value.length>1024||!value.startsWith('/')||value.startsWith('//')||/[\u0000-\u001f\\]/.test(value))throw Error('A local pathname is required');
  return new URL(value,'http://local').pathname;
}
function requestPath(value){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\\]/.test(value))return '[unavailable]';
  if(value.startsWith('/')&&!value.startsWith('//'))return devPath(value);
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return '[unavailable]';return url.origin+url.pathname;}catch{return '[unavailable]';}
}
const boundedArray=(value,max)=>Array.isArray(value)?value.slice(-max):[];
const text=(value,max=256)=>redactDevText(value,max);
const number=value=>Number.isFinite(value)?value:undefined;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function limitedContext(value,capability){
  let serialized;try{serialized=JSON.stringify(value??{});}catch{throw Error('Context must be JSON');}
  if(Buffer.byteLength(serialized)>400*1024)throw Error('Context is too large');
  const clean=(item,depth=0)=>{
    if(depth>10)return '[depth limit]';
    if(typeof item==='string'){const result=redactDevText(item,16000);return capability?result.replaceAll(capability,'[redacted capability]'):result;}
    if(Array.isArray(item))return item.slice(0,100).map(entry=>clean(entry,depth+1));
    if(item&&typeof item==='object'){
      if(item.mimeType==='image/png'&&typeof item.data==='string'){
        if(item.data.length>350000||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)||!Buffer.from(item.data,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Screenshot must be a PNG no larger than 256 KiB');
        return {mimeType:'image/png',data:item.data,width:number(item.width),height:number(item.height)};
      }
      return Object.fromEntries(Object.entries(item).slice(0,100).map(([key,entry])=>[key,/password|secret|token|authorization|cookie|api.?key/i.test(key)?'[redacted]':clean(entry,depth+1)]));
    }
    return item;
  };
  return clean(JSON.parse(serialized));
}
function validArguments(name,args){
  const definition=devToolDefinitions.find(item=>item.name===name);if(!definition)throw Error('Unknown development tool');
  if(!plain(args))throw Error('Arguments must be an object');
  for(const key of Object.keys(args))if(!Object.hasOwn(definition.inputSchema.properties,key))throw Error('Unknown argument: '+key);
  for(const key of definition.inputSchema.required||[])if(!Object.hasOwn(args,key))throw Error('Missing argument: '+key);
  for(const [key,value] of Object.entries(args)){
    const schema=definition.inputSchema.properties[key];
    if(schema.type==='string'&&(typeof value!=='string'||value.length>(schema.maxLength||4096)))throw Error('Invalid '+key);
    if(schema.type==='integer'&&(!Number.isSafeInteger(value)||value<(schema.minimum??0)||value>(schema.maximum??Number.MAX_SAFE_INTEGER)))throw Error('Invalid '+key);
    if(schema.type==='object'&&!plain(value))throw Error('Invalid '+key);
    if(schema.enum&&!schema.enum.includes(value))throw Error('Invalid '+key);
  }
}

export async function createDevToolsServer({root,session=randomUUID(),snapshot=()=>({}),ensureRoute,invalidateRoute,sourceTools,collectMetrics,now=Date.now,replayManager}={}){
  root=await realpath(root);
  if(!/^[\w-]{1,100}$/.test(session))throw Error('Invalid development session');
  const token=randomBytes(32).toString('base64url'),tokenBytes=Buffer.from(token),origins=new Set(),browsers=new Map(),assistants=new Map(),serverLogs=[],requests=[],builds=[],contexts=[];
  const assistantLeaseMs=30000;
  const safeText=(value,max=256)=>text(value,max).replaceAll(token,'[redacted capability]');
  const discoveryDirectory=path.join(root,'.prnext-dev'),discoveryFile=path.join(discoveryDirectory,'tools.json');
  let endpoint,closed=false,logId=0,lastActivity=null,lastClient=null,appUrl=null,discoveryOwned=false,inFlight=0,hostRelayState={enabled:false,linked:false};
  const replays=replayManager||createReplayManager({root,getAppUrl:()=>appUrl,snapshot:()=>({...snapshot(),session}),ensureRoute,now});
  const envelope=value=>({version:1,session,...value});
  const prune=()=>{for(const [id,client] of browsers)if(now()-client.lastSeen>45000)browsers.delete(id);for(const [id,client] of assistants)if(client.expiresAt<=now())assistants.delete(id);};
  function connection(){
    prune();const live=[...assistants.values()].sort((a,b)=>b.lastSeen-a.lastSeen),recent=lastActivity!==null&&now()-lastActivity<60000,latest=live[0];
    return {connected:live.length>0||recent,initialized:live.length>0,lastActivity:lastActivity??latest?.initializedAt??null,client:recent?lastClient:latest?.client??null,
      clients:live.map(({client,initializedAt,lastSeen})=>({client,initializedAt,lastSeen})),hostRelay:{...hostRelayState},mcp:{command:process.execPath,args:[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'mcp',root]},endpoint:appUrl};
  }
  function assistantEvent(body){
    prune();
    if(!plain(body)||!['register','heartbeat','unregister'].includes(body.event)||typeof body.instanceId!=='string'||!/^[\w-]{16,100}$/.test(body.instanceId))throw Error('Invalid assistant lifecycle event');
    const allowed=body.event==='register'?['event','instanceId','client']:['event','instanceId','leaseId'];
    if(Object.keys(body).some(key=>!allowed.includes(key)))throw Error('Unknown assistant lifecycle field');
    if(body.event==='register'){
      if(typeof body.client!=='string'||!body.client.trim()||body.client.length>100||/[\u0000-\u001f\u007f]/.test(body.client))throw Error('Invalid assistant client');
      let client=assistants.get(body.instanceId);
      if(!client){if(assistants.size>=16)throw Object.assign(Error('Too many initialized assistants'),{code:'assistant_limit',status:429});client={leaseId:randomBytes(24).toString('base64url'),client:safeText(body.client,100),initializedAt:now()};assistants.set(body.instanceId,client);}
      client.lastSeen=now();client.expiresAt=now()+assistantLeaseMs;
      return envelope({leaseId:client.leaseId,leaseMs:assistantLeaseMs});
    }
    const client=assistants.get(body.instanceId);
    if(!client&&body.event==='unregister')return envelope({accepted:true});
    if(!client||typeof body.leaseId!=='string'||client.leaseId!==body.leaseId)throw Object.assign(Error('Assistant lease expired; initialize again'),{code:'assistant_lease_expired',status:404});
    if(body.event==='unregister')assistants.delete(body.instanceId);
    else {client.lastSeen=now();client.expiresAt=now()+assistantLeaseMs;}
    return envelope({accepted:true,leaseMs:assistantLeaseMs});
  }
  function routes(){return boundedArray(snapshot().routes,2000).map(route=>typeof route==='string'?{path:text(route,1024)}:{path:text(route.path,1024),kind:text(route.kind,40),source:route.source?text(route.source,512):undefined,compiled:!!route.compiled,pinned:!!route.pinned});}
  function compact(value){
    // Keep a single tool response below the Host relay's 512 KiB envelope.
    // Explicit counts disclose trimming; never cut an image or JSON string.
    const shortened={};
    const lists=[['serverLogs',value.serverLogs],['requests',value.requests],['builds',value.builds],['routes',value.routes],['logs',value.logs],['browsers',value.browsers]];
    for(const [name,list] of lists)if(list)shortened[name]=list.length;
    const large=()=>Buffer.byteLength(JSON.stringify(value))>470*1024;
    for(const [name,list] of lists){if(!Array.isArray(list))continue;while(list.length>1&&large())list.splice(0,Math.ceil(list.length/2));if(list.length!==shortened[name])(value.truncated??={})[name]={returned:list.length,total:shortened[name]};}
    if(large()&&value.ai?.contexts?.length>1)value.ai.contexts=value.ai.contexts.slice(-1);
    return value;
  }
  function view(){
    prune();const state=snapshot();
    return compact(envelope({...state,error:state.error?safeText(state.error,8000):undefined,typeErrors:boundedArray(state.typeErrors,30).map(value=>safeText(value,4000)),serverLogs:[...serverLogs],requests:[...requests],builds:[...builds],routes:routes(),cache:state.cache||{},ai:{...connection(),contexts:[...contexts]},browsers:[...browsers.values()].map(({seenLogs,logs,...client})=>({...client,errors:client.errors?.slice(-10).map(error=>({...error,message:safeText(error.message,2000),stack:undefined})),selection:undefined}))}));
  }
  function addServerLog(level,value,extra={}){
    const content=safeText(value,16000);if(!content.trim())return;
    if(!extra.structuredLevel){
      if(/^(?:\(node:\d+\)\s+)?(?:\[[^\]]+\]\s+)?\w*Warning:/.test(content))level='warn';
      else if(/^\(Use .+--trace-warnings/.test(content))level='info';
      else if(/^\d{4}-\d{2}-\d{2}T\S+\s+(ERROR|INFO|DEBUG|TRACE|WARN)\b/.test(content))level=/\sERROR\b/.test(content)?'error':/\sWARN\b/.test(content)?'warn':'info';
    }
    serverLogs.push({id:++logId,time:now(),level:['error','warn','info','log','debug','trace'].includes(level)?level:'info',text:content.replaceAll(token,'[redacted capability]'),source:'server',...extra});if(serverLogs.length>300)serverLogs.splice(0,serverLogs.length-300);
  }
  function recordBuild(value){builds.push({...value});if(builds.length>40)builds.shift();}
  function recordRequest(item){
    if(!plain(item))return;
    requests.push({id:++logId,originalId:item.id,clientId:item.clientId,source:item.source==='server'?'server':'browser',time:number(item.time)||now(),path:requestPath(item.path||'/'),route:item.route?requestPath(item.route):undefined,method:text(item.method||'GET',12),status:number(item.status),duration:number(item.duration),kind:text(item.kind||'fetch',20),buildId:item.buildId,failed:!!item.failed,error:item.error?text(item.error,200):undefined});
    if(requests.length>300)requests.shift();
  }
  function browserEvent(body){
    if(!plain(body)||body.session!==session||typeof body.clientId!=='string'||!/^[\w-]{1,100}$/.test(body.clientId))throw Error('Invalid browser session');
    if(!['heartbeat','applied','errors','request','selection','reload'].includes(body.kind))throw Error('Invalid browser event');
    prune();let client=browsers.get(body.clientId);
    if(!client){if(browsers.size>=8)browsers.delete(browsers.keys().next().value);client={clientId:body.clientId,seenLogs:new Set(),logs:[]};browsers.set(body.clientId,client);}
    client.lastSeen=now();client.path=devPath(body.path||'/');
    client.buildId=text(body.buildId,128);client.sequence=Number.isSafeInteger(body.sequence)?body.sequence:0;
    if(body.kind==='applied'&&body.hydrated===true&&body.building!==true)client.applied={buildId:client.buildId,sequence:client.sequence,time:now()};
    if(body.kind==='reload'){client.applied=undefined;client.reloadReason=text(body.reason||'Full reload required',256);client.reloadAt=now();}
    client.issues=Number.isSafeInteger(body.issues)?Math.max(0,body.issues):0;client.building=body.building===true;
    if(Number.isSafeInteger(body.droppedLogs)&&body.droppedLogs>=0)client.droppedLogs=Math.max(client.droppedLogs||0,body.droppedLogs);
    if(Array.isArray(body.errors))client.errors=body.errors.slice(0,30).map(error=>typeof error==='string'?{message:safeText(error,8000),time:now()}:{name:safeText(error?.name,128),message:safeText(error?.message||error?.text,8000),stack:safeText(error?.stack,16000),time:number(error?.time)||now()});
    for(const log of boundedArray(body.logs,100)){
      if(!plain(log))continue;const id=text(log.id,100);if(!id||client.seenLogs.has(id))continue;
      client.seenLogs.add(id);client.logs.push({id:body.clientId+':'+id,time:number(log.time)||now(),level:text(log.level||'log',16),text:safeText(log.text,8000)});
    }
    if(client.logs.length>100)client.logs.splice(0,client.logs.length-100);
    // Keep a bounded dedup window; client log IDs are monotonically increasing.
    if(client.seenLogs.size>500)client.seenLogs=new Set([...client.seenLogs].slice(-300));
    if(body.kind==='request'&&plain(body.request)){
      recordRequest({...body.request,clientId:body.clientId,source:'browser',buildId:client.buildId});
    }
    if(body.kind==='selection'&&plain(body.selection))client.selection=limitedContext(body.selection,token);
    return envelope({accepted:true});
  }
  async function verify(args){
    const baseline=args.sinceSequence??snapshot().sequence??0,start=now(),clock=performance.now(),timeout=Math.min(args.timeoutMs??10000,30000),pathname=args.path&&devPath(args.path);
    while(!closed&&performance.now()-clock<timeout){
      const state=snapshot();prune();
      const clients=[...browsers.values()].filter(client=>(!args.clientId||client.clientId===args.clientId)&&(!pathname||client.path===pathname));
      const match=clients.find(client=>!client.building&&client.applied?.sequence===state.sequence&&client.applied?.buildId===state.buildId&&client.sequence===state.sequence&&client.buildId===state.buildId);
      if(state.state==='ready'&&state.sequence>baseline&&match&&now()-match.applied.time>=300){
        const since=builds.find(build=>build.buildId===state.buildId)?.startedAt||start;
        const errors=[...boundedArray(state.typeErrors,100).map(value=>safeText(value,4000)),...boundedArray(match.errors,30).filter(error=>error.time>=since),...(match.issues?['Browser reports '+match.issues+' current issue(s).']:[])];
        return envelope({verified:errors.length===0,state:errors.length?'failed':'verified',reason:errors.length?'Current generation has reported errors.':'New generation compiled and confirmed by the browser.',scope:'Observed compilation, TypeScript diagnostics and browser errors; this is not a full test suite.',buildId:state.buildId,sequence:state.sequence,browser:{clientId:match.clientId,path:match.path,confirmedAt:match.applied.time},errors});
      }
      if(state.state==='error')return envelope({verified:false,state:'failed',reason:'Development compilation failed.',errors:[safeText(state.error,8000)],sequence:state.sequence});
      await new Promise(resolve=>setTimeout(resolve,Math.min(100,timeout)));
    }
    const state=snapshot();return envelope({verified:false,state:'inconclusive',reason:closed?'Development session closed.':state.sequence>baseline?'No browser confirmed the current generation before the timeout.':'No new ready generation appeared before the timeout.',buildId:state.buildId,sequence:state.sequence});
  }
  async function executeTool(name,args={},meta={}){
    validArguments(name,args);if(closed)throw Error('Development session is closed');
    if(meta.assistantId){
      prune();const assistant=assistants.get(meta.assistantId);
      if(!assistant||meta.leaseId!==assistant.leaseId)throw Object.assign(Error('Assistant lease expired; initialize again'),{code:'assistant_lease_expired',status:409});
      assistant.lastSeen=now();assistant.expiresAt=now()+assistantLeaseMs;
    }else if(meta.client&&meta.client!=='browser'&&meta.client!=='PRNext replay CLI'){lastActivity=now();lastClient=text(meta.client,100);}
    if((name==='dev_snapshot'||name==='dev_logs')&&collectMetrics)await collectMetrics(recordRequest);
    if(name==='dev_snapshot')return view();
    if(name==='dev_connection')return envelope(connection());
    if(name==='dev_routes')return compact(envelope({routes:routes(),cache:snapshot().cache||{}}));
    if(name==='dev_logs'){
      prune();const source=args.source||'all',limit=args.limit||200;
      const logs=[...(source!=='browser'?serverLogs:[]),...(source!=='server'?[...browsers.values()].flatMap(client=>client.logs.map(log=>({...log,source:'browser',clientId:client.clientId}))):[])].filter(log=>!args.level||log.level===args.level).sort((a,b)=>a.time-b.time).slice(-limit);
      return compact(envelope({logs,requests:requests.slice(-limit),droppedBrowserLogs:[...browsers.values()].reduce((count,client)=>count+(client.droppedLogs||0),0)}));
    }
    if(name==='dev_route_ensure'||name==='dev_cache_invalidate'){
      const pathname=devPath(args.path),handler=name==='dev_route_ensure'?ensureRoute:invalidateRoute;if(!handler)throw Error('Development route operation is unavailable');
      const result=await handler(pathname);return envelope({...result,path:pathname,invalidated:result.invalidated??name==='dev_cache_invalidate'});
    }
    if(name==='dev_verify')return verify(args);
    if(name.startsWith('dev_replay_')){
      let result;
      if(name==='dev_replay_list')result=await replays.list();
      else if(name==='dev_replay_save')result=await replays.save(args.scenario);
      else if(name==='dev_replay_run')result=await replays.start({id:args.id,parameters:args.parameters||{}});
      else if(name==='dev_replay_result')result=await replays.result(args);
      else if(name==='dev_replay_export')result=await replays.export(args.id);
      else if(name==='dev_replay_delete')result=await replays.remove(args.id);
      const reply=envelope(result);
      if(Buffer.byteLength(JSON.stringify(reply))>470*1024){
        const bounded=structuredClone(reply);
        for(const run of [bounded.run,bounded.previous])if(run?.screenshots){run.screenshots={omitted:true,reason:'Screenshot evidence exceeds the tool response limit.'};}
        if(Buffer.byteLength(JSON.stringify(bounded))>470*1024)throw Error('Replay result exceeds the local tool response limit.');
        return bounded;
      }
      return reply;
    }
    if(name==='dev_ai_context'){
      if(!connection().connected)throw Object.assign(Error('Connect your assistant before sending context.'),{code:'assistant_required',status:409});
      const item={id:randomUUID(),time:now(),kind:text(args.kind||'context',32),prompt:safeText(args.prompt||'',4000),context:limitedContext(args.context,token)};
      // The latest selection owns the one retained image; older text context
      // remains useful without multiplying snapshot/relay payload sizes.
      for(const previous of contexts)if(previous.context?.screenshot)previous.context.screenshot={omitted:true,reason:'A newer context was queued.'};
      contexts.push(item);while(contexts.length>3||Buffer.byteLength(JSON.stringify(contexts))>410*1024)contexts.shift();return envelope({queued:true,id:item.id,connected:connection().connected});
    }
    if(name==='dev_source'||name==='dev_open_editor'){
      const handler=name==='dev_source'?sourceTools?.source:sourceTools?.editor;if(!handler)throw Error('Source inspection is unavailable');return envelope(await handler(args));
    }
  }
  function respond(res,status,value,origin){
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    if(origin&&origins.has(origin)){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin';headers['Access-Control-Allow-Methods']='POST, OPTIONS';headers['Access-Control-Allow-Headers']='Authorization, Content-Type, X-PRNext-Client';headers['Access-Control-Allow-Private-Network']='true';}
    res.writeHead(status,headers);res.end(JSON.stringify(value));
  }
  const server=createServer(async(req,res)=>{
    const origin=req.headers.origin;
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==new URL(endpoint).host||origin&&!origins.has(origin))return respond(res,403,{error:'Local development origin required'});
    if(req.method==='OPTIONS')return respond(res,204,{},origin);
    const supplied=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,''));
    if(supplied.length!==tokenBytes.length||!timingSafeEqual(supplied,tokenBytes))return respond(res,401,{error:'Development capability required'},origin);
    if(req.method!=='POST'||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return respond(res,415,{error:'POST application/json required'},origin);
    if(Number(req.headers['content-length'])>420*1024)return respond(res,413,{error:'Request too large'},origin);
    if(inFlight>=16)return respond(res,429,{error:'Too many pending development requests'},origin);
    inFlight++;
    try{
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>420*1024){respond(res,413,{error:'Request too large'},origin);req.destroy();return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const pathname=new URL(req.url,endpoint).pathname;
      if(pathname==='/v1/assistant'&&origin)return respond(res,403,{error:'Only an initialized native MCP client can register an assistant.',code:'native_assistant_required'},origin);
      const result=pathname==='/v1/assistant'?assistantEvent(body):pathname==='/v1/browser'?browserEvent(body):pathname.startsWith('/v1/tools/')?await executeTool(pathname.slice(10),body,{client:origin?'browser':req.headers['x-prnext-client'],...(!origin&&req.headers['x-prnext-assistant']?{assistantId:req.headers['x-prnext-assistant'],leaseId:req.headers['x-prnext-lease']}: {})}):null;
      if(result===null)return respond(res,404,{error:'Unknown development endpoint'},origin);respond(res,200,result,origin);
    }catch(error){respond(res,Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:400,{error:text(error.message,1000),...(typeof error.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?{code:error.code}:{})},origin);}finally{inFlight--;}
  });
  server.requestTimeout=35000;server.headersTimeout=5000;server.maxRequestsPerSocket=1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  endpoint='http://127.0.0.1:'+server.address().port;
  try{
    await mkdir(discoveryDirectory,{recursive:true,mode:0o700});
    const directoryInfo=await lstat(discoveryDirectory);if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink()||await realpath(discoveryDirectory)!==discoveryDirectory)throw Error('Development capability directory must be a real project directory');
    const previous=await lstat(discoveryFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(previous?.isSymbolicLink()||previous&&!previous.isFile())throw Error('Development capability file must be a regular file');
    const temporary=discoveryFile+'.'+session+'.tmp';
    try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify({version:1,root,session,endpoint,token,pid:process.pid}));}finally{await file.close();}await rename(temporary,discoveryFile);discoveryOwned=true;}finally{await rm(temporary,{force:true});}
  }catch(error){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw error;}
  return {endpoint,token,session,executeTool,browserEvent,addServerLog,recordBuild,recordRequest,snapshot:view,bootstrap:{version:1,endpoint,token,session},
    setHostRelayState(value={}){let origin;try{const url=new URL(value.origin);if(['https:','http:'].includes(url.protocol))origin=url.origin;}catch{}hostRelayState={enabled:value.enabled===true,linked:value.linked===true,...(origin?{origin}:{}),...(Number.isFinite(value.lastSeen)?{lastSeen:value.lastSeen}:{}),...(value.error?{error:safeText(value.error,1000)}:{})};},
    setAppUrl(value){appUrl=value;const url=new URL(value);origins.add(url.origin);for(const host of ['127.0.0.1','localhost','[::1]'])origins.add(url.protocol+'//'+host+':'+url.port);},
    async close(){
      if(closed)return;closed=true;assistants.clear();
      try{await replays.close();}
      finally{
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
        if(discoveryOwned){let owned;try{owned=JSON.parse(await readFile(discoveryFile,'utf8'));}catch{}if(owned?.session===session&&owned?.token===token)await rm(discoveryFile,{force:true});}
      }
    }
  };
}
