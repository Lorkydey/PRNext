import {deflateSync,inflateSync} from 'node:zlib';
import {endianness} from 'node:os';

// One microsecond through 100 ms, then 100 microseconds through 12 seconds.
// Quantiles use the upper edge, with at most one microsecond of quantization
// through 100 ms. Values inside the same bucket remain indistinguishable.
const fineLimit=100000,coarseStep=100,maxUs=12000000;
const length=fineLimit+(maxUs-fineLimit)/coarseStep+1;
export const histogramLayout=Object.freeze({version:1,unit:'microseconds',fineLimit,coarseStep,maxUs,length});
const index=us=>us<=fineLimit?us:fineLimit+Math.ceil((us-fineLimit)/coarseStep);
const upper=i=>i<=fineLimit?i:fineLimit+(i-fineLimit)*coarseStep;

export function createLatencyHistogram(){
  const counts=new Uint32Array(length);let count=0,overflow=0;
  return {
    record(ms){
      if(!Number.isFinite(ms)||ms<0)throw Error('Invalid latency sample.');
      const us=Math.ceil(ms*1000);
      if(us>maxUs){overflow++;return;}
      const slot=index(us);if(counts[slot]===0xffffffff)throw Error('Latency histogram count overflow.');counts[slot]++;count++;
    },
    quantile(p){return quantileCounts(counts,count,p);},
    get count(){return count;},get overflow(){return overflow;},
    snapshot(){
      let bytes=Buffer.from(counts.buffer,counts.byteOffset,counts.byteLength);
      if(endianness()!=='LE'){bytes=Buffer.alloc(counts.byteLength);for(let i=0;i<length;i++)bytes.writeUInt32LE(counts[i],i*4);}
      return {...histogramLayout,encoding:'uint32le-deflate-base64',count,overflow,data:deflateSync(bytes,{level:1}).toString('base64')};
    },
  };
}
function quantileCounts(counts,count,p){
  if(!Number.isFinite(p)||p<=0||p>1)throw Error('Invalid latency quantile.');
  if(!count)return null;
  const rank=Math.ceil(count*p);let total=0;
  for(let i=0;i<counts.length;i++){total+=counts[i];if(total>=rank)return upper(i)/1000;}
  throw Error('Latency histogram accounting mismatch.');
}
export function readLatencyHistogram(snapshot){
  if(!snapshot||Object.entries(histogramLayout).some(([key,value])=>snapshot[key]!==value)||snapshot.encoding!=='uint32le-deflate-base64'||!Number.isSafeInteger(snapshot.count)||snapshot.count<0||!Number.isSafeInteger(snapshot.overflow)||snapshot.overflow<0||typeof snapshot.data!=='string'||snapshot.data.length>2*length*4||snapshot.data.length%4||/[^A-Za-z0-9+/=]/.test(snapshot.data)||Buffer.from(snapshot.data,'base64').toString('base64')!==snapshot.data)throw Error('Invalid retained latency histogram.');
  const bytes=inflateSync(Buffer.from(snapshot.data,'base64'),{maxOutputLength:length*4});
  if(bytes.length!==length*4)throw Error('Invalid retained histogram byte length.');
  const counts=new Uint32Array(length);let count=0;
  for(let i=0;i<length;i++){counts[i]=bytes.readUInt32LE(i*4);count+=counts[i];}
  if(count!==snapshot.count)throw Error('Retained histogram counts do not match.');
  return {count,overflow:snapshot.overflow,quantile:p=>quantileCounts(counts,count,p)};
}
