import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {requestFrames,requestBodyState,REQUEST_BODY_CHUNK} from './request-transport.mjs';
import {runApi} from './api.mjs';

const descriptor=length=>({id:1,method:'POST',bodyStream:{version:1,length,maxBytes:32*1024*1024}});
const dataFrame=bytes=>{const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return Buffer.concat([header,bytes]);};
const options=(credit)=>({authenticate:token=>assert.equal(token,'secret'),streamBodies:true,credit});
const feed=(source,input)=>source.write('secret\n'+JSON.stringify(input)+'\n');

test('stream headers dispatch before body/EOF; each application pull grants exactly one bounded frame',async()=>{
  const source=new PassThrough();let credits=0;
  const frames=requestFrames(source,options(async frame=>{assert.deepEqual(frame,{id:1,type:'bodycredit',length:REQUEST_BODY_CHUNK});credits++;}));
  feed(source,descriptor(3));const {value:input}=await frames.next();
  assert.ok(input.body instanceof ReadableStream);assert.equal(credits,0);
  const reader=input.body.getReader(),pending=reader.read();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(credits,1);
  source.write(dataFrame(Buffer.from('abc')));assert.deepEqual((await pending).value,Buffer.from('abc'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(credits,1,'no prefetch while handler does not read');
  const eof=reader.read();source.write(Buffer.alloc(4));assert.deepEqual(await eof,{done:true,value:undefined});
  assert.equal(credits,2);assert.equal(input[requestBodyState].bytes,3);assert.equal(input[requestBodyState].complete,true);
  assert.equal((await frames.next()).done,true);source.destroy();
});

test('stream framing rejects unnegotiated, ambiguous and unsafe descriptors before application dispatch',async()=>{
  for(const [input,settings]of [[descriptor(0),{}],[descriptor(0),{streamBodies:true}],
    [{...descriptor(1),bodyLength:1},options(()=>{})],[descriptor(-1),options(()=>{})],
    [descriptor(33554433),options(()=>{})],[{...descriptor(0),method:'GET'},options(()=>{})]]){
    const source=new PassThrough();feed(source,input);
    const frames=requestFrames(source,settings);
    await assert.rejects(frames.next());source.destroy();
  }
});

test('oversized frames, truncated frames and length mismatch cannot produce a complete body',async()=>{
  for(const payload of [Buffer.from([0,1,0,1]),Buffer.from([0,0,0,4,1]),Buffer.alloc(4)]){
    const source=new PassThrough();const frames=requestFrames(source,options(async()=>{}));feed(source,descriptor(3));
    const input=(await frames.next()).value;const body=input.body.getReader().read();source.end(payload);
    await assert.rejects(body);assert.equal(input[requestBodyState].complete,false);await frames.return();source.destroy();
  }
});

test('native body failures retain bounded status and cancelling a reader emits a separate cancel control',async()=>{
  const source=new PassThrough(),controls=[];const frames=requestFrames(source,options(async value=>controls.push(value)));feed(source,descriptor(null));
  const input=(await frames.next()).value;const reader=input.body.getReader();const first=reader.read();source.write(Buffer.from([255,255,255,255,1]));
  await assert.rejects(first,error=>error.code==='PRNEXT_BODY_LIMIT'&&error.statusCode===413);
  assert.equal(source.destroyed,false,'well-framed body failure can still receive its HTTP error response');await frames.return();source.destroy();
  const second=new PassThrough(),events=[];const next=requestFrames(second,options(async event=>events.push(event)));feed(second,descriptor(null));
  const stream=(await next.next()).value.body;await stream.cancel();assert.deepEqual(events,[{id:1,type:'bodycancel'}]);await next.return();second.destroy();
});

test('App Route Handler processes first bytes and returns response headers while upload EOF is still held',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'prnext-ingress-'));const modulePath=path.join(root,'handler.mjs');
  await writeFile(modulePath,`export async function POST(request){const reader=request.body.getReader();const first=await reader.read();return new Response(new ReadableStream({async start(c){c.enqueue(first.value);try{for(;;){const next=await reader.read();if(next.done)break;c.enqueue(next.value);}c.close();}catch(error){c.error(error);}},cancel(reason){return reader.cancel(reason);}}),{headers:{'x-first-byte-seen':String(first.value[0])}});}`);
  let input;const body=new ReadableStream({start(controller){input=controller;}},{highWaterMark:0});
  try{
    const result=runApi({modulePath,route:{router:'app',kind:'api'},url:'http://localhost/upload',method:'POST',body,stream:true});
    input.enqueue(Buffer.from('first'));
    const response=await result;assert.equal(response.status,200);assert.equal(response.headers['x-first-byte-seen'],'102');
    const reader=response.body[Symbol.asyncIterator]();assert.equal(Buffer.from((await reader.next()).value).toString(),'first');
    input.enqueue(Buffer.from('last'));input.close();let tail='';for(;;){const next=await reader.next();if(next.done)break;tail+=Buffer.from(next.value).toString();}assert.equal(tail,'last');
  }finally{await rm(root,{recursive:true,force:true});}
});
