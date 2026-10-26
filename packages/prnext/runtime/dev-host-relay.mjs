import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createCloudClient} from './cloud/client.mjs';
import {cloudOrigin,credentialPath,linkPath,readState} from './cloud/state.mjs';

// Explicit --host-ai only. The cloud never receives a localhost capability or
// an address to fetch: this process pulls a bounded, allowlisted command queue.
const allowed = new Set(['dev_snapshot','dev_connection','dev_logs','dev_routes','dev_route_ensure','dev_cache_invalidate','dev_verify','dev_source','dev_ai_context']);
export async function startDevHostRelay({root,tools,env=process.env,fetcher=fetch,interval=1000,signal:parentSignal}) {
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...(parentSignal?[parentSignal]:[])]);
  const link=await readState(linkPath(root));
  const origin=cloudOrigin(env.PRNEXT_CLOUD_URL||link?.origin||'https://app.prnext.dev');
  const credential=await readState(credentialPath(origin,env));
  const log=(level,message)=>tools.addServerLog(level,message,{process:'host-relay'});
  const status=value=>tools.setHostRelayState?.({enabled:true,linked:false,origin,...value});
  status({});
  if(!credential||credential.origin!==origin||!/^prn_[A-Za-z0-9_-]{43}$/.test(credential.accessToken||'')||credential.expiresAt<=Date.now()) {
    log('warn',`Host AI relay is off. Run prnext login --server ${origin}, then restart with --host-ai.`);
    status({error:'Run prnext login to connect this terminal.'});
    return {close:async()=>{}};
  }
  const api=createCloudClient(origin,{token:credential.accessToken,signal,fetcher});
  let relayId,stopped=false;
  const register=async()=>{
    const reply=await api('/ai/dev/register',{method:'POST',body:{session:tools.session,title:path.basename(root).slice(0,80),...(link?.origin===origin&&link.projectId?{projectId:link.projectId}:{})}});
    if(typeof reply.id!=='string'||reply.id.length>100)throw Error('Host returned an invalid development relay.');
    relayId=reply.id;status({linked:true,lastSeen:Date.now()});log('info','Host AI relay ready. Your existing Host MCP can discover this local development session.');
  };
  try{await register();}catch(error){const message=error.status===404?'This Host server needs the local development relay update. Local MCP remains available.':`Host AI relay unavailable: ${error.message}`;status({error:message});log('warn',message);return {close:async()=>{}};}
  async function work(command) {
    let result;
    if(!command||typeof command.id!=='string'||!allowed.has(command.tool)||!command.args||typeof command.args!=='object'||Array.isArray(command.args))
      result={error:'Unsupported development command.'};
    else if(!Number.isFinite(command.expiresAt)||command.expiresAt<=Date.now())result={error:'Development command expired before execution.'};
    else {
      try{result={result:await tools.executeTool(command.tool,command.args,{client:`Host MCP: ${String(command.client||'assistant').slice(0,70)}`})};}
      catch(error){result={error:String(error.message).slice(0,1000)};}
    }
    if(!stopped)await api('/ai/dev/result',{method:'POST',body:{id:relayId,commandId:command.id,...result}});
  }
  const running=(async()=>{
    let failures=0;
    while(!stopped){
      try{
        const reply=await api('/ai/dev/poll',{method:'POST',body:{id:relayId}});
        status({linked:true,lastSeen:Date.now()});
        for(const command of (Array.isArray(reply.commands)?reply.commands:[]).slice(0,1)) {if(stopped||signal.aborted)break;await work(command);}
        failures=0;
      }catch(error){
        if(stopped)break;
        status({error:error.message});
        if(error.status===401||error.status===403){log('warn','Host AI relay disconnected: terminal access expired or was revoked.');break;}
        if(error.status===404){try{await register();failures=0;}catch{failures++;}}
        else failures++;
        if(failures===1)log('warn','Host AI relay reconnecting; no command is replayed.');
      }
      try{await delay(Math.min(10000,interval*2**Math.min(failures,3)),undefined,{signal});}catch{break;}
    }
  })();
  return {id:relayId,async close(){
    if(stopped)return;stopped=true;controller.abort();status({enabled:false});
    // Abort long local verification without blocking development shutdown.
    await Promise.race([running,delay(100)]);
    try{await createCloudClient(origin,{token:credential.accessToken,signal:AbortSignal.timeout(1500),fetcher})('/ai/dev/close',{method:'POST',body:{id:relayId}});}catch{}
  }};
}
