// Finite burst of slow clients; deliberately closed after three seconds.
import http from 'node:http';
const urls=process.argv[2].split(','),count=Number(process.argv[3]||512);
const holdMs=Number(process.argv[4]||3000);
const result={started:0,statuses:{},unexpectedErrors:0,plannedCloses:0,invalid503:0,holdMs};
const requests=[];let closing=false;
for(let i=0;i<count;i++) {
  result.started++;
  const req=http.get(urls[i%urls.length]+'/large-v6.bin',{headers:{'accept-encoding':'identity'}},res=>{
    result.statuses[res.statusCode]=(result.statuses[res.statusCode]||0)+1;
    res.on('error',()=>{if(!closing)result.unexpectedErrors++;});
    if(res.statusCode===200)res.pause();
    else {if(res.statusCode===503&&(!res.headers['retry-after']||res.headers['cache-control']!=='no-store'))result.invalid503++;res.resume();}
  });
  req.on('error',()=>{if(!closing)result.unexpectedErrors++;});requests.push(req);
}
await new Promise(resolve=>setTimeout(resolve,holdMs));closing=true;
for(const req of requests){if(!req.destroyed){result.plannedCloses++;req.destroy();}}
await new Promise(resolve=>setTimeout(resolve,1500));
console.log(JSON.stringify(result));
