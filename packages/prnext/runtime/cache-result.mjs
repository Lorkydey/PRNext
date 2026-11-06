// Private, versioned cache bytes. These packets never become browser Flight.
import {isUtf8} from 'node:buffer';
const MAGIC=Buffer.from([0x50,0x52,0x4e,0x43,2]);
const HEADER=MAGIC.length+1;
export const CACHE_RESULT_LIMIT=16*1024*1024;
export const CACHE_RESULT_KEY_VERSION='flight-primitives-v2';
const SCALAR_LIMIT=CACHE_RESULT_LIMIT-64*1024;
function packet(type,payload=Buffer.alloc(0)){
  if(payload.length>CACHE_RESULT_LIMIT)throw new Error('Cached React result exceeds the 16 MiB rendering limit');
  const bytes=Buffer.allocUnsafe(HEADER+payload.length);MAGIC.copy(bytes);bytes[MAGIC.length]=type;payload.copy(bytes,HEADER);return bytes;
}
function textPacket(type,value,length){
  const bytes=Buffer.allocUnsafe(HEADER+length);MAGIC.copy(bytes);bytes[MAGIC.length]=type;bytes.write(value,HEADER,length,'utf8');return bytes;
}
export function primitiveCacheResult(value){
  if(value===null)return packet(1);
  switch(typeof value){
    case 'undefined':return packet(2);
    case 'boolean':return packet(value?3:4);
    case 'number':{const bytes=Buffer.allocUnsafe(8);bytes.writeDoubleLE(value);return packet(5,bytes);}
    case 'bigint':{const text=String(value);return text.length>SCALAR_LIMIT?undefined:textPacket(6,text,text.length);}
    case 'string':{
      // Leave framing-sensitive boundary values to the official Flight limit.
      if(value.length>SCALAR_LIMIT)return undefined;
      // Flight's small JSON strings and large UTF8 text rows do not normalize
      // lone surrogates or BOMs alike. Keep any such string on the fallback,
      // independently of React's text-row threshold or chunk boundaries.
      if(!value.isWellFormed()||value.includes('\ufeff'))return undefined;
      const length=Buffer.byteLength(value);
      if(length>SCALAR_LIMIT)return undefined;
      return textPacket(7,value,length);
    }
    // In particular, do not enumerate objects, inspect then, or read a proxy or
    // getter. React owns every nonprimitive result and its temporary references.
    default:return undefined;
  }
}
export function flightCacheResult(chunks,size){
  if(size>CACHE_RESULT_LIMIT)throw new Error('Cached React result exceeds the 16 MiB rendering limit');
  // Ordinary Flight keeps its original bytes and sole aggregate copy. Reserve
  // the whole first-byte family for this private protocol, without assuming
  // anything about React's current or future row syntax. Inspect the aggregate
  // so an empty leading chunk cannot hide a reserved first byte.
  const bytes=Buffer.concat(chunks,size);
  return isCacheResultPacket(bytes)?packet(0,bytes):bytes;
}
export function isCacheResultPacket(bytes){return bytes[0]===MAGIC[0];}
export function readCacheResult(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<HEADER||bytes.length>HEADER+CACHE_RESULT_LIMIT||!bytes.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('Invalid RSC cache result envelope');
  const type=bytes[MAGIC.length],payload=bytes.subarray(HEADER);
  // Unwrap an escaped raw payload once; never interpret it as another packet.
  if(type===0&&isCacheResultPacket(payload))return {flight:payload};
  if(type>=1&&type<=4&&payload.length===0)return {value:type===1?null:type===2?undefined:type===3};
  if(type===5&&payload.length===8)return {value:payload.readDoubleLE()};
  if(type===6&&payload.length&&/^(?:0|-?[1-9]\d*)$/.test(payload.toString()))return {value:BigInt(payload.toString())};
  if(type===7&&isUtf8(payload))return {value:payload.toString()};
  throw new Error('Invalid RSC cache result envelope');
}
