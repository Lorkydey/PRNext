import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,realpath,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {chromium} from '@playwright/test';
import {build as candidateBuild} from '../../packages/prnext/build/index.mjs';
import {presentationFixture,presentationSecrets} from '../presentation-fixture.mjs';
import {startServer,binary,repositoryRoot} from '../support.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const quantile=(values,q)=>values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)];
const transport=/<script(?: nonce="[^"]*")?>\(self\.__PRNEXT_FLIGHT_STREAM__\|\|=\[\]\)\.push\("[A-Za-z0-9+/=]*"\);document\.currentScript\.remove\(\)<\/script>/g;
const sources=['build/app.mjs','build/presentation.mjs','build/presentation-auto.mjs','build/presentation-blocks.mjs','build/presentation-html.mjs','build/presentation-cost.mjs','runtime/presentation.mjs','runtime/presentation-html.mjs','runtime/rsc-worker.mjs','runtime/app-stream-html.mjs'];

export async function comparePresentationRelease(baselineRoot,{seconds=2,cycles=3,connections=4}={}){
  assert.ok(Number.isInteger(seconds)&&seconds>=1&&seconds<=10);assert.ok(Number.isInteger(cycles)&&cycles>=3&&cycles<=6);assert.ok(Number.isInteger(connections)&&connections>=1&&connections<=8);
  baselineRoot=await realpath(baselineRoot);assert.notEqual(baselineRoot,await realpath(repositoryRoot));
  const beforePackage=JSON.parse(await readFile(path.join(baselineRoot,'packages/prnext/package.json'),'utf8'));assert.equal(beforePackage.name,'@thomas.f/prnext');assert.equal(beforePackage.version,'0.1.22-alpha','Use the verified0.1.22 baseline checkout');
  const baselineBuild=(await import(pathToFileURL(path.join(baselineRoot,'packages/prnext/build/index.mjs')).href)).build;
  const result={version:1,complete:false,environment:{node:process.version,nodeEnv:process.env.NODE_ENV||null,platform:process.platform,arch:process.arch,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),nodeSha256:hash(await readFile(process.execPath)),binarySha256:hash(await readFile(binary))},settings:{seconds,cycles,connections,workers:2,warmupSeconds:1,order:'alternating AB/BA',cache:'force-dynamic',transport:'owned loopback',encoding:'identity'},artifacts:{},windows:[],browser:[],summary:[],limitations:['Unreleased candidate source versus verified0.1.22 source with identical fixtures and the same unchanged native binary.','Shared development PC; client validation and load generation share CPU with the server.','Short paired diagnostic, not a production SLO, two-hour qualification or universal application multiplier.','Browser samples are fresh desktop Chromium contexts, not field Core Web Vitals.']};
  const fixtures={},servers={},expected=new Map();let browser;
  const cases=[
    {name:'table-ssr-12',route:'/?rows=12',rows:12,kind:'table'},
    {name:'table-ssr-1000',route:'/?rows=1000',rows:1000,kind:'table'},
    {name:'table-flight-1000',route:'/?rows=1000',rows:1000,kind:'table',rsc:true},
    {name:'imported-ssr-1000',route:'/blocks',rows:1000,kind:'imported'},
    {name:'imported-flight-1000',route:'/blocks',rows:1000,kind:'imported',rsc:true},
    {name:'literal-ssr',route:'/static-benchmark',kind:'literal'},
    {name:'literal-flight',route:'/static-benchmark',kind:'literal',rsc:true},
  ];
  async function request(mode,scenario){
    const response=await fetch(servers[mode].url+scenario.route,{headers:{'accept-encoding':'identity',cookie:'presentation_owner=BenchmarkViewer; presentation_size=1000',...(scenario.rsc?{RSC:'1'}:{})},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),scenario.rsc?/text\/x-component/:/text\/html/);
    const body=await response.text();for(const secret of presentationSecrets)assert.ok(!body.includes(secret));
    assert.ok(body.includes(scenario.kind==='literal'?'Public literal 69':'Product '+(scenario.rows-1)));
    if(!scenario.rsc){
      const expression=scenario.kind==='table'?/<section data-testid="presentation">[\s\S]*?<\/section>/:scenario.kind==='imported'?/<table data-testid="block-table">[\s\S]*?<\/table>/:/<section data-testid="static-benchmark">[\s\S]*?<\/section>/;
      const markup=body.match(expression)?.[0]?.replace(transport,'');assert.ok(markup&&!markup.includes('<script'),'Expected exact presentation HTML');
      const digest=hash(markup);if(expected.has(scenario.name))assert.equal(digest,expected.get(scenario.name));else expected.set(scenario.name,digest);
    }
    return Buffer.byteLength(body);
  }
  async function load(mode,scenario,duration){
    const samples=[],begin=performance.now(),deadline=begin+duration*1000;let bytes;
    await Promise.all(Array.from({length:connections},async()=>{while(performance.now()<deadline){const start=performance.now();bytes=await request(mode,scenario);samples.push(performance.now()-start);}}));
    const elapsedMs=performance.now()-begin;return{requests:samples.length,errors:0,elapsedMs,requestsPerSecond:samples.length*1000/elapsedMs,p50Ms:quantile(samples,.5),p95Ms:quantile(samples,.95),p99Ms:quantile(samples,.99),decodedBytes:bytes};
  }
  try{
    for(const mode of['baseline','candidate']){
      const fixture=fixtures[mode]=await presentationFixture();
      await fixture.write('app/static-benchmark/page.jsx',`import{cookies}from'next/headers';export const dynamic='force-dynamic';export default async function Page(){await cookies();return <section data-testid="static-benchmark">${Array.from({length:70},(_,i)=>'<p>Public literal '+i+'</p>').join('')}</section>}`);
      const blocks=await readFile(path.join(fixture.root,'app/blocks/page.jsx'),'utf8');await fixture.write('app/blocks/page.jsx',blocks+";export const dynamic='force-dynamic';");
      const built=await(mode==='baseline'?baselineBuild:candidateBuild)(fixture.root);
      const root=mode==='baseline'?baselineRoot:repositoryRoot,digests={};
      for(const name of sources){try{digests[name]=hash(await readFile(path.join(root,'packages/prnext',name)));}catch(e){if(e.code!=='ENOENT')throw e;digests[name]=null;}}
      result.artifacts[mode]={sourceDigests:digests,presentationReport:built.presentationReport,fixtureTableSha256:hash(await readFile(path.join(fixture.root,'app/Table.jsx'))),fixtureBlocksSha256:hash(await readFile(path.join(fixture.root,'app/blocks/page.jsx')))};
      servers[mode]=await startServer(fixture.root,['--workers','2']);
    }
    assert.equal(result.artifacts.baseline.fixtureTableSha256,result.artifacts.candidate.fixtureTableSha256);assert.equal(result.artifacts.baseline.fixtureBlocksSha256,result.artifacts.candidate.fixtureBlocksSha256);
    for(const scenario of cases)for(let cycle=0;cycle<cycles;cycle++)for(const mode of cycle%2?['candidate','baseline']:['baseline','candidate']){
      await load(mode,scenario,1);const measured=await load(mode,scenario,seconds);result.windows.push({case:scenario.name,mode,cycle,...measured});
      console.log(JSON.stringify({case:scenario.name,mode,cycle,rps:measured.requestsPerSecond,p95Ms:measured.p95Ms,bytes:measured.decodedBytes}));
    }
    browser=await chromium.launch();
    for(const scenario of cases.filter(x=>['table-ssr-1000','imported-ssr-1000'].includes(x.name)))for(let cycle=0;cycle<cycles;cycle++)for(const mode of cycle%2?['candidate','baseline']:['baseline','candidate']){
      const context=await browser.newContext();
      try{
        const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
        await context.addCookies([{name:'presentation_owner',value:'BenchmarkViewer',url:servers[mode].url},{name:'presentation_size',value:'1000',url:servers[mode].url}]);
        await page.goto(servers[mode].url+scenario.route,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>performance.getEntriesByName('presentation-hydrated').length>0);
        await page.getByTestId('counter').first().click();assert.equal(await page.getByTestId('counter').first().textContent(),'Count 1');await page.waitForLoadState('networkidle');
        const resources=await page.evaluate(()=>({hydrationMarkMs:performance.getEntriesByName('presentation-hydrated')[0].startTime,navigation:performance.getEntriesByType('navigation')[0].toJSON(),scripts:performance.getEntriesByType('resource').filter(x=>/\.js(?:\?|$)/.test(x.name)).map(x=>({path:new URL(x.name).pathname,encodedBytes:x.encodedBodySize,decodedBytes:x.decodedBodySize,transferBytes:x.transferSize}))}));
        assert.deepEqual(errors,[]);result.browser.push({case:scenario.name,mode,cycle,...resources});
      }finally{await context.close();}
    }
    for(const scenario of cases){
      const stats={};for(const mode of['baseline','candidate']){const w=result.windows.filter(x=>x.case===scenario.name&&x.mode===mode);stats[mode]={rps:median(w.map(x=>x.requestsPerSecond)),p95Ms:median(w.map(x=>x.p95Ms)),bytes:median(w.map(x=>x.decodedBytes))};}
      result.summary.push({case:scenario.name,...stats,throughputRatio:stats.candidate.rps/stats.baseline.rps,byteChangePercent:(stats.candidate.bytes/stats.baseline.bytes-1)*100});
    }
    result.measuredRequests=result.windows.reduce((n,w)=>n+w.requests,0);result.complete=true;return result;
  }finally{await browser?.close();for(const mode of['baseline','candidate']){await servers[mode]?.close();await fixtures[mode]?.remove();}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,4,'Usage: node tests/performance/presentation-release-comparison.mjs baseline-checkout output.json');
  const result=await comparePresentationRelease(process.argv[2]);await mkdir(path.dirname(path.resolve(process.argv[3])),{recursive:true});await writeFile(process.argv[3],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({complete:result.complete,requests:result.measuredRequests,summary:result.summary}));
}
