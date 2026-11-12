import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {build} from '../../packages/prnext/build/index.mjs';
import {startServer,repositoryRoot} from '../../tests/support.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),median=a=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)];
assert.equal(process.argv.length,3,'Usage: node tests/performance/deferred-hydration.mjs artifacts/new-output.json');
const output=path.resolve(process.argv[2]),artifacts=path.resolve(repositoryRoot,'artifacts');
assert.ok(output.startsWith(artifacts+path.sep)&&path.extname(output)==='.json','Use a new JSON result inside artifacts');
try{await access(output);throw Error('Output already exists; preserve previous measurements')}catch(error){if(error.code!=='ENOENT')throw error}
const git=args=>execFileSync('git',args,{cwd:repositoryRoot,encoding:'utf8',windowsHide:true}).trim();
assert.equal(git(['status','--porcelain=v1','--untracked-files=all']),'','Use a clean, committed framework checkout');
const result={complete:false,source:git(['rev-parse','HEAD']),node:process.version,platform:process.platform,rows:5000,pairs:3,samples:[],limits:['Local diagnostic, identical 5,000-row SSR table on the same framework source and shared PC.','One memoized widget, either eager or explicit interaction-deferred. No synthetic CPU busy loop.','Post-GC CDP page-isolate JS heap does not measure total browser RSS or server RAM.','Initial DOM/SSR work remains; delayed CPU and code loading are paid at first use.']};
const fixtures={},servers={};let browser;
try{
 for(const mode of ['eager','deferred']){
  const root=await mkdtemp(path.join(repositoryRoot,'.prnext-heavy-widget-'));fixtures[mode]=root;
  const write=async(file,source)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source)};
  await write('package.json','{"type":"module"}');await write('prnext.config.mjs','export default {navigationCache:false,reactCompiler:false,prerender:{workers:1}}');
  await write('app/layout.jsx','export default function Layout({children}){return <html><body>{children}</body></html>}');
  await write('app/page.jsx',"import Host from'./Host';export const dynamic='force-dynamic';export default function Page(){return <Host/>}");
  await write('app/Host.jsx',`'use client';import React from'react';${mode==='eager'?"import Widget from'./Widget';const Heavy=React.memo(Widget);":"import{deferHydration}from'@thomas.f/prnext/hydration';const Heavy=deferHydration(()=>import('./Widget'),{when:'interaction'});"}export default function Host(){React.useEffect(()=>{window.__hostReady=true},[]);return <main><h1>Identical large table</h1><Heavy/></main>}`);
  await write('app/Widget.jsx',`import React from'react';if(typeof window!=='undefined')window.__HEAVY_WIDGET_CODE__=true;export default function Widget(){const[n,set]=React.useState(0);React.useEffect(()=>{window.__heavyReady=true},[]);const rows=Array.from({length:5000},(_,id)=>({id,name:'Product '+id,price:(id*0.13).toFixed(2),available:id%2===0}));return <section><button onClick={()=>set(n=>n+1)}>Widget {n}</button><table><tbody>{rows.map(row=><tr key={row.id}><td>{row.id}</td><td>{row.name}</td><td>{row.price}</td><td>{row.available?'Available':'Sold'}</td></tr>)}</tbody></table></section>}`);
  await build(root);servers[mode]=await startServer(root);
 }
 browser=await chromium.launch();let tableHash;
 for(let pair=0;pair<3;pair++)for(const mode of pair%2?['deferred','eager']:['eager','deferred']){
  const context=await browser.newContext();try{
   const page=await context.newPage(),errors=[],scripts=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('response',r=>{if(r.request().resourceType()==='script')scripts.push(r.body())});
   const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await page.goto(servers[mode].url);await page.waitForFunction(()=>window.__hostReady);await page.waitForLoadState('networkidle');
   assert.equal(await page.locator('tbody tr').count(),5000);const hash=sha(await page.locator('tbody').innerHTML());if(tableHash)assert.equal(hash,tableHash);else tableHash=hash;
   const initial=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));await cdp.send('HeapProfiler.collectGarbage');const initialHeap=(await cdp.send('Runtime.getHeapUsage')).usedSize;
   assert.equal(await page.evaluate(()=>!!window.__HEAVY_WIDGET_CODE__),mode==='eager');const initialScripts=await Promise.all(scripts);await page.getByRole('button',{name:'Widget 0',exact:true}).evaluate(node=>{window.__widgetNode=node});
   const start=performance.now();await page.getByRole('button',{name:'Widget 0',exact:true}).click();await page.getByRole('button',{name:'Widget 1',exact:true}).waitFor();const firstClickMs=performance.now()-start;
   assert.equal(await page.evaluate(()=>window.__widgetNode===document.querySelector('button')),true);assert.deepEqual(errors,[]);
   result.samples.push({mode,pair,scriptDurationMs:initial.ScriptDuration*1000,taskDurationMs:initial.TaskDuration*1000,initialGcHeapBytes:initialHeap,initialScriptGzipBytes:initialScripts.reduce((n,b)=>n+gzipSync(b).length,0),firstClickMs,tableHash});
  }finally{await context.close()}
 }
 result.summary=Object.fromEntries(['eager','deferred'].map(mode=>[mode,Object.fromEntries(['scriptDurationMs','taskDurationMs','initialGcHeapBytes','initialScriptGzipBytes','firstClickMs'].map(key=>[key,median(result.samples.filter(s=>s.mode===mode).map(s=>s[key]))]))]));result.complete=true;
}finally{
 await browser?.close();for(const server of Object.values(servers))await server.close();for(const root of Object.values(fixtures)){assert.equal(path.dirname(root),path.resolve(repositoryRoot));assert.ok(path.basename(root).startsWith('.prnext-heavy-widget-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
 await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({complete:result.complete,summary:result.summary}));
