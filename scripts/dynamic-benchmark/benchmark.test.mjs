import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync} from 'node:zlib';
import {verifyWork,validateResponse,specFor,scenarios,significantHeaders} from './protocol.mjs';
import {compareParity} from './parity.mjs';
import {eligible} from './runner.mjs';
import {startBackend} from './backend.mjs';
import {load} from './load.mjs';

test('identical-looking HTML cannot pass when actual rendering is cached or duplicated',()=>{
  const scenario=scenarios.find(s=>s.id==='ssr'),event={kind:'render:ssr',input:{token:'constant'},pid:1};
  assert.throws(()=>verifyWork(scenario,[event],[],10000),/execution counts/);
  assert.throws(()=>verifyWork(scenario,[event,event],[],1),/execution counts/);
  assert.equal(verifyWork(scenario,[event],[],1,{constant:true}).counts['render:ssr'],1);
  assert.throws(()=>verifyWork(scenario,[{...event,input:{token:'ignored-request'}}],[],1,{constant:true}),/execution arguments/);
});
test('backend count equality is insufficient when parameters or HTTP methods differ',()=>{
  const scenario=scenarios.find(s=>s.id==='data'),events=[{kind:'render:data',input:{key:'data',tenant:'tenant-a',token:'p-0'},pid:1}];
  assert.throws(()=>verifyWork(scenario,events,[{method:'GET',key:'wrong',tenant:'tenant-a'}],1,{prefix:'p'}),/backend arguments/);
  assert.throws(()=>verifyWork(scenario,events,[{method:'POST',key:'data',tenant:'tenant-a'}],1,{prefix:'p'}),/mutation/);
});
test('cache hit, miss and revalidation order are distinct required execution paths',()=>{
  assert.throws(()=>verifyWork(scenarios.find(s=>s.id==='cache-hit'),[{kind:'render:cache',input:{key:'x'}},{kind:'cache-fill',input:{key:'x'}}],[{method:'GET',key:'x'}],1),/execution counts/);
  const key='reval-p-0',order=['render:cache','cache-fill','render:cache','revalidate','render:cache','cache-fill'];
  const events=order.map(kind=>({kind,input:{key},pid:1})),backend=Array.from({length:2},()=>({method:'GET',key,tenant:'public'}));
  assert.equal(verifyWork(scenarios.find(s=>s.cycle),events,backend,4,{prefix:'p'}).cycles,1);
  [events[2],events[3]]=[events[3],events[2]];
  assert.throws(()=>verifyWork(scenarios.find(s=>s.cycle),events,backend,4,{prefix:'p'}),/execution order/);
});
test('HTTP validation checks data, cookies, query/header values and cache policy',()=>{
  const spec=specFor('route-post',0,'test');const response={status:201,headers:{'x-bench-contract':'dynamic-parity-v1','content-encoding':'identity','content-type':'application/json; charset=utf-8','cache-control':'no-store','x-tenant-echo':'tenant-a','set-cookie':['seen=alpha; Path=/; HttpOnly; SameSite=Lax']},body:JSON.stringify(spec.expected)};
  validateResponse(response,spec);
  assert.throws(()=>validateResponse({...response,headers:{...response.headers,'set-cookie':['seen=alpha; Path=/']}},spec));
  assert.throws(()=>validateResponse({...response,body:JSON.stringify({...spec.expected,tenant:'tenant-b'})},spec));
  assert.throws(()=>validateResponse({...response,headers:{...response.headers,'cache-control':'public, max-age=60'}},spec));
  assert.throws(()=>validateResponse({...response,headers:{...response.headers,'content-encoding':'gzip'}},spec),/compression work/);
  assert.equal(significantHeaders({'cache-control':'private, no-cache, no-store, max-age=0'})['cache-policy'],'no-store');
});
test('failed or emulated features cannot enter direct performance comparisons',()=>{
  const row={id:'ssr',pass:true,events:[{kind:'render:ssr',input:{token:'same'},pid:1}],backend:[],observations:[]};
  const right={...row,events:[{kind:'render:ssr',input:{token:'different'},pid:2}]};
  const comparisons=compareParity({checks:[row]},{checks:[right]},{builds:[]});assert.equal(comparisons[0].directComparable,false);
  assert.equal(eligible(scenarios[0],{comparisons:[{id:'ssr',directComparable:true}]}),false,'10,000-request proof is mandatory');
  const emulated=compareParity({checks:[{...row,id:'flight-dynamic'}]},{checks:[{...row,id:'flight-dynamic'}]},{builds:[]});assert.equal(emulated[0].directComparable,false);
});
test('deterministic backend exposes actual reads/mutations and can hold streaming data',async()=>{
  const backend=await startBackend();try{
    const control=body=>fetch(backend.url+'/__control',{method:'POST',body:JSON.stringify(body)}).then(r=>r.json());
    await control({hold:'x'});let completed=false;
    const pending=fetch(backend.url+'/data?key=x').then(r=>r.json()).then(value=>(completed=true,value));
    for(let i=0;i<100;i++){if((await control({})).events.length)break;await new Promise(r=>setTimeout(r,2))}
    assert.equal(completed,false);await control({release:'x'});assert.equal((await pending).version,0);
    await fetch(backend.url+'/data',{method:'POST',body:JSON.stringify({key:'x',delta:4})});assert.equal((await(await fetch(backend.url+'/data?key=x')).json()).version,4);
    assert.deepEqual((await control({})).events.map(e=>e.method),['GET','POST','GET']);
  }finally{await backend.close()}
});
test('load generator rejects plausible but wrong SSR data and paces the offered rate',async()=>{
  const server=http.createServer((req,res)=>{const token=new URL(req.url,'http://test').searchParams.get('token');res.writeHead(200,{'content-type':'text/html','content-encoding':'gzip','cache-control':'no-store','x-bench-contract':'dynamic-parity-v1'});res.end(gzipSync('<main><pre id="bench-data">'+JSON.stringify({kind:'ssr',token,checksum:token?.startsWith('wrong')?0:91248})+'</pre></main>'))});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try{const good=await load({base,scenario:'ssr',concurrency:8,requests:10,ratePerSecond:50,prefix:'ok'});assert.equal(good.requests,10);assert.ok(good.elapsedMs>=170);const bad=await load({base,scenario:'ssr',requests:3,prefix:'wrong'});assert.equal(bad.requests,0);assert.equal(Object.values(bad.errors).reduce((a,b)=>a+b,0),3)}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
