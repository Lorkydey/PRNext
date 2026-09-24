import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function dataFor(key,version=0,tenant='public'){
  return {key,version,tenant,name:'Product '+key,values:[3,5,8,13,21,34,55,89]};
}
export async function startBackend(){
  const values=new Map(),events=[],gates=new Map();
  const server=http.createServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://backend');
      let body=null;if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks).toString()||'{}')}
      const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))};
      if(u.pathname==='/__control'){
        if(body?.reset){events.length=0;values.clear()}
        if(body?.clearEvents)events.length=0;
        if(body?.hold){let release;const promise=new Promise(resolve=>release=resolve);gates.set(body.hold,{promise,release})}
        if(body?.release){gates.get(body.release)?.release();gates.delete(body.release)}
        return json({events,values:Object.fromEntries(values)});
      }
      if(u.pathname!=='/data')return json({error:'not-found'},404);
      const key=req.method==='POST'?body.key:u.searchParams.get('key'),tenant=u.searchParams.get('tenant')||'public';
      if(req.method==='POST')values.set(key,(values.get(key)||0)+body.delta);
      events.push({method:req.method,key,tenant,...(req.method==='POST'?{delta:body.delta}:{})});
      const version=values.get(key)||0;
      await gates.get(key)?.promise;
      const ms=Number(u.searchParams.get('delay')||0);if(ms)await delay(ms);
      json(dataFor(key,version,tenant));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}))}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,async close(){for(const gate of gates.values())gate.release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const backend=await startBackend();process.send?.({url:backend.url});
  process.on('SIGTERM',async()=>{await backend.close();process.exit(0)});
}
