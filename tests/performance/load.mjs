// Closed-loop keep-alive load. Every started request is drained; no planned
// disconnects contaminate throughput/error counts. Cancellation is a separate test.
import http from 'node:http';
const [url,seconds='30',connections='64'] = process.argv.slice(2);
const duration=Number(seconds)*1000, concurrency=Number(connections);
const agent=new http.Agent({keepAlive:true,maxSockets:concurrency,maxFreeSockets:concurrency});
const start=performance.now(), startCpu=process.cpuUsage(), end=start+duration;
const histogram=new Uint32Array(120001); let count=0,errors=0,bytes=0,started=0,completedWithinWindow=0;
const statuses={};
let maxLatencyMs=0,latencyOverflow=0;
async function lane(i){
  while(performance.now()<end){
    started++;
    const before=performance.now();
    await new Promise(resolve=>{
      const req=http.get(url,{agent,headers:{'accept-encoding':'gzip',cookie:'user=load'+i}},res=>{
        statuses[res.statusCode]=(statuses[res.statusCode]||0)+1;
        if(res.statusCode!==200)errors++;
        res.on('data',data=>bytes+=data.length);
        res.once('error',()=>{errors++;resolve()});
        res.once('end',()=>{count++;if(performance.now()<=end)completedWithinWindow++;const ms=performance.now()-before;maxLatencyMs=Math.max(maxLatencyMs,ms);if(ms>=12000)latencyOverflow++;histogram[Math.min(120000,Math.floor(ms*10))]++;resolve()});
      });
      req.once('error',()=>{errors++;resolve()});req.setTimeout(35000,()=>req.destroy(new Error('timeout')));
    });
  }
}
await Promise.all(Array.from({length:concurrency},(_,i)=>lane(i)));
agent.destroy();
function percentile(p){const target=Math.ceil(count*p);let n=0;for(let i=0;i<histogram.length;i++){n+=histogram[i];if(n>=target)return i/10}return null}
const cpu=process.cpuUsage(startCpu),elapsedSeconds=(performance.now()-start)/1000;
console.log(JSON.stringify({durationSeconds:Number(seconds),elapsedSeconds,generatorCpuPercent:100*(cpu.user+cpu.system)/1e6/elapsedSeconds,connections:concurrency,started,count,completedWithinWindow,rps:completedWithinWindow/Number(seconds),errors,bytes,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),maxLatencyMs,latencyOverflow,statuses}));
