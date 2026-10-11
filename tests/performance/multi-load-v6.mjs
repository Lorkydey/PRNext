// Bounded per-application clients. Useful throughput counts only validated 200s.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const duration = config.seconds * 1000, begin = performance.now(), end = begin + duration, cpu = process.cpuUsage();
const apps = config.apps.map((app, index) => ({ ...app, index, started: 0, completed: 0, useful: 0, within: 0, errors: 0, validationErrors: 0, rejected: 0, bytes: 0, statuses: {},
  histogram: new Uint32Array(120001), samples: [], maxLatencyMs: 0,
  agent: new http.Agent({ keepAlive: true, maxSockets: app.connections, maxFreeSockets: app.connections }) }));
const percentile = (hist, n, p) => { if (!n) return null; let total=0; for(let i=0;i<hist.length;i++) if((total+=hist[i])>=Math.ceil(n*p)) return i/10; return 12000; };
let cancelStarts=0, plannedDisconnects=0, cancelErrors=0;
const cancellations = new Set();
function cancel() {
  for (const app of apps) for(let i=0;i<4;i++) {
    cancelStarts++;
    const task=new Promise(resolve=>{
      let deliberate=false;
      const req=http.get(app.url+'/stream?delay=2000',{headers:{cookie:'user=cancel', 'accept-encoding':'identity'}},res=>{
        if(res.statusCode!==200) cancelErrors++;
        res.once('data',()=>{deliberate=true;plannedDisconnects++;req.destroy();});
        res.on('error',()=>{});res.once('close',resolve);res.resume();
      });
      req.on('error',()=>{if(!deliberate)cancelErrors++;resolve();});req.setTimeout(10000,()=>req.destroy(new Error('cancel timeout')));
    }); cancellations.add(task);task.finally(()=>cancellations.delete(task));
  }
}
const storm = config.cancellations ? setInterval(cancel, 60000).unref() : null;
function snapshot(final=false) {
  const elapsed=(performance.now()-begin)/1000, used=process.cpuUsage(cpu);
  console.log(JSON.stringify({type:final?'final':'interval',unixMs:Date.now(),elapsedSeconds:elapsed,durationSeconds:config.seconds,
    generatorCpuPercent:100*(used.user+used.system)/1e6/elapsed,cancelStarts,plannedDisconnects,cancelErrors,
    apps:apps.map(({histogram,agent,...app})=>({...app, rps:app.within/config.seconds,p50:percentile(histogram,app.useful,.5),p95:percentile(histogram,app.useful,.95),p99:percentile(histogram,app.useful,.99)}))}));
}
const timer=setInterval(()=>snapshot(),10000).unref();
async function lane(app,index) {
  let iteration=index, last=new Map();
  while(performance.now()<end) {
    const route=(app.routes||['ssr','stream','api/json'])[iteration++%(app.routes||['ssr','stream','api/json']).length];
    const user=`a${app.index}c${index}`, before=performance.now();app.started++;
    await new Promise(resolve=>{
      let done=false;const finish=()=>{if(!done){done=true;resolve();}};
      const req=http.get(app.url+'/'+route,{agent:app.agent,headers:{'accept-encoding':app.encoding||'gzip',cookie:'user='+user}},res=>{
        app.statuses[res.statusCode]=(app.statuses[res.statusCode]||0)+1;
        const chunks=[];let length=0;
        res.on('data',data=>{app.bytes+=data.length;length+=data.length;if(app.validate!==false){if(length>2*1024*1024)req.destroy(new Error('body limit'));else chunks.push(data);}});
        res.once('error',()=>{app.errors++;finish();});
        res.once('end',()=>{
          app.completed++;
          if(res.statusCode===503){app.rejected++;if(!res.headers['retry-after']||!String(res.headers['cache-control']).includes('no-store'))app.validationErrors++;}
          else if(res.statusCode!==200)app.errors++;
          else {
            let valid=true;
            if(app.validate!==false)try {
              let data=Buffer.concat(chunks);if(res.headers['content-encoding']==='gzip')data=gunzipSync(data);
              if(app.staticExpected?.[route]) {
                const expected=app.staticExpected[route];
                valid=data.length===expected.bytes&&createHash('sha256').update(data).digest('hex')===expected.sha256;
              } else {
                const body=data.toString(), value=route.startsWith('api/')?JSON.parse(body):null;
                const nonce=value?.nonce||body.match(/nonce:([0-9a-f-]{36})/)?.[1];
                valid=Boolean(nonce&&nonce!==last.get(route)&&(value?value.user===user:body.includes('user:'+user+'<')));
                last.set(route,nonce);
              }
            }catch{valid=false;}
            if(!valid)app.validationErrors++;
            else {app.useful++;if(performance.now()<=end)app.within++;const ms=performance.now()-before;app.maxLatencyMs=Math.max(app.maxLatencyMs,ms);app.histogram[Math.min(120000,Math.floor(ms*10))]++;if(app.samples.length<32)app.samples.push(ms);}
          }
          finish();
        });
      });req.once('error',()=>{app.errors++;finish();});req.setTimeout(config.timeoutMs||15000,()=>req.destroy(new Error('timeout')));
    });
    if(app.intervalMs) await new Promise(resolve=>setTimeout(resolve,Math.max(0,app.intervalMs-(performance.now()-before))));
  }
}
await Promise.all(apps.flatMap(app=>Array.from({length:app.connections},(_,i)=>lane(app,i))));
if(storm)clearInterval(storm);await Promise.all(cancellations);clearInterval(timer);
for(const app of apps)app.agent.destroy();snapshot(true);
if(apps.some(app=>app.errors||app.validationErrors)||cancelErrors)process.exitCode=1;
