import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

// Private control plane. Request headers and bodies never cross this endpoint.
export async function createDevCompilerBroker({compile,maxPending=64}) {
  const token=randomBytes(32).toString('base64url');let pending=0;
  const server=http.createServer(async(req,res)=>{
    const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
    if(req.method!=='POST'||req.url!=='/compile'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403).end();return;}
    if(pending>=maxPending){res.writeHead(503).end();return;}
    pending++;
    try{
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw Error('Compiler request too large');chunks.push(chunk);}
      // Decode once: an HTTP chunk boundary may split a UTF-8 route name.
      const input=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));if(typeof input.pattern!=='string'||!input.pattern.startsWith('/')||input.pattern.length>4096)throw Error('Invalid route pattern');
      if(input.sources!==undefined&&(!Array.isArray(input.sources)||input.sources.length>32||!input.sources.every(p=>typeof p==='string'&&p.startsWith('/')&&p.length<=4096)))throw Error('Invalid retained route patterns');
      const directory=await compile(input.pattern,input.sources||[]);
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({directory}));
    }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:String(error.message).slice(0,2048)}));}
    finally{pending--;}
  });
  server.requestTimeout=125000;server.headersTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {descriptor:JSON.stringify({port:server.address().port,token}),close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}

export function deferredCompiler(descriptor,{root,home}) {
  const value=JSON.parse(descriptor);
  if(!Number.isInteger(value.port)||value.port<1||value.port>65535||!/^[\w-]{43}$/.test(value.token))throw Error('Invalid private compiler endpoint');
  return async(pattern,signal,sources=[])=>{
    const response=await fetch(`http://127.0.0.1:${value.port}/compile`,{method:'POST',headers:{authorization:'Bearer '+value.token,'content-type':'application/json'},body:JSON.stringify({pattern,sources}),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)])});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Deferred route compilation failed');
    const directory=await realpath(path.resolve(root,result.directory)),parent=await realpath(home),relative=path.relative(parent,directory);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Compiler generation escaped its development session');
    const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
    if(!manifest.dev||manifest.devSession!==path.basename(parent))throw Error('Invalid development generation');
    return {distDir:directory,manifest};
  };
}
