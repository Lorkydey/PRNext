'use strict';

const WINDOW = 32, MAX_VALUE = 2 * 1024 * 1024, MAX_RESPONSE = 16 * 1024 * 1024;
const TYPE = 'application/x-prnext-flight-delta';
const MAGIC = new Uint8Array([80,82,68,49]);
const BLOCK_BYTES = 32 * 1024, MAX_COMMANDS_PER_CHUNK = 256, MAX_COMMANDS = 2048;
let POWER = 1; for(let n=1;n<WINDOW;n++) POWER = Math.imul(POWER,31) >>> 0;
function hash(bytes,offset) { let result=0; for(let n=0;n<WINDOW;n++) result=(Math.imul(result,31)+bytes[offset+n])>>>0; return result; }
function createIndex(base) {
  const index=new Map();
  for(let offset=0;offset+WINDOW<=base.length;offset+=WINDOW) {
    const key=hash(base,offset), candidates=index.get(key)||[];
    if(candidates.length<4)candidates.push(offset); index.set(key,candidates);
  }
  return index;
}
function frame(tag,a,b) { const value=new Uint8Array(tag===1?9:5), view=new DataView(value.buffer); value[0]=tag;view.setUint32(1,a);if(tag===1)view.setUint32(5,b);return value; }
function encodeChunk(bytes,base,index) {
  const output=[];let cursor=0,literal=0,key=bytes.length>=WINDOW?hash(bytes,0):0,work=0,commands=0;
  const budget=bytes.length*8+32768;
  const emit=end=>{if(end>literal){commands++;output.push(frame(0,end-literal),bytes.subarray(literal,end));}};
  while(cursor+WINDOW<=bytes.length) {
    if(work>budget||commands>=MAX_COMMANDS_PER_CHUNK)return null;
    let match=-1;
    for(const offset of index.get(key)||[]) {let n=0;while(n<WINDOW&&bytes[cursor+n]===base[offset+n]){n++;work++;}if(n===WINDOW){match=offset;break;}}
    if(match!==-1) {
      emit(cursor);let length=WINDOW;
      while(cursor+length<bytes.length&&match+length<base.length&&bytes[cursor+length]===base[match+length]){length++;work++;}
      commands++;output.push(frame(1,match,length));cursor+=length;literal=cursor;
      if(cursor+WINDOW<=bytes.length)key=hash(bytes,cursor);
    } else {
      key=(Math.imul((key-Math.imul(bytes[cursor],POWER))>>>0,31)+bytes[cursor+WINDOW])>>>0;cursor++;
    }
  }
  emit(bytes.length);if(commands>MAX_COMMANDS_PER_CHUNK)return null;output.commands=commands;return output;
}
function join(parts,size) { const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result; }
// Commands are a wire format, not scheduling units. Thousands of tiny writes
// defeat gzip and multiply worker IPC/socket work even when the raw delta saves
// bytes. Bound each outgoing block without reading ahead into a delayed chunk.
function blocks(parts) {
  const output=[];let pending=[],size=0;
  const flush=()=>{if(size)output.push(pending.length===1?pending[0]:join(pending,size));pending=[];size=0;};
  for(const part of parts)for(let offset=0;offset<part.length;){const n=Math.min(BLOCK_BYTES-size,part.length-offset);pending.push(part.subarray(offset,offset+n));size+=n;offset+=n;if(size===BLOCK_BYTES)flush();}
  flush();return output;
}
function collectStream(source,{onComplete,onCancel,onFinally,capture=true}={}) {
  const reader=source.getReader(), parts=[];let size=0,complete=false,finished=false;
  const finish=()=>{if(!finished){finished=true;onFinally?.();}};
  return new ReadableStream({
    async pull(controller) {try{const next=await reader.read();if(next.done){complete=true;if(capture&&size<=MAX_VALUE)onComplete?.(join(parts,size));parts.length=0;finish();controller.close();return;}if(!(next.value instanceof Uint8Array))throw new Error('Invalid Flight bytes');size+=next.value.length;if(size>MAX_RESPONSE)throw new Error('Flight exceeds transport budget');if(capture&&size<=MAX_VALUE)parts.push(next.value.slice());else parts.length=0;controller.enqueue(next.value);}catch(error){parts.length=0;finish();controller.error(error);await reader.cancel(error).catch(()=>{});}},
    async cancel(reason){parts.length=0;finish();if(!complete)onCancel?.();await reader.cancel(reason);},
  },{highWaterMark:0});
}
async function deltaStream(source,base,{assess}={}) {
  const reader=source.getReader(), first=await reader.read();
  if(first.done)return {delta:false,body:new ReadableStream({start(c){c.close();}})};
  // A short first chunk always selects ordinary Flight. Do not build a base
  // index that this response cannot use, or wait for a later streaming chunk.
  let index=first.value.length>=WINDOW&&base instanceof Uint8Array&&base.length<=MAX_VALUE?createIndex(base):null;
  const profitable=(raw,frames,initial)=>frames&&frames.reduce((n,b)=>n+b.length,0)+(initial?5:1)<raw.length*0.9&&(!assess||assess(raw,join(initial?[MAGIC,...frames,new Uint8Array([2])]:frames,frames.reduce((n,b)=>n+b.length,0)+(initial?5:0)))===true);
  const firstFrames=index&&first.value.length>=WINDOW?encodeChunk(first.value,base,index):null;
  let useDelta;
  try{useDelta=!!profitable(first.value,firstFrames,true);}catch(error){await reader.cancel(error).catch(()=>{});throw error;}
  let pending=useDelta?blocks([MAGIC,...firstFrames]):[first.value], pendingAt=0,ended=false,tail=false,commands=firstFrames?.commands||0;
  if(!useDelta){base=undefined;index=undefined;}
  return {delta:!!useDelta,body:new ReadableStream({
    async pull(controller){try{
      if(pendingAt===pending.length&&!ended){pending=[];pendingAt=0;const next=await reader.read();
        if(next.done){ended=true;if(useDelta&&!tail)pending=[new Uint8Array([2])];}
        else if(useDelta&&!tail){const encoded=encodeChunk(next.value,base,index);commands+=encoded?.commands||0;
          if(commands>MAX_COMMANDS||!profitable(next.value,encoded,false)){tail=true;index=undefined;base=undefined;pending=blocks([new Uint8Array([3]),next.value]);}
          else pending=blocks(encoded);
        }else pending=[next.value];
      }
      if(pendingAt<pending.length)controller.enqueue(pending[pendingAt++]);else if(ended)controller.close();
    }catch(error){pending=[];base=undefined;index=undefined;controller.error(error);await reader.cancel(error).catch(()=>{});}},
    cancel(reason){pending=[];base=undefined;index=undefined;ended=true;return reader.cancel(reason);},
  },{highWaterMark:0})};
}
function decodeStream(source,base) {
  const reader=source.getReader();let chunks=[],head=0,available=0,offset=0,total=0,wireTotal=0,started=false,ended=false,tail=false,commands=0;
  function consume(size){
    const first=chunks[head];
    if(first&&first.length-offset>=size){const result=first.subarray(offset,offset+size);offset+=size;available-=size;if(offset===first.length){head++;offset=0;}return result;}
    const result=new Uint8Array(size);let written=0;
    while(written<size){const value=chunks[head],count=Math.min(size-written,value.length-offset);result.set(value.subarray(offset,offset+count),written);written+=count;offset+=count;available-=count;if(offset===value.length){head++;offset=0;}}
    return result;
  }
  async function take(size) {
    if(size>MAX_RESPONSE)throw new Error('Invalid Flight delta frame size');
    while(available<size){const next=await reader.read();if(next.done)throw new Error('Truncated Flight delta');if(!(next.value instanceof Uint8Array))throw new Error('Invalid Flight delta bytes');wireTotal+=next.value.length;if(wireTotal>MAX_RESPONSE+1024*1024)throw new Error('Flight delta wire budget exceeded');if(next.value.length){if(head){chunks=chunks.slice(head);head=0;}chunks.push(next.value);available+=next.value.length;}}
    return consume(size);
  }
  function peek(at){let index=head,position=offset+at;while(index<chunks.length){if(position<chunks[index].length)return chunks[index][position];position-=chunks[index++].length;}}
  function bufferedCommand(){
    if(!available)return false;
    const tag=peek(0);if(tag!==0&&tag!==1)return true;
    if(available<(tag===1?9:5))return false;
    const length=tag===1?0:((peek(1)*0x1000000)+(peek(2)<<16)+(peek(3)<<8)+peek(4));
    return length>MAX_RESPONSE||available>=5+length;
  }
  async function pullTail(controller){
    const next=available?{value:await take(available),done:false}:await reader.read();
    if(next.done){ended=true;controller.close();return;}
    if(!(next.value instanceof Uint8Array))throw new Error('Invalid Flight delta bytes');
    total+=next.value.length;if(total>MAX_RESPONSE)throw new Error('Decoded Flight exceeds transport budget');controller.enqueue(next.value);
  }
  return new ReadableStream({
    async pull(controller){try{
      if(tail)return await pullTail(controller);
      if(!started){const magic=await take(4);if(!magic.every((value,n)=>value===MAGIC[n]))throw new Error('Unsupported Flight delta version');started=true;}
      if(ended)return controller.close();
      const output=[];let size=0;
      do {
      // Publish decoded data before waiting for another source chunk or the
      // final EOF. This preserves Suspense flushes and downstream backpressure.
      if(output.length&&(!bufferedCommand()||peek(0)===2||peek(0)===3))break;
      if(++commands>65536)throw new Error('Flight delta command budget exceeded');
      const [tag]=await take(1);let value;
      if(tag===3){tail=true;return await pullTail(controller);}
      if(tag===2){ended=true;if(available)throw new Error('Trailing Flight delta data');const rest=await reader.read();if(!rest.done)throw new Error('Trailing Flight delta data');controller.close();return;}
      if(tag===0){const header=await take(4),length=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(0);if(!length)throw new Error('Empty Flight delta literal');value=await take(length);}
      else if(tag===1){const header=await take(8),view=new DataView(header.buffer,header.byteOffset,header.byteLength),start=view.getUint32(0),length=view.getUint32(4);if(!length||start+length>base.length)throw new Error('Invalid Flight delta reference');value=base.subarray(start,start+length);}
      else throw new Error('Invalid Flight delta command');
      total+=value.length;if(total>MAX_RESPONSE)throw new Error('Decoded Flight exceeds transport budget');output.push(value);size+=value.length;
      }while(size<BLOCK_BYTES);
      controller.enqueue(output.length===1?output[0]:join(output,size));
    }catch(error){chunks=[];controller.error(error);await reader.cancel(error).catch(()=>{});}},
    cancel:reason=>{chunks=[];return reader.cancel(reason);},
  },{highWaterMark:0});
}
function createFlightTransport() {
  let current,serial=0;
  return {
    snapshot(){return current;},
    async response(response,base) {
      const version=++serial;
      const token=response.headers.get('x-prnext-flight-token'), headers=new Headers(response.headers);
      let source=response.body;
      if(!source)return response;
      if(headers.get('content-type')?.startsWith(TYPE)) {
        if(!base||headers.get('x-prnext-flight-base')!==base.token){await source.cancel();throw new Error('Missing Flight delta base');}
        source=decodeStream(source,base.bytes);
      }
      headers.set('content-type','text/x-component; charset=utf-8');headers.delete('content-length');headers.delete('content-encoding');
      return new Response(collectStream(source,{capture:!!token&&/^[a-f0-9]{48}$/.test(token),onComplete:bytes=>{if(version===serial&&token&&/^[a-f0-9]{48}$/.test(token))current={token,bytes};}}),{status:response.status,statusText:response.statusText,headers});
    },
    clear(){serial++;current=undefined;},
  };
}
module.exports={TYPE,MAX_VALUE,createIndex,encodeChunk,deltaStream,decodeStream,collectStream,createFlightTransport};
