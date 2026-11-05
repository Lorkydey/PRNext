import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {requestLoopback,serveLoopback} from './loopback-rpc.mjs';

// Private control plane. Request headers and bodies never cross this endpoint.
export async function createDevCompilerBroker({compile,maxPending=64}) {
  const token=randomBytes(32).toString('base64url'),sockets=new Set();let pending=0;
  const server=createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    serveLoopback(socket,{token,context:'development-compiler',timeout:120000,maxResponseBytes:65536,handle:async(input,admission)=>{
      if(pending>=maxPending)throw Error('Development compiler is busy. Retry shortly.');
      pending++;
      try{
        if(typeof input.pattern!=='string'||!input.pattern.startsWith('/')||input.pattern.length>4096)throw Error('Invalid route pattern');
        if(input.sources!==undefined&&(!Array.isArray(input.sources)||input.sources.length>32||!input.sources.every(p=>typeof p==='string'&&p.startsWith('/')&&p.length<=4096)))throw Error('Invalid retained route patterns');
        const directory=await compile(input.pattern,input.sources||[],admission);
        return {directory};
      }finally{pending--;}
    }});
  });
  server.maxConnections=64;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {descriptor:JSON.stringify({version:2,port:server.address().port,token}),close:()=>new Promise(resolve=>{server.close(resolve);for(const socket of sockets)socket.destroy();})};
}

export function deferredCompiler(descriptor,{root,home}) {
  const value=JSON.parse(descriptor);
  if(value.version!==2||!Number.isInteger(value.port)||value.port<1||value.port>65535||!/^[\w-]{43}$/.test(value.token))throw Error('Invalid private compiler endpoint');
  return async(pattern,signal,sources=[])=>{
    const result=await requestLoopback(value,{pattern,sources},{context:'development-compiler',signal,timeout:120000,maxResponseBytes:65536});
    const directory=await realpath(path.resolve(root,result.directory)),parent=await realpath(home),relative=path.relative(parent,directory);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Compiler generation escaped its development session');
    const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
    if(!manifest.dev||manifest.devSession!==path.basename(parent))throw Error('Invalid development generation');
    return {distDir:directory,manifest};
  };
}
