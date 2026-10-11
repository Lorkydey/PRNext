// One-hour mixed soak: bounded client state, periodic histograms and separate
// deliberate cancellations. Every ordinary request drains before final output.
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
const [base, seconds='3600', connections='64']=process.argv.slice(2);
const duration=Number(seconds)*1000, concurrency=Number(connections);
if (!(duration>=1000) || !(concurrency>=1 && concurrency<=1024)) throw new Error('Invalid duration/concurrency');
const agent=new http.Agent({keepAlive:true,maxSockets:concurrency+32,maxFreeSockets:concurrency});
const startedAt=performance.now(),end=startedAt+duration,cpu=process.cpuUsage();
let count=0,errors=0,started=0,completedWithinWindow=0,validationErrors=0,plannedDisconnects=0,cancelStarts=0;
const statuses={},cancellationStatuses={},histogram=new Uint32Array(120001),bucket=new Uint32Array(120001),routes=['ssr','stream','api/json'];
// A lane rotates routes. Comparing only its immediately preceding nonce would
// miss a separate stale cached value on each route. Keep bounded per-route state.
const lastNonce=Array.from({length:concurrency},()=>new Map()),perRoute={};let bucketCount=0,bucketStart=startedAt,lastCount=0;
let maxLatencyMs=0,latencyOverflow=0;
function percentile(hist,count,p){let total=0;for(let i=0;i<hist.length;i++){total+=hist[i];if(total>=Math.ceil(count*p))return i/10}return null}
function snapshot(final=false){
  const now=performance.now();
  console.log(JSON.stringify({type:final?'final':'interval',time:Date.now(),durationSeconds:Number(seconds),elapsedSeconds:(now-startedAt)/1000,count,started,completedWithinWindow,rps:final?completedWithinWindow/Number(seconds):(count-lastCount)/((now-bucketStart)/1000),errors,validationErrors,plannedDisconnects,cancelStarts,statuses,cancellationStatuses,perRoute,
    p50:percentile(final?histogram:bucket,final?count:bucketCount,.5),p95:percentile(final?histogram:bucket,final?count:bucketCount,.95),p99:percentile(final?histogram:bucket,final?count:bucketCount,.99),maxLatencyMs,latencyOverflow,generatorCpuPercent:100*(process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000/(now-startedAt)}));
  bucket.fill(0);bucketCount=0;lastCount=count;bucketStart=now;
}
const interval=setInterval(()=>snapshot(),10000).unref();
const pendingCancellations=new Set();
function cancellationStorm(){
  for(let i=0;i<32;i++){
    cancelStarts++;
    const task=new Promise(resolve=>{
      let deliberate=false;
      const req=http.get(base+'/stream?delay=2000',{agent,headers:{'accept-encoding':'identity',cookie:'user=cancel'+i}},res=>{
        cancellationStatuses[res.statusCode]=(cancellationStatuses[res.statusCode]||0)+1;
        res.once('data',()=>{deliberate=true;plannedDisconnects++;req.destroy();});
        res.once('error',()=>{});res.once('close',resolve);res.resume();
      });
      req.once('error',()=>{if(!deliberate)errors++;resolve();});req.setTimeout(35000,()=>req.destroy(new Error('cancel request timeout')));
    });
    pendingCancellations.add(task);task.finally(()=>pendingCancellations.delete(task));
  }
}
const storms=setInterval(cancellationStorm,60000).unref();
async function lane(index){
  let iteration=index;
  while(performance.now()<end){
    const route=routes[iteration++%routes.length],user='soak'+index,before=performance.now();started++;
    await new Promise(resolve=>{
      const req=http.get(base+'/'+route,{agent,headers:{'accept-encoding':'gzip',cookie:'user='+user}},res=>{
        statuses[res.statusCode]=(statuses[res.statusCode]||0)+1;if(res.statusCode!==200)errors++;
        const chunks=[];let length=0;
        res.on('data',data=>{length+=data.length;if(length>2*1024*1024)req.destroy(new Error('unexpected body size'));else chunks.push(data)});
        res.once('error',()=>{errors++;resolve()});
        res.once('end',()=>{
          try{
            let bytes=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes);const body=bytes.toString();
            const value=route==='api/json'?JSON.parse(body):null,nonce=value?.nonce||body.match(/nonce:([0-9a-f-]{36})/)?.[1];
            if(!nonce || nonce===lastNonce[index].get(route) || (value?value.user!==user:!body.includes('user:'+user+'<')))validationErrors++;
            lastNonce[index].set(route,nonce);
          }catch{validationErrors++}
          count++;bucketCount++;if(performance.now()<=end)completedWithinWindow++;
          const ms=performance.now()-before;maxLatencyMs=Math.max(maxLatencyMs,ms);if(ms>=12000)latencyOverflow++;
          const slot=Math.min(120000,Math.floor(ms*10));histogram[slot]++;bucket[slot]++;perRoute[route]=(perRoute[route]||0)+1;resolve();
        });
      });req.once('error',()=>{errors++;resolve()});req.setTimeout(35000,()=>req.destroy(new Error('timeout')));
    });
  }
}
await Promise.all(Array.from({length:concurrency},(_,index)=>lane(index)));
clearInterval(storms);await Promise.all(pendingCancellations);clearInterval(interval);agent.destroy();snapshot(true);
if(errors||validationErrors||Object.entries(cancellationStatuses).some(([status])=>status!=='200'))process.exitCode=1;
