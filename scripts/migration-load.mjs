import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {processTree,sample} from './bench-next-comparison.mjs';

const self=fileURLToPath(import.meta.url),exec=promisify(execFile);
const percentile=(values,p)=>values[Math.min(values.length-1,Math.floor(values.length*p))]??null;
export function workloadsFor(site){
  if(site.startsWith('boutique'))return[
    {endpoint:'/',marker:'Des objets qui restent.'},
    {endpoint:'/produit/lampe',marker:'Lampe Aube'},
    {endpoint:'/api/catalogue',marker:'Lampe Aube'},
    {endpoint:'/edge',marker:'Atelier Edge'},
  ];
  if(site==='journal')return[
    {endpoint:'/',marker:'Prendre le temps de regarder.'},
    {endpoint:'/article/foret',marker:'Une nuit dans la forêt'},
    {endpoint:'/recherche',marker:'Recherche',queryNonce:'q'},
    {endpoint:'/api/contact',method:'POST',body:'{"email":"bench@example.test"}',status:201,marker:'"subscribed":"bench@example.test"'},
  ];
  return[
    {endpoint:'/',marker:'Votre équipe, en mouvement.',cookieNonce:'visitor'},
    {endpoint:'/api/session',marker:'"visitor":',cookieNonce:'visitor'},
    {endpoint:'/projet/atlas',marker:'Projet atlas'},
  ];
}
export async function load(options){
  if(options.ratePerSecond!==undefined&&(!Number.isFinite(options.ratePerSecond)||options.ratePerSecond<=0))throw new Error('ratePerSecond must be a positive finite number');
  const agent=new http.Agent({keepAlive:true,maxSockets:options.concurrency});
  const latencies=[],firstBytes=[],scheduleLags=[],failures={},endpointCounts={},encodings={};let attempts=0,errors=0,bytes=0,decodedBytes=0;
  const cpuStart=process.cpuUsage(),start=performance.now();
  const deadline=options.durationMs?start+options.durationMs:Infinity;
  try{await Promise.all(Array.from({length:options.concurrency},async()=>{
    while(performance.now()<deadline&&attempts<(options.requests||200000)){
      const scheduled=options.ratePerSecond?start+attempts*1000/options.ratePerSecond:undefined;
      if(scheduled!==undefined&&scheduled>=deadline)break;
      const index=attempts++,nonce=`visitor-${index}`,spec=options.workloads[index%options.workloads.length];
      if(scheduled!==undefined){const wait=scheduled-performance.now();if(wait>0)await delay(wait);scheduleLags.push(Math.max(0,performance.now()-scheduled));}
      const url=new URL(spec.endpoint,options.base);if(spec.queryNonce)url.searchParams.set(spec.queryNonce,nonce);
      endpointCounts[spec.endpoint]=(endpointCounts[spec.endpoint]||0)+1;
      const began=performance.now();
      await new Promise(resolve=>{
        let finished=false;
        let firstByte;
        const finish=error=>{if(finished)return;finished=true;if(error){errors++;failures[error]=(failures[error]||0)+1}else{latencies.push(performance.now()-began);if(firstByte!==undefined)firstBytes.push(firstByte)}resolve()};
        const request=http.request(url,{agent,method:spec.method||'GET',headers:{'accept-encoding':spec.encoding||options.encoding||'identity',...spec.headers,...(spec.cookieNonce?{cookie:(spec.headers?.cookie?spec.headers.cookie+'; ':'')+spec.cookieNonce+'='+nonce}:{}),...(spec.body?{'content-type':'application/json','content-length':Buffer.byteLength(spec.body)}:{})}},response=>{
          const chunks=[];let size=0;
          response.on('data',chunk=>{firstByte??=performance.now()-began;size+=chunk.length;if(size>16*1024*1024)request.destroy(new Error('response exceeds 16 MiB'));else chunks.push(chunk)});
          response.on('error',error=>finish(error.code||error.message));response.on('end',()=>{
            const body=Buffer.concat(chunks);let decoded;
            const encoding=response.headers['content-encoding']||'identity';
            try{decoded=encoding==='gzip'?gunzipSync(body,{maxOutputLength:16*1024*1024}):encoding==='br'?brotliDecompressSync(body,{maxOutputLength:16*1024*1024}):body}catch{return finish('invalid compression')}
            const text=spec.marker||spec.queryNonce||spec.cookieNonce?decoded.toString().replace(/<!--.*?-->/gs,''):'';
            if(response.statusCode!==(spec.status||200))return finish('HTTP '+response.statusCode);
            if(spec.marker&&!text.includes(spec.marker)||(spec.queryNonce||spec.cookieNonce)&&!new RegExp(nonce+'(?![0-9])').test(text))return finish('response content mismatch');
            if(spec.minBytes&&decoded.length<spec.minBytes||spec.exactBytes&&decoded.length!==spec.exactBytes||spec.contentType&&!response.headers['content-type']?.startsWith(spec.contentType)||spec.magicBase64&&!decoded.subarray(0,Buffer.from(spec.magicBase64,'base64').length).equals(Buffer.from(spec.magicBase64,'base64')))return finish('response binary mismatch');
            bytes+=body.length;decodedBytes+=decoded.length;encodings[encoding]=(encodings[encoding]||0)+1;finish();
          });
        });
        request.setTimeout(10000,()=>request.destroy(new Error('request timeout')));
        request.on('error',error=>finish(error.code||error.message));request.end(spec.body);
      });
    }
  }))}finally{agent.destroy()}
  const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuStart);latencies.sort((a,b)=>a-b);firstBytes.sort((a,b)=>a-b);scheduleLags.sort((a,b)=>a-b);
  return{attempts,requests:latencies.length,errors,failures,endpointCounts,elapsedMs,requestsPerSecond:latencies.length*1000/elapsedMs,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),p99Ms:percentile(latencies,.99),ttfbP50Ms:percentile(firstBytes,.5),ttfbP95Ms:percentile(firstBytes,.95),meanBodyBytes:latencies.length?bytes/latencies.length:0,meanDecodedBytes:latencies.length?decodedBytes/latencies.length:0,encodings,clientCpuMs:(cpu.user+cpu.system)/1000,reachedCap:Boolean(options.durationMs)&&attempts>=(options.requests||200000),...(options.ratePerSecond?{targetRatePerSecond:options.ratePerSecond,scheduleLagP95Ms:percentile(scheduleLags,.95),scheduleLagMaxMs:scheduleLags.at(-1)}:{})};
}
async function client(options){const{stdout}=await exec(process.execPath,[self,'--load',JSON.stringify(options)],{maxBuffer:1024*1024,timeout:(options.durationMs||0)+60000});return JSON.parse(stdout)}
export async function benchmarkWorkload(server,workloads,{durationMs=2000,concurrency=4,warmupRequests=200,warmupConcurrency=concurrency,maxRequests,encoding='identity',ratePerSecond}={}){
  const idle=await processTree(server.child.pid);
  const warmup=await client({base:server.url,workloads,concurrency:warmupConcurrency,requests:warmupRequests,encoding});
  if(warmup.errors)throw new Error('Warmup failed: '+JSON.stringify(warmup.failures));
  const before=await processTree(server.child.pid),monitor=sample(server.child.pid);
  let result,after,samples;
  try{result=await client({base:server.url,workloads,concurrency,durationMs,requests:maxRequests,encoding,ratePerSecond});after=await processTree(server.child.pid)}finally{samples=await monitor.stop()}
  const disappeared=before.processes.filter(p=>!after.processes.some(q=>p.pid===q.pid));
  const serverCpuMs=after.cpuMs-before.cpuMs;
  const cpuValid=!disappeared.length&&serverCpuMs>=0;
  const rss=samples.map(s=>s.rssMiB).sort((a,b)=>a-b);
  return{concurrency,durationMs,warmupRequests,idle,afterWarmup:before,afterLoad:after,...result,
    serverCpuMs:cpuValid?serverCpuMs:null,cpuMsPerRequest:cpuValid&&result.requests?serverCpuMs/result.requests:null,
    cpuPercentOneCore:cpuValid?100*serverCpuMs/result.elapsedMs:null,cpuValid,disappearedPids:disappeared.map(p=>p.pid),
    loadMedianRssMiB:percentile(rss,.5),sampledPeakRssMiB:rss.at(-1)??null,memorySamples:samples.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===self&&process.argv[2]==='--load')console.log(JSON.stringify(await load(JSON.parse(process.argv[3]))));
