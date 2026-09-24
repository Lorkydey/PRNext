import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {request,specFor,validateResponse} from './protocol.mjs';
import {dataFor} from './backend.mjs';

const percentile=(a,p)=>a[Math.min(a.length-1,Math.floor(a.length*p))]??null;
export async function load({base,scenario,concurrency=4,requests=1000000,durationMs,ratePerSecond,prefix='load',constant=false}){
  const agent=new http.Agent({keepAlive:true,maxSockets:concurrency}),latencies=[],ttfb=[],headers=[],lags=[],errors={},encodings={};
  let attempts=0,httpAttempts=0,completedCycles=0,bytes=0,decodedBytes=0;const cycle= scenario==='cache-revalidation',units=cycle?4:1,cycleLatencies=[];const began=performance.now(),cpu=process.cpuUsage(),deadline=durationMs?began+durationMs:Infinity;
  try{await Promise.all(Array.from({length:concurrency},async()=>{
    while(attempts<requests&&performance.now()<deadline){
      const index=attempts++,scheduled=ratePerSecond?began+index*units*1000/ratePerSecond:undefined;
      if(scheduled!==undefined&&scheduled>=deadline){attempts--;break}
      if(scheduled!==undefined){const wait=scheduled-performance.now();if(wait>0)await delay(wait);lags.push(Math.max(0,performance.now()-scheduled))}
      try{
        const key='reval-'+prefix+'-'+index,read={path:'/cache?key='+key,expected:{kind:'cache',data:dataFor(key)}},invalidate={path:'/api/revalidate',method:'POST',body:{key},encoding:'identity',json:true,invalidation:true,expected:{invalidated:key}};
        const specs=cycle?[read,read,invalidate,read]:[specFor(scenario,index,prefix,constant)],cycleStart=performance.now();
        for(const spec of specs){httpAttempts++;const r=await request(base,spec,agent);validateResponse(r,spec);latencies.push(r.elapsedMs);ttfb.push(r.ttfbMs);headers.push(r.headersMs);bytes+=r.bytes;decodedBytes+=r.decodedBytes;encodings[r.encoding]=(encodings[r.encoding]||0)+1}
        if(cycle){completedCycles++;cycleLatencies.push(performance.now()-cycleStart)}
      }
      catch(error){const key=String(error.message).slice(0,300);errors[key]=(errors[key]||0)+1}
    }
  }))}finally{agent.destroy()}
  const elapsedMs=performance.now()-began,used=process.cpuUsage(cpu);for(const a of [latencies,ttfb,headers,lags,cycleLatencies])a.sort((a,b)=>a-b);
  return {attempts:httpAttempts,requests:latencies.length,errors,elapsedMs,requestsPerSecond:latencies.length*1000/elapsedMs,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),p99Ms:percentile(latencies,.99),ttfbP50Ms:percentile(ttfb,.5),ttfbP95Ms:percentile(ttfb,.95),ttfbP99Ms:percentile(ttfb,.99),headersP95Ms:percentile(headers,.95),meanBodyBytes:bytes/latencies.length,meanDecodedBytes:decodedBytes/latencies.length,encodings,clientCpuMs:(used.user+used.system)/1000,scheduleLagP95Ms:percentile(lags,.95),targetRatePerSecond:ratePerSecond??null,reachedCap:Boolean(durationMs)&&attempts>=requests,...(cycle?{cycles:completedCycles,cyclesPerSecond:completedCycles*1000/elapsedMs,cycleP95Ms:percentile(cycleLatencies,.95)}:{})};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)console.log(JSON.stringify(await load(JSON.parse(process.argv[2]))));
