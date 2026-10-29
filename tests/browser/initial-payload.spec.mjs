import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from '../../packages/prnext/build/index.mjs';
import {repositoryRoot,startServer} from '../support.mjs';

async function assertControlledStartupFailure(page,analysis,{partial}){
  const flight=analysis.files.find(file=>file.modules.some(module=>module.file.includes('react-server-dom-webpack-client.browser.production')));
  const optional=analysis.files.find(file=>file.modules.some(module=>module.file.includes('/runtime/app-partial-model.mjs')));
  expect(flight).toBeTruthy();if(partial)expect(optional).toBeTruthy();
  await page.addInitScript(()=>{
    window.__startupUnhandled=[];window.__startupFailures=[];
    window.addEventListener('unhandledrejection',event=>window.__startupUnhandled.push(String(event.reason?.message||event.reason)));
    const report=console.error;
    console.error=function(...args){if(args[0]==='[PRNext] App startup failed:')window.__startupFailures.push(String(args[1]?.message||args[1]));return report.apply(this,args);};
  });
  let releaseFlight;
  const gate=new Promise(resolve=>{releaseFlight=resolve;});
  let requestedFlight,abortedPartial;
  const flightStarted=new Promise(resolve=>{requestedFlight=resolve;});
  const partialFailed=new Promise(resolve=>{abortedPartial=resolve;});
  await page.route('**/'+flight.file,async route=>{
    requestedFlight();
    if(!partial){await route.abort('failed');return;}
    await gate;await route.continue();
  });
  if(partial)await page.route('**/'+optional.file,async route=>{await route.abort('failed');abortedPartial();});
  try{
    await page.reload({waitUntil:'domcontentloaded'});
    await flightStarted;if(partial)await partialFailed;
    // The PPR import fails while Flight is deliberately unresolved. It must
    // already have a rejection handler, rather than wait for that download.
    await expect.poll(()=>page.evaluate(()=>window.__startupFailures.length)).toBe(1);
    expect(await page.evaluate(()=>window.__startupUnhandled)).toEqual([]);
    if(partial){
      const response=page.waitForResponse(value=>value.url().endsWith('/'+flight.file));
      releaseFlight();await (await response).finished();
      await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
      expect(await page.evaluate(()=>window.__startupUnhandled)).toEqual([]);
      expect(await page.evaluate(()=>window.__startupFailures.length)).toBe(1);
    }
  }finally{releaseFlight();await page.unrouteAll({behavior:'wait'});}
}

for(const cacheComponents of [false,true])test(`initial App hydration ${cacheComponents?'loads the PPR runtime only for Cache Components':'prunes the optional PPR runtime without extra requests'}`,async({page})=>{
  test.setTimeout(90000);
  const root=await mkdtemp(path.join(repositoryRoot,'.prnext-initial-browser-'));
  let server;
  const errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>{if(request.url().endsWith('.js'))requests.push(new URL(request.url()).pathname.split('/').pop());});
  try{
    const files={
      'package.json':'{"type":"module","private":true}',
      'postcss.config.json':'{"plugins":[]}',
      'next.config.mjs':`export default {cacheComponents:${cacheComponents}}`,
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx':cacheComponents
        ? `import{Suspense}from'react';import{cookies}from'next/headers';import Counter from './counter';async function Visitor(){return <p data-testid="visitor">{(await cookies()).get('visitor')?.value||'guest'}</p>}export default function Page(){return <><Counter/><Suspense fallback={<p>Waiting visitor</p>}><Visitor/></Suspense></>}`
        : `import Counter from './counter';export default function Page(){return <Counter/>}`,
      'app/counter.jsx':`'use client';import{useState}from'react';export default function Counter(){const[n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>}`,
    };
    for(const [name,source]of Object.entries(files)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    const manifest=await build(root),analysis=JSON.parse(await readFile(path.join(manifest.outputDirectory,'build-analysis.json'),'utf8'));
    const optional=analysis.files.find(file=>file.modules.some(module=>module.file.includes('/runtime/app-partial-model.mjs')));
    server=await startServer(root);
    const response=await page.goto(server.url);
    expect(response.status()).toBe(200);
    await expect(page.getByRole('button',{name:'Count 0',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Count 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
    if(cacheComponents){
      expect(response.headers()['x-prnext-prerender']).toBe('partial');
      await expect(page.getByTestId('visitor')).toHaveText('guest');
      expect(optional).toBeTruthy();expect(requests).toContain(optional.file);
    }else{
      expect(optional).toBeUndefined();
      const expected=analysis.routes.find(route=>route.route==='/').files;
      expect([...new Set(requests)].sort()).toEqual([...expected].sort());
      const source=(await Promise.all(expected.map(file=>readFile(path.join(manifest.outputDirectory,'assets',file),'utf8')))).join('\n');
      expect(source).not.toContain('x-prnext-prefetch-known');
    }
    expect(errors).toEqual([]);
    await assertControlledStartupFailure(page,analysis,{partial:cacheComponents});
  }finally{await server?.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
