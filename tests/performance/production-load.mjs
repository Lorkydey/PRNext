import http from 'node:http';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {hasFixtureTable,fixtureTableRowCount} from './production-html-validation.mjs';
import {createLatencyHistogram} from './latency-histogram.mjs';
const cfg=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!Number.isFinite(cfg.seconds)||cfg.seconds<=0||cfg.seconds>86400||!Number.isInteger(cfg.connections??16)||(cfg.connections??16)<1||(cfg.connections??16)>128)throw Error('Invalid load duration or concurrency');
if(cfg.mode==='open'&&(!Number.isFinite(cfg.rate)||cfg.rate<=0||cfg.rate>100000))throw Error('Invalid arrival rate');
if(cfg.rsc&&(cfg.route==='mixed'||fixtureTableRowCount(cfg.route)))throw Error('RSC Flight table responses are not decoded by this generator; use HTML mode for table routes.');
const endpoint=new URL(cfg.url);if(!['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname)||endpoint.protocol!=='http:')throw Error('Benchmark load is restricted to private loopback HTTP');
const seconds=cfg.seconds,concurrency=cfg.connections||16,agent=new http.Agent({keepAlive:true,maxSockets:cfg.mode==='open'?128:concurrency,maxFreeSockets:128});
const start=performance.now(),end=start+seconds*1000,cpu=process.cpuUsage();
const hist=createLatencyHistogram(),goodHist=createLatencyHistogram(),firstHist=createLatencyHistogram(),scheduleHist=createLatencyHistogram(),statuses={},failures={};
let started=0,completed=0,within=0,usefulWithin=0,usefulCompleted=0,errors=0,statusErrors=0,validationErrors=0,bytes=0,inflight=0,peakInflight=0,planned=0,dropped=0,late=0,maxLatencyMs=0,overflow=0;
const seen=new Set(),perRoute={},tasks=new Set();
const expectedPayload=Buffer.from('Identical private PRNext and Next.js benchmark payload.\n'.repeat(1024));
function bucket(hist,value){hist.record(value);}
function validate(body,res,route,user){
 if(res.statusCode!==200)return false;
 if(route==='/payload.txt')return body.equals(expectedPayload);
 if(route==='/static')return body.includes('Static fixture')&&hasFixtureTable(body,route);
 let value;if(route.includes('/api/')){value=JSON.parse(body);if(value.user!==user||!Array.isArray(value.rows)||value.rows.length!==16||value.rows.some((row,id)=>row.id!==id||row.value!=='value '+id))return false;}
 else if(!body.includes('user:'+user))return false;
 if(!hasFixtureTable(body,route))return false;
 const nonce=value?.nonce||body.toString().match(/nonce:([0-9a-f-]{36})/)?.[1];
 // A regexp capture may be a V8 sliced string retaining the complete HTML.
 // Keep an independent tiny key so identity checks stay bounded on long runs.
 if(!nonce||seen.has(nonce))return false;seen.add(Buffer.from(nonce,'utf8').toString('utf8'));if(seen.size>100000)seen.delete(seen.values().next().value);
 if(route.startsWith('/stream')&&!body.includes('completed:'+user+':'+nonce))return false;
 if(route==='/guarded'&&res.headers['x-audit-middleware']!=='once')return false;
 return true;
}
function request(index,scheduled=performance.now()){
 const route=cfg.route==='mixed'?['/ssr','/stream','/api/json','/legacy'][index%4]:cfg.route;
 const user='aud-'+String(index%10000).padStart(4,'0'),began=performance.now();started++;inflight++;peakInflight=Math.max(peakInflight,inflight);
 return new Promise(resolve=>{
  let done=false,first,bodyBytes=0;const chunks=[];
  const finish=(reason,res)=>{if(done)return;done=true;clearTimeout(timer);inflight--;const now=performance.now(),ms=now-began;
   if(reason){errors++;failures[reason]=(failures[reason]||0)+1;}else{
    completed++;bucket(hist,ms);bucket(firstHist,(first??now)-began);bucket(scheduleHist,now-scheduled);maxLatencyMs=Math.max(maxLatencyMs,ms);if(now<=end)within++;
    let valid=false;if(res.statusCode!==200)statusErrors++;
    else try{let body=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')body=gunzipSync(body);else if(res.headers['content-encoding']==='br')body=brotliDecompressSync(body);valid=validate(body,res,route,user);if(!valid)validationErrors++;}catch{validationErrors++;}
    if(valid){usefulCompleted++;if(now<=end)usefulWithin++;bucket(goodHist,ms);}
   }resolve();
  };
  const headers={'accept-encoding':cfg.encoding||'identity',cookie:'user='+user,...(cfg.rsc?{rsc:'1'}:{})};
  const req=http.get(cfg.url+route,{agent,headers},res=>{
   statuses[res.statusCode]=(statuses[res.statusCode]||0)+1;perRoute[route]=(perRoute[route]||0)+1;
   res.on('data',data=>{first??=performance.now();bytes+=data.length;bodyBytes+=data.length;if(bodyBytes>4*1024*1024)req.destroy(Error('body bound'));else chunks.push(data);});
   res.once('end',()=>finish(null,res));res.once('error',()=>finish('response-error'));res.once('aborted',()=>finish('aborted'));
  });
  req.once('error',error=>finish(error.message==='deadline'?'timeout':'transport'));
  const timer=setTimeout(()=>req.destroy(Error('deadline')),10000);
 });
}
if(cfg.mode==='open'){
 let index=0;
 await new Promise(resolve=>{const timer=setInterval(()=>{const now=performance.now();if(now>=end){clearInterval(timer);resolve();return;}
  const due=Math.floor((now-start)*cfg.rate/1000);while(index<due){const scheduled=start+(index+1)*1000/cfg.rate;planned++;if(now-scheduled>5)late++;if(inflight>=128)dropped++;else{const task=request(index,scheduled);tasks.add(task);task.finally(()=>tasks.delete(task));}index++;}
 },1);});await Promise.all(tasks);
}else{
 await Promise.all(Array.from({length:concurrency},(_,lane)=>(async()=>{let n=lane;while(performance.now()<end){await request(n);n+=concurrency;}})()));
}
agent.destroy();const elapsed=(performance.now()-start)/1000,used=process.cpuUsage(cpu);
function quantile(values,p){return values.quantile(p);}
overflow=hist.overflow+goodHist.overflow+firstHist.overflow+scheduleHist.overflow;
console.log(JSON.stringify({config:cfg,durationSeconds:seconds,elapsedSeconds:elapsed,started,completed,completedWithinWindow:within,usefulCompleted,usefulWithinWindow:usefulWithin,rps:usefulWithin/seconds,totalHttpRps:within/seconds,errors:errors+statusErrors+validationErrors,transportErrors:errors,httpErrors:statusErrors,validationErrors,statuses,failures,bytes,meanWireBytes:bytes/(completed||1),p50:quantile(goodHist,.5),p95:quantile(goodHist,.95),p99:quantile(goodHist,.99),allHttpP95:quantile(hist,.95),ttfbP50:quantile(firstHist,.5),ttfbP95:quantile(firstHist,.95),ttfbP99:quantile(firstHist,.99),scheduledP95:quantile(scheduleHist,.95),maxLatencyMs,overflow,latencyHistograms:{http:hist.snapshot(),useful:goodHist.snapshot(),firstByte:firstHist.snapshot(),scheduled:scheduleHist.snapshot()},planned,dropped,late,peakInflight,perRoute,generatorCpuSeconds:(used.user+used.system)/1e6,generatorCpuPercent:100*(used.user+used.system)/1e6/elapsed}));
