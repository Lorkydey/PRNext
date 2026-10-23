import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {binary,standaloneFixture,startServer,freePort} from './support.mjs';
import {build} from '../packages/prnext/build/index.mjs';

function connect(port,route='/',headers={}){
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path:route,headers:{host:'socket.example',connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':randomBytes(16).toString('base64'),'sec-websocket-protocol':'echo',...headers}});
    req.once('upgrade',(response,socket,head)=>resolve({response,socket,head}));
    req.once('response',response=>{response.resume();resolve({response});});
    req.once('error',reject);req.end();
  });
}
test('WebSocket proxy preserves handshakes, binary streams, generation leases and drain cancellation',{timeout:30000},async t=>{
  const sockets=new Set();let upgrades=0;
  const backend=createServer((req,res)=>res.end('http'));
  backend.on('upgrade',(req,socket,head)=>{
    upgrades++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    if(req.url==='/refused'){socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\n\r\nDenied');return;}
    const accept=req.url==='/bad-accept'?'invalid':createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: echo\r\nSet-Cookie: ws=1\r\nX-Original-Host: ${req.headers.host}\r\n\r\n`);
    if(head.length)socket.write(head);socket.on('data',data=>socket.write(data));
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const child=spawn(binary,['persistent-proxy'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let id=0,buffer='',stderr='';const waiting=new Map();let ready;
  const initialized=new Promise(resolve=>ready=resolve);
  child.stderr.on('data',data=>stderr+=data);
  child.stdout.on('data',data=>{buffer+=data;for(let end;(end=buffer.indexOf('\n'))>=0;){const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(value.type==='ready')ready();else {const pending=waiting.get(value.id);waiting.delete(value.id);value.ok?pending.resolve(value.value):pending.reject(new Error(value.error));}}});
  const closed=once(child,'close');
  const rpc=(command,extra={})=>new Promise((resolve,reject)=>{const key=++id;waiting.set(key,{resolve,reject});child.stdin.write(JSON.stringify({id:key,command,app:'web',...extra})+'\n');});
  t.after(async()=>{child.stdin.end();await closed;for(const socket of sockets)socket.destroy();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));assert.equal(stderr,'');});
  await initialized;
  const {port}=await rpc('listen',{hostname:'127.0.0.1',port:0});
  await rpc('activate',{generation:'first',port:backend.address().port});
  const before=upgrades;
  assert.equal((await connect(port,'/',{'sec-websocket-key':'invalid'})).response.statusCode,400);assert.equal(upgrades,before);
  assert.equal((await connect(port,'/bad-accept')).response.statusCode,502);
  assert.equal((await connect(port,'/refused')).response.statusCode,403);
  const {response,socket}=await connect(port);socket.on('error',()=>{});
  t.after(()=>socket.destroy());
  assert.equal(response.statusCode,101);assert.equal(response.headers['sec-websocket-protocol'],'echo');assert.equal(response.headers['x-original-host'],'socket.example');assert.deepEqual(response.headers['set-cookie'],['ws=1']);
  const payload=randomBytes(512*1024);
  const received=new Promise((resolve,reject)=>{const chunks=[];let size=0;const timer=setTimeout(()=>reject(new Error('WebSocket binary stream stalled')),5000);socket.on('data',chunk=>{chunks.push(chunk);size+=chunk.length;if(size===payload.length){clearTimeout(timer);resolve(Buffer.concat(chunks));}});});
  socket.write(payload);assert.deepEqual(await received,payload);
  assert.equal((await rpc('status')).generations.first,1,'101 response must retain generation lease through tunnel lifetime');
  await rpc('activate',{generation:'second',port:backend.address().port});
  const socketClosed=once(socket,'close');
  assert.equal((await rpc('retire',{generation:'first',timeout:100})).drained,false);await socketClosed;
  assert.deepEqual(Object.keys((await rpc('status')).generations),['second']);
  const last=await connect(port);last.socket.on('error',()=>{});const lastClosed=once(last.socket,'close');
  await rpc('close');await lastClosed;
});

test('native external rewrites and multi-app host forward actual WebSocket upgrades',{timeout:60000},async()=>{
  const fixture=await standaloneFixture('prnext-ws-rewrite-');
  const sockets=new Set();
  const backend=createServer();backend.on('upgrade',(req,socket)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: echo\r\n\r\n`);socket.on('data',data=>socket.write(data));
  });
  backend.listen(0,'127.0.0.1');await once(backend,'listening');let server,host;
  try{
    await writeFile(path.join(fixture.root,'prnext.config.mjs'),`export default {async rewrites(){return [{source:'/socket',destination:'http://127.0.0.1:${backend.address().port}/socket'}]}}`);
    await build(fixture.root);server=await startServer(fixture.root);
    const direct=await connect(Number(new URL(server.url).port),'/socket');assert.equal(direct.response.statusCode,101);direct.socket.destroy();
    const port=await freePort(),config=path.join(fixture.root,'host.json');
    await writeFile(config,JSON.stringify({hostname:'127.0.0.1',port,memoryMb:1024,apps:[{name:'socket',root:fixture.root,hosts:['socket.example'],memoryMb:512,idleSeconds:1}]}));
    host=spawn(binary,['host',config,'--node',process.execPath,'--shutdown-on-stdin-eof'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let logs='';host.stdout.on('data',data=>logs+=data);host.stderr.on('data',data=>logs+=data);
    const deadline=Date.now()+10000;while(!logs.includes(String(port))&&Date.now()<deadline){if(host.exitCode!==null)throw new Error(logs);await new Promise(resolve=>setTimeout(resolve,50));}
    const hosted=await connect(port,'/socket');assert.equal(hosted.response.statusCode,101,logs);
    const echoed=once(hosted.socket,'data');hosted.socket.write('tunnel');assert.equal((await echoed)[0].toString(),'tunnel');
    await new Promise(resolve=>setTimeout(resolve,1500));
    const stillAlive=once(hosted.socket,'data');hosted.socket.write('still-active');assert.equal((await stillAlive)[0].toString(),'still-active','active tunnel protects host from idle retirement');hosted.socket.destroy();
  }finally{
    if(host&&host.exitCode===null){const closed=once(host,'close');host.stdin.end();await closed;}
    await server?.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>backend.close(resolve));await fixture.remove();
  }
});
