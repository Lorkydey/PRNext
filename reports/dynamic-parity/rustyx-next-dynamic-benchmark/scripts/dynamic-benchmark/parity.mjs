import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createGunzip} from 'node:zlib';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {audit,clearAudit,auditFile,backendControl,launch,loadChild,directory} from './harness.mjs';
import {request,specFor,validateResponse,significantHeaders,htmlData,eventCounts,verifyWork,scenarios} from './protocol.mjs';
import {dataFor} from './backend.mjs';

function responseEvidence(r){return {status:r.status,headers:significantHeaders(r.headers),rawHeaders:r.headers,bytes:r.bytes,body:r.body}}
const errorText=error=>({name:error.name,message:error.message,stack:error.stack});
export async function parityFor(engine,backend,runId,only){
  await backendControl(backend,{reset:true});
  const server=await launch(engine,backend,'parity'),browser=await chromium.launch(),checks=[];
  const plain=await browser.newContext({javaScriptEnabled:false}),plainPage=await plain.newPage();
  async function visible(html){await plainPage.setContent(html);return (await plainPage.locator('main').innerText()).trim()}
  async function check(id,fn){
    if(only&&!only.includes(id))return;
    await clearAudit(engine);await backendControl(backend,{clearEvents:true});const row={id,engine,pass:false};
    try{Object.assign(row,await fn());row.pass=true}catch(error){row.error=errorText(error)}
    row.events=await audit(engine);row.counts=eventCounts(row.events);row.backend=(await backendControl(backend)).events;
    checks.push(row);console.log('PARITY',engine,id,row.pass?'PASS':'FAIL',row.error?.message?.slice(0,150)||'');
  }
  try{
    for(const scenario of scenarios){
      if(scenario.cycle)continue; // Detailed ordered mutation/invalidation test below.
      await check(scenario.id,async()=>{
        const prefix='gate-'+runId+'-'+scenario.id,observations=[];let priming;
        if(scenario.id==='cache-hit'){
          const spec=specFor(scenario.id,0,prefix),r=await request(server.url,spec);validateResponse(r,spec);
          priming={counts:eventCounts(await audit(engine)),backend:(await backendControl(backend)).events};
          assert.deepEqual(priming.counts,{'render:cache':1,'cache-fill':1});assert.equal(priming.backend.length,1);
          await clearAudit(engine);await backendControl(backend,{clearEvents:true});
        }
        for(let i=0;i<2;i++){
          const spec=specFor(scenario.id,i,prefix),r=await request(server.url,spec);validateResponse(r,spec);
          observations.push({...responseEvidence(r),value:spec.json?JSON.parse(r.body):htmlData(r.body),visible:spec.json?null:await visible(r.body)});
        }
        const work=verifyWork(scenario,await audit(engine),(await backendControl(backend)).events,2,{prefix});
        return {observations,work,priming};
      });
    }
    await check('ssr-10000',async()=>{
      const result=await loadChild({base:server.url,scenario:'ssr',requests:10000,concurrency:16,constant:true});
      assert.equal(result.requests,10000);assert.deepEqual(result.errors,{});
      const events=await audit(engine),work=verifyWork(scenarios[0],events,(await backendControl(backend)).events,10000);
      assert.ok(events.every(e=>e.input.token==='constant'));
      const evidence=engine+'-ssr-10000.ndjson';await writeFile(path.join(directory,evidence),await readFile(auditFile(engine)));
      return {requests:10000,work,evidence,request:'/ssr?token=constant',note:'Identical URL, headers and cookies; timing intentionally excluded until parity is established.'};
    });
    await check('compression-defaults',async()=>{
      const observations=[];
      for(const id of ['route-get','pages-get']){
        const spec={...specFor(id,0,'compression'),encoding:'gzip'},r=await request(server.url,spec);
        validateResponse(r,{...spec,encoding:r.headers['content-encoding']||'identity'});
        observations.push({...responseEvidence(r),value:JSON.parse(r.body)});
      }
      return {observations,note:'Diagnostic only: the requested gzip negotiation differs for Route Handlers. Performance uses identity explicitly for both engines on those routes.'};
    });
    await check('session-guest',async()=>{
      const r=await request(server.url,{path:'/session'});assert.equal(r.status,200);assert.deepEqual(htmlData(r.body),{kind:'session',session:'guest',message:'Please sign in'});
      return {observations:[{...responseEvidence(r),visible:await visible(r.body)}]};
    });
    await check('redirect',async()=>{
      const to='/session?from=redirect',r=await request(server.url,{path:'/redirect?to='+encodeURIComponent(to)});
      assert.equal(r.status,307);assert.equal(r.headers.location,to);
      const followed=await request(server.url,{path:r.headers.location});assert.equal(followed.status,200);
      return {observations:[responseEvidence(r)],followedStatus:followed.status,followedVisible:await visible(followed.body)};
    });
    await check('not-found',async()=>{
      const r=await request(server.url,{path:'/missing'});assert.equal(r.status,404);
      await plainPage.setContent(r.body);const initialVisible=(await plainPage.locator('body').innerText()).trim();
      const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      try{const response=await page.goto(server.url+'/missing');assert.equal(response.status(),404);await page.waitForLoadState('networkidle');const text=(await page.locator('main').innerText()).trim();assert.equal(text,'Product not found\n\nNo matching product exists.');assert.deepEqual(errors,[]);
        return {observations:[{...responseEvidence(r),visible:text}],initialVisible,robotsNoindex:/name="robots" content="noindex"/.test(r.body),browserErrors:errors};
      }finally{await context.close()}
    });
    await check('cache-revalidation',async()=>{
      const key='invalidate-'+runId,observations=[];
      const read=async(version)=>{const r=await request(server.url,{path:'/cache?key='+key});assert.equal(r.status,200);assert.deepEqual(htmlData(r.body),{kind:'cache',data:dataFor(key,version)});observations.push({...responseEvidence(r),value:htmlData(r.body),visible:await visible(r.body)})};
      await read(0);await read(0);
      const mutation=await request(backend.url,{path:'/data',method:'POST',body:{key,delta:7}});assert.equal(mutation.status,200);
      await read(0); // Data stays cached until explicit invalidation.
      const invalidation=await request(server.url,{path:'/api/revalidate',method:'POST',body:{key},encoding:'identity'});
      assert.equal(invalidation.status,200);assert.deepEqual(JSON.parse(invalidation.body),{invalidated:key});
      await read(7);await read(7);
      assert.deepEqual(eventCounts(await audit(engine)),{'render:cache':5,'cache-fill':2,revalidate:1});
      assert.deepEqual((await backendControl(backend)).events.map(e=>e.method),['GET','POST','GET']);
      return {observations,invalidation:responseEvidence(invalidation),sequence:['miss:v0','hit:v0','backend mutation:v7','stale hit:v0','revalidateTag + revalidatePath','miss:v7','hit:v7']};
    });
    await check('cache-cycle-10',async()=>{
      const prefix='cycle-gate-'+runId,result=await loadChild({base:server.url,scenario:'cache-revalidation',requests:10,concurrency:1,prefix});
      assert.equal(result.requests,40);assert.deepEqual(result.errors,{});
      return {requests:40,cycles:10,work:verifyWork(scenarios.find(s=>s.cycle),await audit(engine),(await backendControl(backend)).events,40,{prefix})};
    });
    await check('flight-dynamic',async()=>{
      const observations=[];
      for(const [session,tenant] of [['alice','tenant-a'],['bob','tenant-b']]){
        const context=await browser.newContext({extraHTTPHeaders:{'x-tenant':tenant}}),page=await context.newPage(),errors=[];
        page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
        try{
          await context.addCookies([{name:'session',value:session,url:server.url}]);await page.goto(server.url);await page.waitForLoadState('networkidle');
          await page.evaluate(()=>window.__benchNavigation='same-document');
          const pending=page.waitForResponse(r=>r.request().headers().rsc==='1'&&new URL(r.url()).pathname==='/products/alpha');
          await page.getByRole('link',{name:'Open product'}).click();const response=await pending;
          await page.locator('#bench-data').waitFor();await page.waitForLoadState('networkidle');
          const value=JSON.parse(await page.locator('#bench-data').innerText());
          assert.deepEqual(value,{kind:'product',id:'alpha',currency:'EUR',quantity:2,tags:['a','b'],token:'flight-browser',tenant,session});
          assert.equal(await page.evaluate(()=>window.__benchNavigation),'same-document');assert.equal(response.status(),200);
          const body=await response.text(),headers=await response.allHeaders();assert.match(headers['content-type'],/^text\/x-component/);assert.deepEqual(errors,[]);
          observations.push({status:response.status(),headers:significantHeaders(headers),rawHeaders:headers,body,value,visible:await page.locator('main').innerText(),requestHeaderNames:Object.keys(response.request().headers()).sort()});
        }finally{await context.close()}
      }
      assert.equal(eventCounts(await audit(engine))['render:product'],2);assert.equal((await backendControl(backend)).events.length,0);
      return {observations,transport:'Engine-specific Flight router envelope: browser consumes its own engine protocol; not a wire-compatible Next.js payload.',directComparison:false};
    });
    await check('server-actions',async()=>{
      const context=await browser.newContext(),page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
      try{
        await page.goto(server.url+'/actions');await page.waitForLoadState('networkidle');assert.equal(JSON.parse(await page.locator('#bench-data').innerText()).version,0);
        const pending=page.waitForResponse(r=>Boolean(r.request().headers()['next-action']));
        await page.getByRole('button',{name:'Mutate and revalidate'}).click();const response=await pending;
        await page.waitForFunction(()=>JSON.parse(document.querySelector('#action-result').textContent)?.version===3);await page.waitForLoadState('networkidle');
        const result=JSON.parse(await page.locator('#action-result').innerText()),rendered=JSON.parse(await page.locator('#bench-data').innerText());
        assert.deepEqual(result,{key:'action',version:3,label:'mutation-v1'});assert.equal(rendered.version,3);assert.equal(response.status(),200);assert.deepEqual(errors,[]);
        const events=await audit(engine);assert.deepEqual(events.filter(e=>e.kind==='action').map(e=>e.input),[{key:'action',delta:3,label:'mutation-v1'}]);
        const backendEvents=(await backendControl(backend)).events;
        assert.equal(backendEvents.filter(e=>e.method==='POST').length,1);
        assert.ok(backendEvents.every(e=>e.key==='action'),'action backend key');
        const cookie=(await context.cookies()).find(c=>c.name==='action-version');assert.equal(cookie.value,'3');assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Lax');
        const headers=await response.allHeaders();headers['set-cookie']=(await response.headersArray()).filter(h=>h.name.toLowerCase()==='set-cookie').map(h=>h.value);
        let body=null,bodyCaptureError;try{body=await response.text()}catch(error){bodyCaptureError=error.message}
        return {result,rendered,visible:await page.locator('main').innerText(),method:response.request().method(),arguments:response.request().postData(),observations:[{status:response.status(),headers:significantHeaders(headers),rawHeaders:headers,body,bodyCaptureError}],transport:'Next uses its action/router envelope; Rustyx uses actionResult and its own refreshed tree. Application result and exact execution counts are checked independently.',directComparison:false};
      }finally{await context.close()}
    });
    await check('streaming-order',async()=>{
      const observations=[];
      for(const encoding of ['identity','gzip']){
        await backendControl(backend,{hold:'stream'});let prefix='',resolveShell,decoder;
        const shell=new Promise(resolve=>resolveShell=resolve);
        const consume=chunk=>{prefix+=chunk.toString();if(prefix.includes('Streaming shell')&&prefix.includes('Waiting for data'))resolveShell(true)};
        const pending=request(server.url,{path:'/stream',encoding},undefined,(chunk,res)=>{
          if(res.headers['content-encoding']==='gzip'){if(!decoder){decoder=createGunzip();decoder.on('data',consume);decoder.on('error',()=>resolveShell(false))}decoder.write(chunk)}else consume(chunk);
        });pending.catch(()=>resolveShell(false));
        let early;
        try{early=await Promise.race([shell,delay(1500).then(()=>false)]);assert.ok(early,'shell not received while backend is blocked');assert.ok(!prefix.includes('Async data ready'),'async result arrived before backend release')}
        finally{await backendControl(backend,{release:'stream'})}
        const r=await pending;decoder?.end();validateResponse(r,{...specFor('stream'),encoding});
        observations.push({...responseEvidence(r),shellBeforeBackendRelease:early});
      }
      const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      try{await page.goto(server.url+'/stream');await page.waitForLoadState('networkidle');assert.deepEqual(JSON.parse(await page.locator('#bench-data').innerText()),{kind:'stream',data:dataFor('stream')});assert.equal(await page.locator('#bench-fallback:visible').count(),0);assert.deepEqual(errors,[]);return {observations,visible:await page.locator('main').innerText(),errors}}
      finally{await context.close()}
    });
    return {engine,checks,serverLog:server.output()};
  }finally{await plain.close();await browser.close();await server.close()}
}

