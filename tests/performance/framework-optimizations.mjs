import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {SieveCache} from '../../packages/prnext/compat/sieve-cache.cjs';
import {startServer,repositoryRoot} from '../support.mjs';

const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function sourceInfo(root){
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
  const names=git(['ls-files','-z','--cached','--others','--exclude-standard','--','packages/prnext']).split('\0').filter(Boolean).sort();
  const files=await Promise.all(names.map(async name=>[name,hash(await readFile(path.join(root,name)))]));
  return{commit:git(['rev-parse','HEAD']).trim(),dirty:!!git(['status','--porcelain=v1','--untracked-files=all','--','packages/prnext']).trim(),sourceSha256:hash(JSON.stringify(files))};
}

class LruCache {
  constructor(){this.entries=new Map();}
  get(key){const value=this.entries.get(key);if(value!==undefined){this.entries.delete(key);this.entries.set(key,value);}return value;}
  set(key,value){if(this.entries.has(key))this.entries.delete(key);else if(this.entries.size>=32)this.entries.delete(this.entries.keys().next().value);this.entries.set(key,value);}
}

function cacheSamples(){
  const results=[];
  for(const scenario of ['hot','mixed','scan']){
    const keys=Uint32Array.from({length:1_000_000},(_,i)=>scenario==='hot'?i%16:scenario==='mixed'?(i%5?i%16:16+((i/5|0)%128)):i%48);
    const samples=[];
    for(let pair=0;pair<3;pair++)for(const mode of pair%2?['sieve','lru']:['lru','sieve']){
      const cache=mode==='sieve'?new SieveCache({maxEntries:32}):new LruCache();
      for(let i=0;i<32;i++)cache.set(i,{value:i});
      const before=process.cpuUsage(),start=performance.now();let hits=0,sum=0;
      for(const key of keys){const value=cache.get(key);if(value){hits++;sum+=value.value;}else cache.set(key,{value:key});}
      const elapsedMs=performance.now()-start,cpu=process.cpuUsage(before);
      assert.equal(sum>=0,true);samples.push({mode,pair,hits,misses:keys.length-hits,elapsedMs,cpuMs:(cpu.user+cpu.system)/1000});
    }
    results.push({scenario,capacity:32,operations:keys.length,samples,speedRatio:median(samples.filter(x=>x.mode==='lru').map(x=>x.elapsedMs))/median(samples.filter(x=>x.mode==='sieve').map(x=>x.elapsedMs))});
  }
  return results;
}

