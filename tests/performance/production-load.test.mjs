import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {randomUUID} from 'node:crypto';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import path from 'node:path';import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),folder=fileURLToPath(new URL('./',import.meta.url));
for(const mode of ['valid','status','invalid','row-corrupt','disconnect'])test('generator accounts '+mode+' without counting failed useful throughput',async()=>{
 const server=http.createServer((req,res)=>{if(mode==='disconnect')return req.socket.destroy();res.statusCode=mode==='status'?503:200;const user=req.headers.cookie?.slice(5);res.end(JSON.stringify({user:mode==='invalid'?'wrong-user':user,nonce:randomUUID(),rows:Array.from({length:16},(_,id)=>({id,value:mode==='row-corrupt'?'wrong':'value '+id}))}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const directory=await mkdtemp(path.join(folder,'harness-test-'));
 try{const config=path.join(directory,'config.json');await writeFile(config,JSON.stringify({url:'http://127.0.0.1:'+server.address().port,route:'/api/json',seconds:.25,connections:2}));const {stdout}=await execute(process.execPath,[path.join(folder,'production-load.mjs'),config]);const result=JSON.parse(stdout);assert.equal(result.started,result.completed+result.transportErrors);if(mode==='valid'){assert.equal(result.errors,0);assert.ok(result.rps>0);assert.ok(result.usefulCompleted>0);}else{assert.equal(result.rps,0);assert.equal(result.usefulCompleted,0);assert.ok(result.errors>0);if(mode==='status')assert.ok(result.httpErrors>0);if(mode==='invalid'||mode==='row-corrupt')assert.ok(result.validationErrors>0);if(mode==='disconnect')assert.ok(result.transportErrors>0);}}
 finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('generator validates large dynamic HTML without retaining whole response strings',async()=>{
 const padding='x'.repeat(512*1024);
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(padding+' user:'+req.headers.cookie.slice(5)+' nonce:'+randomUUID());});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const directory=await mkdtemp(path.join(folder,'harness-test-'));
 try{
  const config=path.join(directory,'config.json');await writeFile(config,JSON.stringify({url:'http://127.0.0.1:'+server.address().port,route:'/ssr',seconds:3,connections:1}));
  const {stdout}=await execute(process.execPath,['--max-old-space-size=64',path.join(folder,'production-load.mjs'),config],{timeout:15000,maxBuffer:1024*1024});const result=JSON.parse(stdout);
  assert.equal(result.errors,0);assert.equal(result.started,result.usefulCompleted);assert.ok(result.usefulCompleted>0);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
