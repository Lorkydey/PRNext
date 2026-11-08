import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {presentationFixture,presentationSecrets} from '../presentation-fixture.mjs';
import {startServer,binary} from '../support.mjs';
import {startProcessTreeSampling} from './process-tree.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const quantile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)];
export function presentationHtml(html) {
  const section=html.match(/<section data-testid="presentation">[\s\S]*?<\/section>/)?.[0];
  assert.ok(section,'The actual presentation section must be present');
  // Dynamic streaming can interleave self-removing Flight transport scripts
  // inside this section. Their base64 contents deliberately differ between A/B.
  const rendered=section.replace(/<script(?: nonce="[^"]*")?>\(self\.__PRNEXT_FLIGHT_STREAM__\|\|=\[\]\)\.push\("[A-Za-z0-9+/=]*"\);document\.currentScript\.remove\(\)<\/script>/g,'');
  assert.ok(!rendered.includes('<script'),'Unexpected script in the presentation section');
  return rendered;
}

/** Owned loopback only. Alternating, fully validated, end-to-end A/B windows.
 * CPU/RSS observations retain their existing process-tree limitations; Windows
 * is a shared host. Do not infer production multipliers from this fixture.
 */
export async function presentationBenchmark({seconds=3,cycles=3,connections=4}={}) {
  for(const [value,min,max]of [[seconds,1,30],[cycles,1,12],[connections,1,16]])assert.ok(Number.isInteger(value)&&value>=min&&value<=max,'Invalid benchmark limits');
  const result={version:1,complete:false,environment:{node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalMemory:os.totalmem(),cpuQuota:null,nodeSha256:hash(await readFile(process.execPath)),binarySha256:hash(await readFile(binary))},settings:{seconds,cycles,connections,workers:2,warmupSeconds:1,acceptEncoding:'identity',cache:'force-dynamic',order:'alternating AB / BA',network:'owned loopback'},windows:[],browser:[],artifacts:{},limitations:['A synthetic presentation-heavy page on a shared developer machine; no universal throughput multiplier or production SLO is established.','The load generator shares CPU with the server and validates completed bodies.','HTTP throughput includes transport, Flight, SSR and body completion. The client script/time/heap measurements are separate cold Chromium contexts.','Summed RSS is sampled across the owned native process and descendants and includes shared pages; it is not unique memory or a leak proof. Browser CDP heap covers the page isolate, not total browser memory.']};
  const fixtures={},servers={};let browser;
  result.environment.sourceDigests={};
  for(const name of ['build/app.mjs','build/presentation.mjs','build/config.mjs','build/index.mjs','runtime/presentation.mjs','runtime/rsc-worker.mjs','runtime/app-stream-html.mjs'])result.environment.sourceDigests[name]=hash(await readFile(new URL('../../packages/prnext/'+name,import.meta.url)));
  result.environment.benchmarkSha256=hash(await readFile(fileURLToPath(import.meta.url)));
  try {
    for(const mode of ['ordinary','compact']) {
      const fixture=fixtures[mode]=await presentationFixture({enabled:mode==='compact'});
      const built=await fixture.build();
      servers[mode]=await startServer(fixture.root,['--workers','2']);
      result.artifacts[mode]={tableSourceSha256:hash(await readFile(path.join(fixture.root,'app/Table.jsx'))),presentationReport:built.presentationReport||null};
    }
    const expected=new Map();
    async function request(mode,rows,rsc) {
      const response=await fetch(`${servers[mode].url}/?rows=${rows}`,{headers:{'accept-encoding':'identity',...(rsc?{RSC:'1'}:{})},signal:AbortSignal.timeout(15000)});
      assert.equal(response.status,200);
      const body=await response.text();
      for(const secret of presentationSecrets)assert.ok(!body.includes(secret));
      assert.ok(body.includes(`Product ${rows-1}`));
      const key=rows+':'+rsc;
      if(!rsc){const digest=hash(presentationHtml(body));if(expected.has(key))assert.equal(digest,expected.get(key));else expected.set(key,digest);}
      return Buffer.byteLength(body);
    }
    for(const rows of [100,1000]) for(const mode of ['ordinary','compact']) {
      const htmlBytes=await request(mode,rows,false),flightBytes=await request(mode,rows,true);
      (result.artifacts[mode].payloads||=[]).push({rows,htmlBytes,flightBytes,tableHtmlSha256:expected.get(rows+':false')});
    }
    async function load(mode,rows,rsc,duration) {
      const elapsed=[],bytes=[];let errors=0;const started=performance.now(),deadline=started+duration*1000;
      await Promise.all(Array.from({length:connections},async()=>{
        while(performance.now()<deadline){const begin=performance.now();try{bytes.push(await request(mode,rows,rsc));elapsed.push(performance.now()-begin);}catch(error){errors++;if(errors<=3)console.error(error.message);}}
      }));
      const durationMs=performance.now()-started;
      assert.equal(errors,0,'Every measured response must validate');
      return {requests:elapsed.length,errors,durationMs,requestsPerSecond:elapsed.length/(durationMs/1000),p50Ms:quantile(elapsed,.5),p95Ms:quantile(elapsed,.95),p99Ms:quantile(elapsed,.99),responseBytes:bytes[0]};
    }
    for(const [rows,rsc]of [[100,false],[1000,false],[1000,true]]) for(let cycle=0;cycle<cycles;cycle++) for(const mode of cycle%2?['compact','ordinary']:['ordinary','compact']) {
      await load(mode,rows,rsc,1);
      const sampler=startProcessTreeSampling(servers[mode].child.pid,{intervalMs:1000});await sampler.ready;
      const measured=await load(mode,rows,rsc,seconds);
      const processes=await sampler.stop();
      const window={mode,rows,rsc,cycle,...measured,processes};result.windows.push(window);
      console.log(JSON.stringify({mode,rows,rsc,cycle,rps:measured.requestsPerSecond,p95:measured.p95Ms,p99:measured.p99Ms,memory:processes.peakRssBytes}));
    }
    browser=await chromium.launch();
    let browserTable;
    for(let cycle=0;cycle<cycles;cycle++) for(const mode of cycle%2?['compact','ordinary']:['ordinary','compact']) {
      const context=await browser.newContext();
      try {
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
        const started=performance.now();await page.goto(`${servers[mode].url}/?rows=1000`,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>performance.getEntriesByName('presentation-hydrated').length>0);
        const hydrationMarkMs=await page.evaluate(()=>performance.getEntriesByName('presentation-hydrated')[0].startTime);
        await page.getByTestId('counter').click();await page.getByTestId('counter').filter({hasText:'Count 1'}).waitFor();
        const interactiveMs=performance.now()-started;
        await page.waitForLoadState('networkidle');
        const snapshot=await page.locator('section[data-testid="presentation"]').innerHTML();
        if(browserTable)assert.equal(hash(snapshot),browserTable);else browserTable=hash(snapshot);
        const resources=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation')[0].toJSON(),scripts:performance.getEntriesByType('resource').filter(item=>item.initiatorType==='script'||/\.js(?:\?|$)/.test(item.name)).map(item=>({name:new URL(item.name).pathname,encodedBodySize:item.encodedBodySize,decodedBodySize:item.decodedBodySize,transferSize:item.transferSize,duration:item.duration}))}));
        const metrics=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
        assert.deepEqual(errors,[]);
        result.browser.push({mode,cycle,hydrationMarkMs,interactiveMs,tableDomSha256:browserTable,...resources,scriptDurationSeconds:metrics.ScriptDuration,taskDurationSeconds:metrics.TaskDuration,jsHeapUsedSize:metrics.JSHeapUsedSize});
      }finally{await context.close();}
    }
    result.complete=true;return result;
  }finally{await browser?.close();for(const mode of ['ordinary','compact']){await servers[mode]?.close();await fixtures[mode]?.remove();}}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const output=process.argv[2];
  if(!output||process.argv.length!==3)throw new Error('Usage: node tests/performance/presentation-benchmark.mjs <output.json>');
  const report=await presentationBenchmark();await mkdir(path.dirname(path.resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(`Validated benchmark saved to ${path.resolve(output)}`);
}
