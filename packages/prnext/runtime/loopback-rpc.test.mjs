import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter,once} from 'node:events';
import {createHmac} from 'node:crypto';
import {requestLoopback,serveLoopback} from './loopback-rpc.mjs';
import {rpc} from './persistent/common.mjs';

const protocol='prnext-loopback-v2',context='persistent-supervisor',token='dummy-test-capability-never-a-real-credential';
const test=(name,run)=>nodeTest(name,{timeout:10000},run);
const mac=(role,client,server,...body)=>createHmac('sha256',token).update(JSON.stringify([protocol,context,role,client,server,...body])).digest('hex');
const frame=value=>JSON.stringify({protocol,...value})+'\n';
async function listener(t,accept,port=0){
  const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});accept(socket);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const close=()=>new Promise(resolve=>{if(!server.listening){resolve();return;}server.close(resolve);for(const socket of sockets)socket.destroy();});
  t.after(close);return {port:server.address().port,close};
}
function reader(socket){
  socket.setEncoding('utf8');
  let buffer='',waiting;const received=[];
  socket.on('data',chunk=>{buffer+=chunk.toString('utf8');for(let end;(end=buffer.indexOf('\n'))>=0;){const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(waiting){const {resolve}=waiting;waiting=null;resolve(value);}else received.push(value);}});
  socket.on('close',()=>{if(waiting){waiting.reject(Error('closed'));waiting=null;}});
  return ()=>received.length?Promise.resolve(received.shift()):new Promise((resolve,reject)=>waiting={resolve,reject});
}
async function raw(t,port){const socket=net.connect({host:'127.0.0.1',port});socket.on('error',()=>{});t.after(()=>socket.destroy());const next=reader(socket);await once(socket,'connect');return {socket,next};}

test('authenticated loopback RPC carries UTF-8 and never sends the reusable key',async t=>{
  let wire='',calls=0;
  const endpoint=await listener(t,socket=>{socket.on('data',chunk=>wire+=chunk.toString());serveLoopback(socket,{token,context,handle:request=>{calls++;return request;}});});
  const value={command:'echo',path:'/caf\u00e9/\ud83d\ude42'};
  assert.deepEqual(await requestLoopback({...endpoint,token},value,{context,timeout:5000}),value);
  assert.equal(calls,1);assert.ok(!wire.includes(token));
  const messages=wire.trim().split('\n').map(JSON.parse);assert.deepEqual(messages.map(message=>message.type),['hello','request']);
  assert.equal(messages[0].body,undefined);assert.equal(messages[0].token,undefined);
});

test('bounded dummy port squatting receives only a nonce; a later genuine owner still works with the same key',async t=>{
  let captured='';
  const squatter=await listener(t,socket=>socket.on('data',chunk=>{captured+=chunk.toString();socket.end(JSON.stringify({ok:true,value:{version:1}})+'\n');}));
  await assert.rejects(rpc({...squatter,token},{command:'dummy-private-command'},1000),/Cannot authenticate.*older PRNext supervisor/);
  const hello=JSON.parse(captured.trim());assert.equal(hello.type,'hello');assert.equal(hello.body,undefined);
  assert.ok(!captured.includes(token));assert.ok(!captured.includes('dummy-private-command'));
  const port=squatter.port;await squatter.close();
  const genuine=await listener(t,socket=>serveLoopback(socket,{token,context,handle:()=>({version:2,ready:true})}),port);
  assert.deepEqual(await rpc({...genuine,token},{command:'ping'},1000),{version:2,ready:true});
});

test('wrong keys, wrong service contexts and reflected server proofs cannot dispatch a command',async t=>{
  let calls=0;const endpoint=await listener(t,socket=>serveLoopback(socket,{token,context,handle:()=>++calls}));
  await assert.rejects(requestLoopback({...endpoint,token:'wrong'},{command:'stop'},{context,timeout:1000}),/authentication failed/);
  await assert.rejects(requestLoopback({...endpoint,token},{command:'stop'},{context:'development-compiler',timeout:1000}),/authentication failed/);
  const {socket,next}=await raw(t,endpoint.port),client='1'.repeat(64);socket.write(frame({type:'hello',client}));
  const challenge=await next();assert.equal(challenge.proof,mac('server',client,challenge.server));
  const closed=once(socket,'close');socket.write(frame({type:'request',body:JSON.stringify({command:'stop'}),proof:challenge.proof}));await closed;
  assert.equal(calls,0);
});

test('request proofs bind the exact payload and cannot replay after a fresh server challenge',async t=>{
  let calls=0;const endpoint=await listener(t,socket=>serveLoopback(socket,{token,context,handle:request=>{calls++;return request.command;}}));
  const client='2'.repeat(64),body=JSON.stringify({command:'first'}),first=await raw(t,endpoint.port);
  first.socket.write(frame({type:'hello',client}));const challenge=await first.next();
  const signed={type:'request',body,proof:mac('request',client,challenge.server,body)};
  first.socket.write(frame(signed));const response=await first.next();assert.equal(JSON.parse(response.body).value,'first');
  assert.equal(response.proof,mac('response',client,challenge.server,body,response.body));
  const replay=await raw(t,endpoint.port);replay.socket.write(frame({type:'hello',client}));const fresh=await replay.next();
  assert.notEqual(fresh.server,challenge.server);
  const replayClosed=once(replay.socket,'close');replay.socket.write(frame(signed));await replayClosed;
  const changed=await raw(t,endpoint.port);changed.socket.write(frame({type:'hello',client}));const next=await changed.next();
  const changedClosed=once(changed.socket,'close');changed.socket.write(frame({type:'request',body:JSON.stringify({command:'changed'}),proof:mac('request',client,next.server,body)}));await changedClosed;
  assert.equal(calls,1);
});