async function fixture(repository,routes){
  const root=await mkdtemp(path.join(repository,'.prnext-framework-perf-'));
  const write=async(name,source)=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);};
  const remove=async()=>{assert.equal(path.dirname(root),path.resolve(repository));assert.ok(path.basename(root).startsWith('.prnext-framework-perf-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});};
  try{
    await write('package.json','{"type":"module"}');
    await write('prnext.config.mjs','export default {prerender:{workers:1},navigationCache:false};');
    await write('app/layout.jsx','export default function Layout({children}){return <html><head/><body>{children}</body></html>}');
    await write('app/navigation/layout.jsx',"import Navigation from'../Navigation';export default function Layout({children}){return <main><Navigation/>{children}</main>}");
    await write('app/navigation/[slug]/page.jsx',"export const dynamic='force-dynamic';export default function Page(){return <h1>Fixed active page</h1>}");
    await write('app/Navigation.jsx',`'use client';import React from'react';import{useRouter,usePathname,useParams,useSearchParams}from'next/navigation';
      function record(name){if(typeof window!=='undefined'){window.__renders||={};window.__renders[name]=(window.__renders[name]||0)+1}}
      const Router=React.memo(function Router(){record('router');useRouter();return <span>router</span>});
      const Path=React.memo(function Path(){record('path');return <span>{usePathname()}</span>});
      const Params=React.memo(function Params(){record('params');return <span>{useParams().slug}</span>});
      const Search=React.memo(function Search(){record('search');return <span data-testid='search'>{useSearchParams().get('q')||'empty'}</span>});
      export default function Navigation(){const router=useRouter();return <><button onClick={()=>router.push('?q=second')}>Update query</button>{Array.from({length:256},(_,i)=><React.Fragment key={i}><Router/><Path/><Params/><Search/></React.Fragment>)}</>}`);
    for(let i=0;i<routes;i++){
      await write(`app/unrelated-${i}/Client.jsx`,`'use client';export default function Client(){return <button onClick={()=>{}}>Unrelated ${i}</button>}`);
      await write(`app/unrelated-${i}/page.jsx`,"import Client from'./Client';export const dynamic='force-dynamic';export default function Page(){return <Client/>}");
    }
    const {build}=await import(pathToFileURL(path.join(repository,'packages/prnext/build/index.mjs')));
    const manifest=await build(root);return{root,manifest,remove};
  }catch(error){await remove();throw error;}
}

// Diagnostic A/B on a shared developer machine. Independent contexts, identical
// active page and 1,024 memoized consumers; no synthetic percentage pass gate.
async function run(baseline,output){
  const result={complete:false,node:process.version,platform:process.platform,baseline:path.resolve(baseline),candidate:repositoryRoot,sources:{baseline:await sourceInfo(baseline),candidate:await sourceInfo(repositoryRoot)},cache:cacheSamples(),builds:[],browser:[],limits:[
    'Synthetic route scaling and shared-host Chromium observations, not production throughput or a VPS RAM guarantee.',
    'Cache samples compare equivalent capacity-32 hot paths; SIEVE adds per-entry metadata and may cost more on misses.',
    'CDP JSHeapUsedSize after forced GC is page-isolate live heap, not browser RSS or a memory leak proof.',
  ]};
  const browser=await chromium.launch();
  try{
    for(const routes of [10,100,1000]){
      const fixtures={},servers={};
      try{
        for(const [mode,repository]of [['baseline',baseline],['candidate',repositoryRoot]]){
          const f=fixtures[mode]=await fixture(repository,routes);servers[mode]=await startServer(f.root);
          const entry=f.manifest.routes.find(route=>route.router==='app'&&route.client).client;
          const bytes=await readFile(path.join(f.root,'.prnext/assets',path.basename(entry)));
          const response=await fetch(servers[mode].url+'/navigation/one',{headers:{RSC:'1'}});assert.equal(response.status,200);const flight=Buffer.from(await response.text());
          result.builds.push({mode,routes,clientEntries:Object.keys(f.manifest.app.clientModules).length,bootstrapBytes:bytes.length,bootstrapGzipBytes:gzipSync(bytes).length,bootstrapSha256:hash(bytes),flightBytes:flight.length,flightGzipBytes:gzipSync(flight).length});
        }
        for(let pair=0;pair<3;pair++)for(const mode of pair%2?['candidate','baseline']:['baseline','candidate']){
          const context=await browser.newContext();
          try{
            const page=await context.newPage(),errors=[],scripts=[];
            page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
            page.on('response',r=>{if(r.request().resourceType()==='script')scripts.push(r.body());});
            const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
            await page.goto(servers[mode].url+'/navigation/one');await page.waitForFunction(()=>window.__renders?.search===256);await page.waitForLoadState('networkidle');
            const initial=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
            await cdp.send('HeapProfiler.collectGarbage');const heap=(await cdp.send('Runtime.getHeapUsage')).usedSize;
            const before=await page.evaluate(()=>({...window.__renders}));await page.getByRole('button',{name:'Update query',exact:true}).click();await page.getByTestId('search').first().filter({hasText:'second'}).waitFor();
            const after=await page.evaluate(()=>({...window.__renders}));const end=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
            const rendered=Object.fromEntries(Object.keys(after).map(key=>[key,after[key]-before[key]]));
            assert.equal(rendered.search,256);if(mode==='candidate')for(const key of ['path','params','router'])assert.equal(rendered[key],0,key);
            assert.deepEqual(errors,[]);const bodies=await Promise.all(scripts);
            result.browser.push({mode,routes,pair,initialScriptDurationMs:initial.ScriptDuration*1000,initialTaskDurationMs:initial.TaskDuration*1000,initialGcHeapBytes:heap,scriptBytes:bodies.reduce((n,b)=>n+b.length,0),scriptGzipBytes:bodies.reduce((n,b)=>n+gzipSync(b).length,0),queryScriptDurationMs:(end.ScriptDuration-initial.ScriptDuration)*1000,rendered});
          }finally{await context.close();}
        }
        console.log(JSON.stringify({routes,builds:result.builds.filter(x=>x.routes===routes)}));
      }finally{for(const s of Object.values(servers))await s.close();for(const f of Object.values(fixtures))await f.remove();}
    }
    result.complete=true;
  }finally{await browser.close();await writeFile(output,JSON.stringify(result,null,2)+'\n');}
}
assert.equal(process.argv.length,4,'Usage: node --expose-gc tests/performance/framework-optimizations.mjs baseline-checkout result.json');
await run(path.resolve(process.argv[2]),path.resolve(process.argv[3]));
