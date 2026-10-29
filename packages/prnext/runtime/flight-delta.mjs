import { randomBytes, createHmac } from 'node:crypto';
import { TYPE, MAX_VALUE, collectStream, deltaStream } from '../compat/flight-delta.cjs';

export function createFlightStore({maxBytes=32*1024*1024,maxEntries=64,ttl=30000,maxCaptures=8,maxEncoders=2,now=Date.now}={}) {
  const entries=new Map();let size=0,captures=0,encoders=0;
  function reserve(kind){if(kind==='capture'?captures>=maxCaptures:encoders>=maxEncoders)return;kind==='capture'?captures++:encoders++;let released=false;return()=>{if(released)return;released=true;kind==='capture'?captures--:encoders--;};}
  function remove(token){const entry=entries.get(token);if(entry){size-=entry.bytes.length;entries.delete(token);}}
  function prune(){for(const[token,entry]of entries)if(entry.expires<=now())remove(token);while(size>maxBytes||entries.size>maxEntries)remove(entries.keys().next().value);}
  return {
    get(token,identity){prune();const entry=entries.get(token);if(entry?.identity!==identity)return;return entry?.bytes;},
    set(token,identity,bytes){if(bytes.length>MAX_VALUE)return;remove(token);entries.set(token,{identity,bytes,expires:now()+ttl});size+=bytes.length;prune();},
    capture:()=>reserve('capture'),encoder:()=>reserve('encoder'),get inFlight(){return {captures,encoders};},
    get bytes(){return size;},get size(){return entries.size;},
  };
}
const store=createFlightStore();
export async function differentialFlight(response,options,cache=store) {
  const headers=new Headers(options.headers), outgoing=new Headers(response.headers);
  if((options.method||'GET')!=='GET'||headers.get('rsc')!=='1'||headers.get('x-prnext-flight-accept')!=='v1'||headers.get('x-prnext-prefetch')==='1'||response.status!==200||!outgoing.get('content-type')?.startsWith('text/x-component'))return response;
  const secret=options.manifest?.app?.actionKey;if(!secret)return response;
  const identity=createHmac('sha256',secret).update(JSON.stringify([options.manifest.cacheId,headers.get('cookie')||'',headers.get('authorization')||''])).digest('hex');
  const releaseCapture=cache.capture(),token=releaseCapture?randomBytes(24).toString('hex'):undefined,previous=headers.get('x-prnext-flight-base'),candidate=cache.get(previous,identity),releaseEncoder=candidate&&cache.encoder(),base=releaseEncoder?candidate:undefined;
  let encoded;
  try{
    const raw=response.body;
    const body=raw instanceof ReadableStream?raw:raw?.[Symbol.asyncIterator]?ReadableStream.from(raw):new ReadableStream({start(controller){
      controller.enqueue(raw instanceof Uint8Array?raw:raw instanceof ArrayBuffer?new Uint8Array(raw):new TextEncoder().encode(String(raw??'')));controller.close();
    }});
    const collected=collectStream(body,{capture:!!releaseCapture,onComplete:bytes=>cache.set(token,identity,bytes),onFinally:releaseCapture});
    encoded=base?await deltaStream(collected,base):{delta:false,body:collected};
    if(!encoded.delta)releaseEncoder?.();
    else encoded.body=collectStream(encoded.body,{capture:false,onFinally:releaseEncoder});
  }catch(error){releaseEncoder?.();releaseCapture?.();throw error;}
  if(token)outgoing.set('x-prnext-flight-token',token);else outgoing.delete('x-prnext-flight-token');outgoing.set('cache-control','private, no-store');outgoing.delete('content-length');
  if(encoded.delta){outgoing.set('content-type',TYPE);outgoing.set('x-prnext-flight-base',previous);}
  return {...response,headers:Object.fromEntries(outgoing),body:encoded.body,cancel:reason=>{releaseEncoder?.();releaseCapture?.();void encoded.body.cancel(reason).catch(()=>{});return response.cancel?.(reason);}};
}