test('a second signed command on one connection is never dispatched',async t=>{
  let calls=0,finish,entered;const started=new Promise(resolve=>entered=resolve);
  const endpoint=await listener(t,socket=>serveLoopback(socket,{token,context,handle:async()=>{calls++;entered();await new Promise(resolve=>finish=resolve);return 'done';}}));
  const client='3'.repeat(64),body=JSON.stringify({command:'first'}),{socket,next}=await raw(t,endpoint.port);
  socket.write(frame({type:'hello',client}));const challenge=await next(),signed=frame({type:'request',body,proof:mac('request',client,challenge.server,body)});
  socket.write(signed);await started;const closed=once(socket,'close');socket.write(signed);await closed;finish();assert.equal(calls,1);
});

test('a protocol close before the handler microtask prevents dispatch',async t=>{
  class Socket extends EventEmitter {
    writes=[];destroyed=false;
    write(value){this.writes.push(value);}
    destroy(){if(!this.destroyed){this.destroyed=true;this.emit('close');}}
    end(value){this.write(value);this.destroy();}
  }
  const socket=new Socket();t.after(()=>socket.destroy());let calls=0;
  serveLoopback(socket,{token,context,handle:()=>++calls});
  const client='8'.repeat(64),body=JSON.stringify({command:'stop'});
  socket.emit('data',Buffer.from(frame({type:'hello',client})));const challenge=JSON.parse(socket.writes[0]);
  socket.emit('data',Buffer.from(frame({type:'request',body,proof:mac('request',client,challenge.server,body)})+'{invalid json\n'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(socket.destroyed,true);assert.equal(calls,0);
});

test('UTF-8 request bytes may span chunks without changing the authenticated payload',async t=>{
  let partial;const receivedPartial=new Promise(resolve=>partial=resolve);
  const endpoint=await listener(t,socket=>{
    socket.on('data',chunk=>{if(!chunk.includes(10))partial();});
    serveLoopback(socket,{token,context,handle:request=>request.path});
  });
  const {socket,next}=await raw(t,endpoint.port),client='5'.repeat(64),body=JSON.stringify({path:'/caf\u00e9'});
  socket.write(frame({type:'hello',client}));const challenge=await next();
  const bytes=Buffer.from(frame({type:'request',body,proof:mac('request',client,challenge.server,body)})),split=bytes.indexOf(Buffer.from('\u00e9'))+1;
  socket.write(bytes.subarray(0,split));await receivedPartial;socket.write(bytes.subarray(split));
  const response=await next();assert.equal(JSON.parse(response.body).value,'/caf\u00e9');
});

test('a valid challenge does not make a tampered response acceptable',async t=>{
  const endpoint=await listener(t,socket=>{
    const next=reader(socket);
    void (async()=>{const hello=await next(),server='4'.repeat(64);socket.write(frame({type:'challenge',server,proof:mac('server',hello.client,server)}));const request=await next();const original=JSON.stringify({ok:true,value:'original'});socket.end(frame({type:'response',body:JSON.stringify({ok:true,value:'tampered'}),proof:mac('response',hello.client,server,request.body,original)}));})().catch(()=>socket.destroy());
  });
  await assert.rejects(requestLoopback({...endpoint,token},{command:'ping'},{context,timeout:1000}),/authentication failed/);
});

test('frame/body limits and absolute handshake deadlines bound unauthenticated peers',async t=>{
  let calls=0;const endpoint=await listener(t,socket=>serveLoopback(socket,{token,context,handshakeTimeout:100,handle:()=>++calls}));
  await assert.rejects(requestLoopback({...endpoint,token},{command:'x'.repeat(65536)},{context,timeout:1000}),/too large/);
  const oversized=await raw(t,endpoint.port),oversizedClosed=once(oversized.socket,'close');oversized.socket.write('x'.repeat(1025));await oversizedClosed;
  const silent=await raw(t,endpoint.port),silentClosed=once(silent.socket,'close');await silentClosed;
  assert.equal(calls,0);
});

test('an oversized response and a non-finishing authenticated peer cannot bypass client bounds',async t=>{
  const oversized=await listener(t,socket=>{
    const next=reader(socket);
    void (async()=>{const hello=await next(),server='6'.repeat(64);socket.write(frame({type:'challenge',server,proof:mac('server',hello.client,server)}));const request=await next(),body=JSON.stringify({ok:true,value:'x'.repeat(1500)});socket.end(frame({type:'response',body,proof:mac('response',hello.client,server,request.body,body)}));})().catch(()=>socket.destroy());
  });
  await assert.rejects(requestLoopback({...oversized,token},{command:'ping'},{context,timeout:1000,maxResponseBytes:128}),/too large/);
  let entered;const dispatched=new Promise(resolve=>entered=resolve);
  const stalled=await listener(t,socket=>{
    const next=reader(socket);
    void (async()=>{const hello=await next(),server='7'.repeat(64);socket.write(frame({type:'challenge',server,proof:mac('server',hello.client,server)}));await next();entered();socket.write('{');})().catch(()=>socket.destroy());
  });
  const rejected=assert.rejects(requestLoopback({...stalled,token},{command:'ping'},{context,timeout:500}),/timed out/);
  await dispatched;await rejected;
});
