import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { startServer, repositoryRoot } from '../tests/support.mjs';

const exec = promisify(execFile);
const project = path.join(repositoryRoot, 'examples/app');
await exec(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', project]);
const server = await startServer(project);
async function memory() {
  const {stdout}=await exec('ps',['-axo','pid=,ppid=,rss=']);
  const rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  const pids=new Set([server.child.pid]);
  for(let depth=0;depth<5;depth++)for(const [pid,parent]of rows)if(pids.has(parent))pids.add(pid);
  return {rustRssMiB:(rows.find(row=>row[0]===server.child.pid)?.[2]||0)/1024,
    totalRssMiB:rows.reduce((sum,[pid,,rss])=>sum+(pids.has(pid)?rss:0),0)/1024};
}
try {
  // Start the worker and load the shared layout before observing the delayed
  // page. The measured page has independent Suspense panels at 700 / 1400 ms.
  await (await fetch(server.url)).arrayBuffer();
  const samples=[];
  for(let index=0;index<3;index++) {
    const start=performance.now();
    const response=await fetch(server.url+'/stream',{headers:{'accept-encoding':'identity'}});
    if(response.status!==200)throw new Error('Streaming demo returned '+response.status);
    const sample={headersMs:performance.now()-start,firstChunkMs:null,firstPanelMs:null,secondPanelMs:null,completeMs:null,bytes:0};
    let tail='';
    const decoder=new TextDecoder();
    for await(const chunk of response.body) {
      const elapsed=performance.now()-start;
      sample.firstChunkMs??=elapsed;
      sample.bytes+=chunk.byteLength;
      tail+=decoder.decode(chunk,{stream:true});
      if(tail.includes('<h2>First section ready</h2>'))sample.firstPanelMs??=elapsed;
      if(tail.includes('<h2>Second section ready</h2>'))sample.secondPanelMs??=elapsed;
      tail=tail.slice(-4096);
    }
    sample.completeMs=performance.now()-start;
    if(sample.firstPanelMs===null||sample.secondPanelMs===null)throw new Error('Streaming panel markup was missing');
    samples.push(Object.fromEntries(Object.entries(sample).map(([key,value])=>[key,key==='bytes'?value:+value.toFixed(2)])));
  }
  const rss=await memory();
  console.log(JSON.stringify({measuredAt:new Date().toISOString(),platform:`${os.platform()} ${os.arch()}`,cpu:os.cpus()[0]?.model,node:process.version,
    project:'examples/app',endpoint:'/stream',workers:1,concurrency:1,encoding:'identity',
    scenario:'Warm worker; two independent server components intentionally wait 700 and 1400 ms. Samples report received HTML markers, not browser paint timing.',
    memory:'RSS after all samples; includes native server and Node children/RSC threads; excludes client/build; not peak memory.',
    limitations:'Local demonstration of progressive delivery, not a Next.js comparison or a production capacity claim.',
    samples,...Object.fromEntries(Object.entries(rss).map(([key,value])=>[key,+value.toFixed(1)]))},null,2));
} finally {await server.close();}
