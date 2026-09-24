import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,readdir,stat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {freePort,repositoryRoot,binary} from '../tests/support.mjs';
import {processTree,sample} from './bench-next-comparison.mjs';
import {benchmarkWorkload} from './migration-load.mjs';

const self=fileURLToPath(import.meta.url),exec=promisify(execFile);
const output=path.resolve(process.env.BLOG_BENCH_OUTPUT || 'reports/blog-comparison');
const repetitions=3,durationMs=4000;
const engines=['next','rustyx'];
const roots=Object.fromEntries(engines.map(engine=>[engine,path.join(output,'projects',engine)]));
const cli=path.join(repositoryRoot,'packages/rustyx/cli.mjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const median=values=>values.filter(Number.isFinite).sort((a,b)=>a-b)[Math.floor(values.filter(Number.isFinite).length/2)]??null;
const envFor=root=>{
  const env={...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',INIT_CWD:root,PWD:root};
  // Run both engines with project defaults rather than an earlier benchmark's tuning.
  for(const key of Object.keys(env))if(key.startsWith('RUSTYX_'))delete env[key];
  for(const key of ['BASE_PATH','EXPORT','UNOPTIMIZED','ANALYZE','NEXT_UMAMI_ID','NODE_OPTIONS'])delete env[key];
  return env;
};
async function run(command,args,options={}) {
  const child=spawn(command,args,{stdio:'inherit',...options});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} exited ${signal||code}`)));});
}

// Include the same RSS postbuild task in both workflows. Rustyx's raw build
// does not run lint/TypeScript: measure those checks separately and include
// them in its validated pipeline instead of calling their absence a speedup.
if(process.argv[2]==='--build-child'){
  const [engine,root,metricsFile]=process.argv.slice(3),require=createRequire(path.join(root,'package.json'));
  const started=performance.now(),metrics={};
  let stage=performance.now();
  await run(process.execPath,[engine==='next'?require.resolve('next/dist/bin/next'):cli,'build'],{cwd:root,env:envFor(root)});
  metrics.frameworkMs=performance.now()-stage;
  metrics.validationIncludedInFramework=engine==='next';
  metrics.validationMs=0;
  if(engine==='rustyx'){
    stage=performance.now();
    await Promise.all([
      run(process.execPath,[require.resolve('typescript/bin/tsc'),'--noEmit','--composite','false','--declarationMap','false','--emitDeclarationOnly','false','--tsBuildInfoFile','.rustyx-benchmark-validation.tsbuildinfo'],{cwd:root,env:envFor(root)}),
      run(process.execPath,[require.resolve('next/dist/bin/next'),'lint','--cache-location','.rustyx-benchmark-eslint-cache'],{cwd:root,env:envFor(root)}),
    ]);
    metrics.validationMs=performance.now()-stage;
  }
  stage=performance.now();
  await run(process.execPath,['scripts/postbuild.mjs'],{cwd:root,env:envFor(root)});
  metrics.postbuildMs=performance.now()-stage;metrics.pipelineMs=performance.now()-started;
  await writeFile(metricsFile,JSON.stringify(metrics));
}

async function directorySizes(directory){
  const result={totalBytes:0,cacheBytes:0,files:0};
  async function visit(dir,cached=false){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name),cache=cached||entry.name==='cache';
      if(entry.isDirectory())await visit(file,cache);
      else if(entry.isFile()){const bytes=(await stat(file)).size;result.totalBytes+=bytes;result.files++;if(cache)result.cacheBytes+=bytes;}
    }
  }
  await visit(directory);result.withoutCacheBytes=result.totalBytes-result.cacheBytes;return result;
}
async function sourceHash(root){
  const hash=createHash('sha256');
  async function visit(dir){for(const entry of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(['node_modules','.git','.yarn','.next','.contentlayer'].includes(entry.name)||entry.name.startsWith('.rustyx')||entry.name.endsWith('.tsbuildinfo'))continue;
    const file=path.join(dir,entry.name);
    const relative=path.relative(root,file).replaceAll(path.sep,'/');
    if(['next-env.d.ts','app/tag-data.json','public/search.json'].includes(relative)||/^public\/(?:tags\/[^/]+\/)?feed\.xml$/.test(relative))continue;
    if(entry.isDirectory())await visit(file);else if(entry.isFile()){hash.update(path.relative(root,file));hash.update(await readFile(file));}
  }}
  await visit(root);return hash.digest('hex');
}
async function measuredBuild(engine,kind,repetition){
  const root=roots[engine],name=`build-${engine}-${kind}-${repetition}`;
  if(kind==='cold'){
    for(const entry of await readdir(root))if(entry==='.next'||entry==='.contentlayer'||entry.endsWith('.tsbuildinfo')||entry.startsWith('.rustyx'))await rm(path.join(root,entry),{recursive:true,force:true});
  }
  const metricsFile=path.join(output,name+'.json');let text='';
  const child=spawn('/usr/bin/time',['-l',process.execPath,self,'--build-child',engine,root,metricsFile],{cwd:root,env:envFor(root),stdio:['ignore','pipe','pipe']});
  const monitor=sample(child.pid);
  child.stdout.on('data',data=>text+=data);child.stderr.on('data',data=>text+=data);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  const points=await monitor.stop();await writeFile(path.join(output,name+'.log'),text);
  if(code!==0)throw new Error(`${name} failed: ${text.slice(-7000)}`);
  const timing=text.match(/([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
  assert.ok(timing,`${name}: resource accounting missing`);
  return {engine,kind,repetition,...JSON.parse(await readFile(metricsFile,'utf8')),wallMs:Number(timing[1])*1000,
    cpuMs:(Number(timing[2])+Number(timing[3]))*1000,sampledPeakTreeRssMiB:Math.max(...points.map(point=>point.rssMiB)),memorySamples:points.length,
    output:await directorySizes(path.join(root,engine==='next'?'.next':'.rustyx'))};
}
let active;
async function server(engine,label){
  const root=roots[engine],port=await freePort(),require=createRequire(path.join(root,'package.json'));
  const args=engine==='next'?[require.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)]
    :['start',root,'--hostname','127.0.0.1','--port',String(port)];
  const began=performance.now();let log='';
  const child=spawn(engine==='next'?process.execPath:binary,args,{cwd:root,env:envFor(root),detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
  const close=async()=>{
    if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM')}catch{};await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);try{process.kill(-child.pid,'SIGKILL')}catch{}}
    await writeFile(path.join(output,`server-${engine}-${label}.log`),log);
  };
  const url=`http://127.0.0.1:${port}`;
  try{
    for(let attempt=0;attempt<300;attempt++){
      if(child.exitCode!==null)throw new Error(log);
      try{const response=await fetch(url+'/static/images/avatar.png',{signal:AbortSignal.timeout(500)});await response.arrayBuffer();if(response.ok)return {child,url,close,startupMs:performance.now()-began};}catch{}
      await delay(20);
    }
    throw new Error('Server readiness timed out');
  }catch(error){await close();throw error;}
}
const pages=[
  {endpoint:'/',marker:'Latest'},
  {endpoint:'/blog/',marker:'All Posts'},
  {endpoint:'/tags/',marker:'Tags'},
  {endpoint:'/projects/',marker:'Projects'},
  {endpoint:'/about/',marker:'About'},
  {endpoint:'/blog/guide-to-using-images-in-nextjs/',marker:'Images in Next.js'},
  {endpoint:'/blog/new-features-in-v1/',marker:'New features in v1'},
];
const scenarios=[
  {id:'fixed-250',label:'Sept pages HTML — 250 requêtes/s imposées',concurrency:64,ratePerSecond:250,durationMs:8000,workloads:pages},
  {id:'mixed-4',label:'Sept pages HTML',concurrency:4,workloads:pages},
  {id:'mixed-64',label:'Sept pages HTML — forte concurrence',concurrency:64,workloads:pages},
  {id:'home',label:'Accueil HTML',concurrency:4,workloads:[pages[0]]},
  {id:'article',label:'Article MDX HTML',concurrency:4,workloads:[pages[5]]},
  {id:'flight',label:'Article Flight/RSC',concurrency:4,workloads:[{endpoint:pages[5].endpoint,headers:{RSC:'1'},contentType:'text/x-component',minBytes:100}]},
  {id:'image',label:'Image optimisée en cache',concurrency:4},
  {id:'search',label:'Index de recherche JSON',concurrency:4,workloads:[{endpoint:'/search.json',contentType:'application/json',marker:'title'}]},
];

async function browserCheck(engine,browser){
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[],metrics=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
  try{
    for(const spec of pages){
      const response=await page.goto(active.url+spec.endpoint);assert.equal(response.status(),200);
      await page.waitForLoadState('networkidle');
      checks.push({path:spec.endpoint,title:await page.title(),headings:await page.locator('h1,h2,h3').allTextContents(),mainText:await page.locator('main').innerText()});
    }
    await page.goto(active.url);await page.waitForLoadState('networkidle');
    await page.screenshot({path:path.join(output,engine+'-home.png'),fullPage:true});
    await page.getByRole('button',{name:'Theme switcher'}).click();
    await page.getByRole('menuitem',{name:'Dark',exact:true}).click();
    assert.match(await page.locator('html').getAttribute('class'),/dark/);
    await page.evaluate(()=>window.__comparisonNavigation='same-document');
    await page.getByRole('link',{name:'Blog',exact:true}).first().click();
    await page.getByRole('heading',{name:'All Posts',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__comparisonNavigation),'same-document');
    // Fresh contexts: no browser cache. Local machine timings, no network throttle.
    for(let repetition=1;repetition<=3;repetition++)for(const route of ['/',pages[5].endpoint]){
      const context=await browser.newContext({viewport:{width:1280,height:900}}),tab=await context.newPage();
      const cdp=await context.newCDPSession(tab);await cdp.send('Performance.enable');await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
      await tab.addInitScript(()=>{globalThis.__benchLCP=0;new PerformanceObserver(list=>{globalThis.__benchLCP=list.getEntries().at(-1).startTime}).observe({type:'largest-contentful-paint',buffered:true})});
      const baseline=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row=>[row.name,row.value]));
      await tab.goto(active.url+route);await tab.waitForLoadState('networkidle');
      await tab.waitForFunction(()=>document.querySelector('button[aria-label="Theme switcher"] svg path'));
      const value=await tab.evaluate(()=>{
        const nav=performance.getEntriesByType('navigation')[0],resources=performance.getEntriesByType('resource');
        const scripts=resources.filter(entry=>/\.js(?:\?|$)/.test(entry.name));
        return{ttfbMs:nav.responseStart-nav.requestStart,domContentLoadedMs:nav.domContentLoadedEventEnd,loadMs:nav.loadEventEnd,lcpMs:globalThis.__benchLCP,
          htmlEncodedBytes:nav.encodedBodySize,jsEncodedBytes:scripts.reduce((sum,item)=>sum+item.encodedBodySize,0),jsDecodedBytes:scripts.reduce((sum,item)=>sum+item.decodedBodySize,0),
          transferredBytes:nav.transferSize+resources.reduce((sum,item)=>sum+item.transferSize,0),resourceCount:resources.length,scriptCount:scripts.length};
      });
      const after=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row=>[row.name,row.value]));
      metrics.push({engine,route,repetition,...value,mainThreadMs:(after.TaskDuration-baseline.TaskDuration)*1000,scriptMs:(after.ScriptDuration-baseline.ScriptDuration)*1000,jsHeapUsedMiB:after.JSHeapUsedSize/1024**2});
      await context.close();
    }
    return {engine,checks,errors,metrics};
  }finally{await page.close()}
}

