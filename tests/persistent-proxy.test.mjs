import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {binary} from './support.mjs';

test('native persistent proxy switches generations, drains streams and never replays uploads',{timeout:60000},async t=>{
  let hits=0;
  const backend=createServer(async(req,res)=>{
    hits++;
    if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/plain'});res.write('first');return;}
    if(req.url==='/closed'){req.socket.destroy();return;}
    if(req.url==='/upload-stream'){res.writeHead(200,{'content-type':'text/plain'});req.on('data',chunk=>res.write(chunk));req.on('end',()=>res.end());return;}
    if(req.url==='/delayed'){const timer=setTimeout(()=>res.end('delayed response'),31000);req.socket.once('close',()=>clearTimeout(timer));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    res.setHeader('set-cookie',['one=1','two=2']);res.end(JSON.stringify({host:req.headers.host,forwarded:req.headers['x-forwarded-host'],body:Buffer.concat(chunks).toString('base64')}));
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const child=spawn(binary,['persistent-proxy'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let id=0,buffer='',stderr='';const waiting=new Map();let ready;
  const initialized=new Promise(resolve=>{ready=resolve;});
  child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.on('data',chunk=>{buffer+=chunk;for(let end;(end=buffer.indexOf('\n'))>=0;){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(message.type==='ready')ready();else {const pair=waiting.get(message.id);waiting.delete(message.id);message.ok?pair.resolve(message.value):pair.reject(new Error(message.error));}}});
  child.on('error',error=>{for(const pair of waiting.values())pair.reject(error);});
  const closed=once(child,'close');
  const rpc=(command,values={})=>new Promise((resolve,reject)=>{const key=++id;waiting.set(key,{resolve,reject});child.stdin.write(JSON.stringify({id:key,command,app:'web',...values})+'\n');});
  t.after(async()=>{child.stdin.end();await closed;backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));assert.equal(stderr,'');});
  await initialized;
  const {port}=await rpc('listen',{hostname:'127.0.0.1',port:0});const url=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(url)).status,503);
  const upstream=backend.address().port;
  await rpc('activate',{generation:'one',port:upstream});
  const payload=Buffer.alloc(256*1024,173);
  const response=await new Promise((resolve,reject)=>{
    const req=request(url+'/echo',{method:'POST',headers:{host:'custom.example','x-forwarded-host':'original.example'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({cookies:res.headers['set-cookie'],data:JSON.parse(Buffer.concat(chunks))}));
    });req.on('error',reject);req.end(payload);
  });
  assert.equal(response.cookies.length,2);
  assert.equal(response.data.host,'custom.example');assert.equal(response.data.forwarded,'original.example');
  assert.ok(Buffer.from(response.data.body,'base64').equals(payload));
  await new Promise((resolve,reject)=>{
    const req=request(url+'/upload-stream',{method:'POST'},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;if(text==='first')req.end('last');});
      res.on('end',()=>{try{assert.equal(text,'firstlast');resolve();}catch(error){reject(error);}});res.on('error',reject);
    });req.setTimeout(5000,()=>req.destroy(new Error('Upload was buffered instead of streamed')));req.on('error',reject);req.write('first');
  });
  const streamed=await fetch(url+'/stream'),reader=streamed.body.getReader();assert.equal(Buffer.from((await reader.read()).value).toString(),'first');
  assert.equal((await rpc('status')).generations.one,1);
  await assert.rejects(rpc('retire',{generation:'one',timeout:1}),/active generation/);
  await rpc('activate',{generation:'two',port:upstream});
  await rpc('pause',{generation:'one'});assert.equal((await fetch(url)).status,200,'late exit of previous backend cannot pause replacement');
  const began=performance.now();assert.equal((await rpc('retire',{generation:'one',timeout:100})).drained,false);assert.ok(performance.now()-began>=80);
  await assert.rejects(reader.read(),/terminated|abort|fetch|socket/i);
  assert.deepEqual(Object.keys((await rpc('status')).generations),['two']);
  const before=hits;assert.equal((await fetch(url+'/closed',{method:'POST',body:'non-idempotent'})).status,502);assert.equal(hits,before+1);
  // A fresh empty HEAD response must not retain a generation lease.
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);await head.arrayBuffer();
  const aborted=await fetch(url+'/stream');await aborted.body.cancel();
  for(let i=0;i<100&&(await rpc('status')).generations.two;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await rpc('status')).generations.two,0,'client cancellation releases the generation lease');
  const delayed=await fetch(url+'/delayed');assert.equal(delayed.status,200);assert.equal(await delayed.text(),'delayed response','local responses must not inherit the external rewrite timeout');
  await rpc('pause');assert.equal((await rpc('retire',{generation:'two',timeout:1000})).drained,true);
  // Raw request target checks must happen before reqwest URL normalization.
  const raw=target=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:target},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(await raw('/%2e%2e/private'),400);
  await rpc('close');
  await assert.rejects(fetch(url));
});