const trace=events=>events.map(({kind,input})=>({kind,input})).map(x=>JSON.stringify(x)).sort();
export function compareParity(left,right,preparation){
  return left.checks.map(a=>{
    const b=right.checks.find(row=>row.id===a.id),differences=[];
    if(!a.pass||!b?.pass)differences.push('one or both engine checks failed');
    function compare(label,x,y){try{assert.deepEqual(x,y)}catch{differences.push(label)}}
    compare('execution trace (function and actual input)',trace(a.events),trace(b?.events||[]));
    compare('backend calls and parameters',a.backend,b?.backend);
    compare('HTTP status / significant headers / cookies / visible content / JSON',a.observations?.map(r=>({status:r.status,headers:r.headers,visible:r.visible,value:r.value})),b?.observations?.map(r=>({status:r.status,headers:r.headers,visible:r.visible,value:r.value})));
    for(const field of ['followedStatus','followedVisible','robotsNoindex','initialVisible','result','rendered','visible','sequence'])compare(field,a[field],b?.[field]);
    if(preparation.builds.some(build=>build.unexpectedPrerender.length))differences.push('unexpected dynamic route pre-render');
    const pass=differences.length===0,emulated=['flight-dynamic','server-actions'].includes(a.id);
    return {id:a.id,pass,emulated,directComparable:pass&&!emulated,differences,...(emulated?{note:a.transport||b.transport}:{})};
  });
}
