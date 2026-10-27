import {devToolResult} from './dev-tools-result.mjs';
import {open,realpath,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {devToolDefinitions} from './dev-tools-server.mjs';

/** Read only this project's private capability, never a URL supplied by a tool. */
export async function readDevToolsConnection(directory){
  const root=await realpath(directory),container=path.join(root,'.prnext-dev'),filename=path.join(container,'tools.json');
  const parent=await lstat(container).catch(error=>{if(error.code==='ENOENT')throw Error('Start prnext dev in this project before connecting its MCP.');throw error;});
  if(!parent.isDirectory()||parent.isSymbolicLink()||await realpath(container)!==container)throw Error('Invalid development connection directory');
  const info=await lstat(filename).catch(error=>{if(error.code==='ENOENT')throw Error('Start prnext dev in this project before connecting its MCP.');throw error;});
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error('Invalid development connection file');
  if(process.platform!=='win32'&&(info.mode&0o077))throw Error('Development connection file must be private (0600)');
  const handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let value;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>4096||stat.ino!==info.ino)throw Error('Development connection file changed');value=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
  let endpoint;try{endpoint=new URL(value.endpoint);}catch{throw Error('Invalid development endpoint');}
  if(value.version!==1||value.root!==root||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||!Number.isInteger(value.pid)||value.pid<=0||!/^[\w-]{40,100}$/.test(value.token||''))throw Error('Invalid development connection file');
  try{process.kill(value.pid,0);}catch{throw Error('Development session is no longer running. Restart prnext dev.');}
  return value;
}
export async function callLocalDevTool(directory,name,args={}, {client='PRNext stdio MCP',fetcher=fetch,assistantId,leaseId}={}){
  if(!devToolDefinitions.some(tool=>tool.name===name))throw Error('Unknown development tool');
  const connection=await readDevToolsConnection(directory);
  const response=await fetcher(connection.endpoint+'/v1/tools/'+name,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json','X-PRNext-Client':client.slice(0,100),...(assistantId?{'X-PRNext-Assistant':assistantId,'X-PRNext-Lease':leaseId}:{})},body:JSON.stringify(args),signal:AbortSignal.timeout(name==='dev_verify'?35000:30000)});
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'Local development tool failed'),{code:result.code});
  if(result.session!==connection.session)throw Error('Development session changed; retry the tool');return result;
}
/** Initialized stdio sessions stay connected while their input pipe is alive. */
export function createDevAssistantLease(directory,{fetcher=fetch,heartbeatMs=10000}={}){
  const instanceId=randomUUID();let client='PRNext MCP client',started=false,closed=false,timer,pending,lease,closing,lastBeat=0;
  async function post(connection,body,timeout=3000){
    const response=await fetcher(connection.endpoint+'/v1/assistant',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
    const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'Assistant initialization failed'),{code:result.code});
    if(result.session!==connection.session)throw Error('Development session changed; retry initialization');return result;
  }
  function maintain(force=false){
    if(closed)return Promise.resolve(false);if(pending)return pending;
    pending=(async()=>{
      const connection=await readDevToolsConnection(directory);
      if(lease&&lease.connection.session!==connection.session)lease=undefined;
      if(lease&&!force&&Date.now()-lastBeat<heartbeatMs)return true;
      if(lease){
        try{await post(connection,{event:'heartbeat',instanceId,leaseId:lease.id});lastBeat=Date.now();return true;}
        catch(error){if(error.code!=='assistant_lease_expired')throw error;lease=undefined;}
      }
      const result=await post(connection,{event:'register',instanceId,client});
      if(typeof result.leaseId!=='string'||!/^[\w-]{20,100}$/.test(result.leaseId))throw Error('Invalid assistant initialization reply');
      lease={id:result.leaseId,connection};lastBeat=Date.now();return true;
    })().catch(()=>false).finally(()=>{pending=undefined;});return pending;
  }
  return {
    async start(info){
      if(started||closed)return maintain();started=true;
      if(typeof info?.name==='string'&&info.name.trim())client=info.name.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,100);
      const ready=await maintain();if(!closed){timer=setInterval(()=>void maintain(true),heartbeatMs);timer.unref?.();}return ready;
    },
    async call(name,args){
      if(closed)throw Error('MCP session closed');if(!started)throw Error('Initialize the MCP session first');
      if(!await maintain()||!lease)throw Error('The development assistant connection is unavailable. Start prnext dev in this project.');
      const invoke=()=>callLocalDevTool(directory,name,args,{fetcher,client:'PRNext stdio MCP',assistantId:instanceId,leaseId:lease.id});
      try{return await invoke();}catch(error){
        // Expired leases are rejected before a tool executes, so only this error
        // can safely reinitialize and retry without duplicating a mutation.
        if(error.code!=='assistant_lease_expired'||closed)throw error;lease=undefined;
        if(!await maintain(true)||!lease)throw error;return invoke();
      }
    },
    close(){
      if(closing)return closing;closed=true;clearInterval(timer);
      closing=(async()=>{await pending;if(lease)try{await post(lease.connection,{event:'unregister',instanceId,leaseId:lease.id},1000);}catch{}lease=undefined;})();return closing;
    },
  };
}
export function devMcpReply(message,invoke){
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')throw Error('Invalid JSON-RPC request');
  if(Object.hasOwn(message,'id')&&message.id!==null&&!['string','number'].includes(typeof message.id))throw Error('Invalid JSON-RPC id');
  if(!Object.hasOwn(message,'id'))return;
  const reply=result=>({jsonrpc:'2.0',id:message.id,result});
  if(message.method==='initialize')return reply({protocolVersion:['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'PRNext local development',version:'1.0.0'},instructions:'Local project development only. After edits, dev_verify checks the previous snapshot sequence and browser confirmation, not functional behavior. Read dev_replay_list and the saved scenario before explicitly starting dev_replay_run with test fixture parameters. Replays execute the recorded local application interactions; poll dev_replay_result and report its exact generation, expectations and observed result. Preserve the intended expectations when fixing application code. Missing browser, fixtures or generation evidence is inconclusive. No shell or arbitrary file access is exposed.'});
  if(message.method==='ping')return reply({});
  if(message.method==='tools/list')return reply({tools:devToolDefinitions});
  if(message.method==='tools/call')return Promise.resolve().then(()=>invoke(message.params?.name,message.params?.arguments||{})).then(result=>{
    const formatted=devToolResult(result);
    // MCP carries both readable text and structured JSON. Bound the complete
    // Replay envelope, including that duplication and its attached PNG.
    if(message.params?.name?.startsWith('dev_replay_')&&Buffer.byteLength(JSON.stringify(formatted))>500*1024)throw Error('Replay report exceeds the MCP response limit. Export or remove an older scenario, or request one run by its identifier. No verification was inferred.');
    return reply(formatted);
  }).catch(error=>reply({content:[{type:'text',text:String(error.message).slice(0,2000)}],isError:true}));
  return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
}
/** MCP stdio is newline-delimited JSON. Stdout contains protocol messages only. */
export async function runDevMcp(directory,{input=process.stdin,output=process.stdout,invoke,assistant=createDevAssistantLease(directory)}={}){
  const pending=new Set(),decoder=new StringDecoder('utf8');let buffer='',discard=false,initializeSeen=false,initialized=false,clientInfo,initializing,stopping=false;
  const write=value=>{if(value)output.write(JSON.stringify(value)+'\n');};
  async function dispatch(message){
    if(message?.method==='initialize'){
      const result=devMcpReply(message,invoke);if(result?.result){initializeSeen=true;clientInfo=message.params?.clientInfo;}return result;
    }
    if(message?.jsonrpc==='2.0'&&message.method==='notifications/initialized'&&!Object.hasOwn(message,'id')){
      if(initializeSeen&&!initialized){initialized=true;initializing=Promise.resolve(assistant.start(clientInfo));await initializing;}return;
    }
    if(message?.method==='tools/list'||message?.method==='tools/call'){
      if(!initialized)return {jsonrpc:'2.0',id:message.id??null,error:{code:-32002,message:'Initialize the MCP session first.'}};
      await initializing;
    }
    return devMcpReply(message,invoke||((name,args)=>assistant.call(name,args)));
  }
  function line(value){
    if(!value.trim())return;
    let message;try{message=JSON.parse(value);}catch{write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
    if(pending.size>=16){write({jsonrpc:'2.0',id:message.id??null,error:{code:-32000,message:'Too many pending local tools'}});return;}
    // Enter initialization synchronously before accepting the next line or EOF.
    // The actual tools remain concurrent, with the initialization promise as a barrier.
    const task=dispatch(message).then(write,error=>write({jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:String(error.message).slice(0,1000)}})).finally(()=>pending.delete(task));pending.add(task);
  }
  const shutdown=()=>{stopping=true;void assistant.close();input.destroy();};
  if(input===process.stdin){process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);}
  try{
  for await(const chunk of input){
    const next=typeof chunk==='string'?chunk:decoder.write(chunk);
    for(const part of next.split(/(?<=\n)/)){
      const ends=part.endsWith('\n');
      if(!discard){buffer+=part;if(Buffer.byteLength(buffer)>256*1024){write({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request too large'}});discard=true;buffer='';}}
      if(ends){if(!discard)line(buffer);buffer='';discard=false;}
    }
  }
  if(buffer&&!discard)line(buffer+decoder.end());
  }catch(error){if(!stopping)throw error;}
  finally{await assistant.close();await Promise.allSettled(pending);if(input===process.stdin){process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);}}
}
