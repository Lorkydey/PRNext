import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { saveNoteIdempotently } from '../../examples/saas-reference/lib/note-commands.js';
import { rewriteNoteAction, discardActionResponse } from './idempotency.mjs';
import { noteRequestKey } from '../../examples/saas-reference/lib/note-request-key.js';

test('pending note request UUIDs survive reload, isolate accounts/locales and rotate only explicitly',()=>{
  const records=new Map(),storage={getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value)};
  const first=noteRequestKey(storage,'alice','en');
  assert.equal(noteRequestKey(storage,'alice','en'),first,'a reload keeps the unacknowledged key');
  assert.notEqual(noteRequestKey(storage,'bob','en'),first);
  assert.notEqual(noteRequestKey(storage,'alice','fr'),first);
  assert.notEqual(noteRequestKey(storage,'alice','en',{rotate:true}),first);
  assert.ok([...records.values()].every(value=>/^[a-f0-9-]{36}$/.test(value)),'storage contains UUIDs only');
  assert.throws(()=>noteRequestKey({getItem(){throw new Error('blocked');}},'alice','en'),/blocked/);
  assert.throws(()=>noteRequestKey({getItem:()=>null,setItem(){}},'alice','en'),/could not be retained/);
  assert.throws(()=>noteRequestKey(storage,'','en'),/scope/);
  assert.throws(()=>noteRequestKey(storage,'alice','de'),/scope/);
});

test('invalid idempotency owners, keys and payloads fail before acquiring a database connection',async()=>{
  const pool={connect(){assert.fail('invalid command acquired a database connection');}};
  const valid={userId:'owner',key:randomUUID(),body:'A note'};
  for(const change of [{userId:''},{userId:'a'.repeat(129)},{key:''},{key:'not-a-uuid'},{body:''},{body:'a'.repeat(501)},{body:' padded '}]){
    await assert.rejects(saveNoteIdempotently(pool,{...valid,...change}),error=>error.code==='IDEMPOTENCY_INPUT');
  }
});

test('captured mutation rewriting requires one exact key and payload and preserves binary framing',()=>{
  const key=randomUUID(),nextKey=randomUUID(),body='INITIAL_NOTE',nextBody='NEW_NOTE';
  const original=Buffer.concat([Buffer.from([0,255]),Buffer.from('key='+key+'\r\nbody='+body),Buffer.from([0,254])]);
  const action={url:'https://127.0.0.1:1234/en/dashboard',headers:{},body:original};
  const changed=rewriteNoteAction(action,{key,nextKey,body,nextBody});
  assert.equal(changed.body[0],0);assert.equal(changed.body[1],255);assert.equal(changed.body.at(-1),254);
  assert.ok(changed.body.includes(Buffer.from(nextKey)));assert.ok(changed.body.includes(Buffer.from(nextBody)));
  assert.ok(original.includes(Buffer.from(key)),'the captured browser POST is immutable');
  for(const altered of [Buffer.from(body),Buffer.from(key+key+body),Buffer.from(key+body+body)])assert.throws(()=>rewriteNoteAction({...action,body:altered},{key,nextKey,body,nextBody}),/one exact/);
  assert.throws(()=>discardActionResponse({...action,url:'https://example.com/dashboard'}),/loopback/);
});

test('the lost-response injector sends one POST and destroys its response after committed headers',async()=>{
  const [key,cert]=await Promise.all([readFile(new URL('./certificates/localhost-key.pem',import.meta.url)),readFile(new URL('./certificates/localhost-cert.pem',import.meta.url))]);
  let posts=0,received='';const sockets=new Set();
  const server=createServer({key,cert},(request,response)=>{
    posts++;assert.equal(request.method,'POST');
    request.on('data',chunk=>{received+=chunk;});
    request.on('end',()=>{response.writeHead(200,{'content-type':'text/x-component'});response.write('committed');});
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const reply=await discardActionResponse({url:'https://127.0.0.1:'+server.address().port+'/action',headers:{'content-type':'text/plain'},body:Buffer.from('one explicit mutation')});
    assert.equal(reply.status,200);assert.equal(posts,1);assert.equal(received,'one explicit mutation');
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