async function benchmark(){
  await mkdir(output,{recursive:true});
  const require=createRequire(path.join(roots.next,'package.json'));
  let data={startedAt:new Date().toISOString(),status:'running',machine:{cpu:os.cpus()[0].model,cores:os.cpus().length,ramGiB:os.totalmem()/1024**3,os:os.platform(),release:os.release(),arch:os.arch()},
    versions:{node:process.version,next:require('next/package.json').version,react:require('react/package.json').version,rustyx:JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8')).version},
    sourceHashes:await Promise.all(engines.map(async engine=>({engine,sha256:await sourceHash(roots[engine])}))),binarySha256:sha(await readFile(binary)),
    method:{repetitions,durationMs,compression:'gzip',warmupRequests:140,runtimeWorkers:'engine defaults',sampleIntervalMs:150,scenarios,
      build:'Cold removes local framework outputs, Contentlayer and validation caches; warm immediately rebuilds unchanged sources. OS page cache is not flushed. Same installed dependencies and patches; no .env secrets. Next build includes built-in lint/types; Rustyx raw build plus separate TypeScript and next lint checks. Both run the RSS postbuild script.',
      memory:'Sum of process-tree RSS; shared pages can be counted twice; maxima are sampled, not guaranteed instantaneous peaks. Server-only metrics exclude Chromium, compiler and load generator.',
      cpu:'Runtime cumulative ps CPU delta across server descendants; 100% is one core. Build user+system CPU from macOS time -l. CPU per response is preferred to utilization for efficiency.',
      limits:'One Apple M4 laptop, loopback HTTP, no TLS/CDN, no throttled network, shared client/server hardware. Unmodified development servers remain idle. Three short repetitions; browser results are local navigation metrics, not Core Web Vitals field data. This mostly-static blog does not exercise authenticated SSR or a configured external newsletter API.'},
    builds:[],functional:[],browser:[],runs:[]};
  assert.equal(data.sourceHashes[0].sha256,data.sourceHashes[1].sha256,'application sources must match (generated declarations, JSON and RSS excluded)');
  if(process.env.BLOG_BENCH_RESUME==='1'){
    const previous=JSON.parse(await readFile(path.join(output,'results.json'),'utf8'));
    assert.equal(previous.binarySha256,data.binarySha256);
    data={...data,startedAt:previous.startedAt,builds:previous.builds,functional:previous.functional,browser:previous.browser,runs:previous.runs,excludedWarmups:previous.excludedWarmups};
  }
  const save=()=>writeFile(path.join(output,'results.json'),JSON.stringify(data,null,2)+'\n');
  await save();
  try{
    // Restore Next's generated reference before comparing copied source hashes.
    for(let repetition=1;repetition<=repetitions;repetition++)for(const engine of repetition%2?engines:[...engines].reverse())for(const kind of ['cold','warm']){
      if(data.builds.some(row=>row.engine===engine&&row.kind===kind&&row.repetition===repetition))continue;
      console.log('BUILD',engine,kind,repetition);
      const row=await measuredBuild(engine,kind,repetition);data.builds.push(row);await save();
      console.log('BUILT',engine,kind,Math.round(row.frameworkMs)+' ms raw',Math.round(row.pipelineMs)+' ms validated',Math.round(row.sampledPeakTreeRssMiB)+' MiB peak');
    }
    const {chromium}=await import('@playwright/test');const browser=await chromium.launch();
    try{for(const engine of engines){
      if(data.functional.some(row=>row.engine===engine))continue;
      active=await server(engine,'browser');const inspected=await browserCheck(engine,browser);
      data.functional.push({engine,checks:inspected.checks,errors:inspected.errors});data.browser.push(...inspected.metrics);
      await active.close();active=undefined;await save();console.log('BROWSER',engine,inspected.checks.length,'pages',inspected.errors.length,'errors');
    }}finally{await browser.close()}
    data.contentComparisons=data.functional[0].checks.map((left,index)=>{
      const right=data.functional[1].checks[index];return{path:left.path,titleEqual:left.title===right.title,headingsEqual:JSON.stringify(left.headings)===JSON.stringify(right.headings),mainTextEqual:left.mainText===right.mainText};
    });await save();
    for(const scenario of scenarios)for(let repetition=1;repetition<=repetitions;repetition++)for(const engine of repetition%2?engines:[...engines].reverse()){
      if(data.runs.some(row=>row.scenario===scenario.id&&row.engine===engine&&row.repetition===repetition))continue;
      console.log('LOAD',scenario.id,engine,repetition);
      const row={engine,scenario:scenario.id,repetition};
      try{
        active=await server(engine,`${scenario.id}-${repetition}`);row.startupMs=active.startupMs;
        const workloads=scenario.workloads || [{endpoint:`/${engine==='next'?'_next/image/':'_rustyx/image'}?url=%2Fstatic%2Fimages%2Favatar.png&w=384&q=75`,headers:{accept:'image/webp'},contentType:'image/webp',magicBase64:'UklGRg=='}];
        Object.assign(row,await benchmarkWorkload(active,workloads,{durationMs:scenario.durationMs||durationMs,concurrency:scenario.concurrency,ratePerSecond:scenario.ratePerSecond,warmupRequests:140,warmupConcurrency:4,maxRequests:10000000,encoding:'gzip'}));
        console.log('RESULT',scenario.id,engine,Math.round(row.requestsPerSecond)+' req/s',row.loadMedianRssMiB.toFixed(1)+' MiB',row.cpuMsPerRequest?.toFixed(4)+' CPU ms/req',row.errors+' errors');
      }catch(error){row.error=error.stack;console.error('LOAD FAILED',scenario.id,engine,error.message)}
      finally{await active?.close();active=undefined;data.runs.push(row);await save();}
    }
    data.status='complete';data.finishedAt=new Date().toISOString();
    data.invalidRuns=data.runs.filter(row=>row.error||row.errors||!row.cpuValid||row.reachedCap||row.targetRatePerSecond&&(Math.abs(row.requestsPerSecond/row.targetRatePerSecond-1)>.05||row.scheduleLagP95Ms>10)).length;
    await save();if(data.invalidRuns)process.exitCode=1;
  }catch(error){data.status='failed';data.error=error.stack;await save();throw error;}
  finally{await active?.close()}
}

if(process.argv[2]!=='--build-child')await benchmark();
