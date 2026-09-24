import assert from 'node:assert/strict';
import http from 'node:http';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {dataFor} from './backend.mjs';

export const unescapeHTML=s=>s.replace(/<!--.*?-->/gs,'').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function htmlData(html){const value=html.match(/<pre\b[^>]*\bid="bench-data"[^>]*>([\s\S]*?)<\/pre>/);assert.ok(value,'bench-data absent from SSR HTML');return JSON.parse(unescapeHTML(value[1]))}
export function normalizedCookies(values=[]){return values.map(value=>{const [pair,...attributes]=value.split(';').map(x=>x.trim());return [pair,...attributes.map(x=>{const [key,...rest]=x.split('=');return key.toLowerCase()+(rest.length?'='+rest.join('=').replace(/^(Lax|Strict|None)$/i,x=>x.toLowerCase()):'')}).sort()].join(';')}).sort()}
export function significantHeaders(headers){
  // Framework router Vary tokens differ; keep them separately in evidence.
  // no-store makes max-age=0/no-cache/must-revalidate redundant for storage.
  const control=(headers['cache-control']||'').toLowerCase();
  return {'content-type':(headers['content-type']||'').split(';')[0].trim().toLowerCase(),
    'content-encoding':headers['content-encoding']||'identity',
    'cache-policy':/\bno-store\b/.test(control)?'no-store':control.split(',').map(x=>x.trim()).sort().join(','),
    location:headers.location||null,'x-bench-contract':headers['x-bench-contract']||null,'x-tenant-echo':headers['x-tenant-echo']||null,
    cookies:normalizedCookies(headers['set-cookie'])};
}
export function request(base,spec={},agent,onChunk){return new Promise((resolve,reject)=>{
  const began=performance.now();let firstByte,headersMs;const chunks=[];let size=0;
  const body=spec.body===undefined?undefined:typeof spec.body==='string'?spec.body:JSON.stringify(spec.body);
  const req=http.request(new URL(spec.path||'/',base),{agent,method:spec.method||'GET',headers:{'accept-encoding':spec.encoding||'gzip',...spec.headers,...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)})}},res=>{
    headersMs=performance.now()-began;
    res.on('data',chunk=>{firstByte??=performance.now()-began;size+=chunk.length;if(size>4*1024**2)return req.destroy(new Error('response exceeds 4 MiB'));chunks.push(chunk);onChunk?.(chunk,res)});
    res.on('error',reject);res.on('aborted',()=>reject(new Error('aborted response')));
    res.on('end',()=>{try{const raw=Buffer.concat(chunks),encoding=res.headers['content-encoding']||'identity';const decoded=encoding==='gzip'?gunzipSync(raw):encoding==='br'?brotliDecompressSync(raw):raw;resolve({status:res.statusCode,headers:res.headers,body:decoded.toString(),bytes:raw.length,decodedBytes:decoded.length,encoding,elapsedMs:performance.now()-began,ttfbMs:firstByte??headersMs,headersMs})}catch(error){reject(error)}});
  });
  req.setTimeout(15000,()=>req.destroy(new Error('request timeout')));req.on('error',reject);req.end(body);
})}

export const scenarios=[
  {id:'ssr',label:'SSR no-cache',event:'render:ssr',backendPerRequest:0},
  {id:'product',label:'Dynamic params/query/headers/cookies',event:'render:product',backendPerRequest:0},
  {id:'data',label:'SSR + one uncached backend read',event:'render:data',backendPerRequest:1},
  {id:'route-get',label:'Route Handler GET',event:'handler:route',backendPerRequest:0},
  {id:'route-post',label:'Route Handler POST JSON',event:'handler:route',backendPerRequest:0},
  {id:'pages-get',label:'Pages API GET',event:'handler:pages',backendPerRequest:0},
  {id:'pages-post',label:'Pages API POST JSON',event:'handler:pages',backendPerRequest:0},
  {id:'session',label:'Cookie session',event:'render:session',backendPerRequest:0},
  {id:'cache-hit',label:'Dynamic SSR, data-cache hit',event:'render:cache',backendPerRequest:0,cacheFillsPerRequest:0},
  {id:'cache-miss',label:'Dynamic SSR, data-cache miss',event:'render:cache',backendPerRequest:1,cacheFillsPerRequest:1},
  {id:'cache-revalidation',label:'Miss → hit → invalidate → miss (4 HTTP responses/cycle)',cycle:true},
  {id:'stream',label:'Suspense + delayed backend data',event:'render:stream',backendPerRequest:1},
];
export function specFor(id,index=0,prefix='gate',constant=false){
  if(constant)index=0;
  const token=constant?'constant':`${prefix}-${index}`,tenant=index%2?'tenant-b':'tenant-a',session=index%2?'bob':'alice';
  const headers={'x-tenant':tenant,cookie:'session='+session};
  if(id==='ssr')return {path:'/ssr?token='+token,headers,expected:{kind:'ssr',token,checksum:91248}};
  if(id==='product'){const product=index%2?'beta':'alpha',currency=index%2?'USD':'EUR',quantity=index%2?3:2;return {path:`/products/${product}?currency=${currency}&quantity=${quantity}&tag=a&tag=b&token=${token}`,headers,expected:{kind:'product',id:product,currency,quantity,tags:['a','b'],token,tenant,session}}}
  if(id==='data')return {path:'/data?token='+token,headers,expected:{kind:'data',token,data:dataFor('data',0,tenant)}};
  if(id==='session')return {path:'/session',headers,expected:{kind:'session',session,message:'Welcome '+session}};
  if(id.startsWith('cache-')){const key=id==='cache-hit'?'hot-'+prefix:token;return {path:'/cache?key='+key,headers,expected:{kind:'cache',data:dataFor(key)}}}
  if(id==='stream')return {path:'/stream',headers,expected:{kind:'stream',data:dataFor('stream')}};
  const post=id.endsWith('-post'),pages=id.startsWith('pages-'),product=index%2?'beta':'alpha';
  const body=post?{amount:index%2?7:4,label:'payload-v1',nested:{enabled:true},items:[1,2,3]}:undefined;
  return {path:(pages?'/api/pages?id='+product+'&':'/api/products/'+product+'?')+'scale=2&token='+token,method:post?'POST':'GET',headers,body,status:post?201:200,encoding:pages?'gzip':'identity',json:true,
    expected:{kind:pages?'pages-api':'route',method:post?'POST':'GET',id:product,scale:2,token,tenant,session,body:body??null,catalogue:Array.from({length:32},(_,i)=>({sku:'sku-'+i,label:'Item '+i,priceCents:1000+i,available:i%2===0}))}};
}
export function validateResponse(response,spec){
  assert.equal(response.status,spec.status||200,'HTTP status');
  assert.equal(response.headers['x-bench-contract'],'dynamic-parity-v1','application header');
  assert.equal(response.headers['content-encoding']||'identity',spec.encoding||'gzip','same HTTP compression work');
  assert.equal(significantHeaders(response.headers)['cache-policy'],'no-store','response must not be cached');
  assert.equal((response.headers['content-type']||'').split(';')[0],spec.json?'application/json':'text/html','content type');
  assert.deepEqual(spec.json?JSON.parse(response.body):htmlData(response.body),spec.expected,'complete application data');
  if(spec.json&&!spec.invalidation){assert.equal(response.headers['x-tenant-echo'],spec.expected.tenant);assert.deepEqual(normalizedCookies(response.headers['set-cookie']),[`seen=${spec.expected.id};httponly;path=/;samesite=lax`])}
  else assert.deepEqual(normalizedCookies(response.headers['set-cookie']),[]);
  assert.ok(!/"digest":"\d+"|__next_error__|Internal Server Error/.test(response.body),'framework render error');
}
export function eventCounts(events){const counts={};for(const event of events)counts[event.kind]=(counts[event.kind]||0)+1;return counts}
export function verifyWork(scenario,events,backend,requests,options){
  if(scenario.cycle){
    assert.equal(requests%4,0,'complete four-response cycles');const cycles=requests/4;
    assert.deepEqual(eventCounts(events),{'render:cache':cycles*3,'cache-fill':cycles*2,revalidate:cycles});
    const groups=new Map();for(const e of events){const key=e.input.key;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e.kind)}
    assert.equal(groups.size,cycles);
    for(let i=0;i<cycles;i++)assert.deepEqual(groups.get('reval-'+options.prefix+'-'+i),['render:cache','cache-fill','render:cache','revalidate','render:cache','cache-fill'],'cache cycle execution order');
    assert.equal(backend.length,cycles*2);const counts=new Map();for(const e of backend){assert.equal(e.method,'GET');assert.equal(e.tenant,'public');counts.set(e.key,(counts.get(e.key)||0)+1)}
    assert.equal(counts.size,cycles);assert.ok([...groups.keys()].every(key=>counts.get(key)===2));
    return {counts:eventCounts(events),backendCalls:backend.length,cycles,processes:[...new Set(events.map(e=>e.pid))].length};
  }
  const counts=eventCounts(events),expected={[scenario.event]:requests};
  if(scenario.cacheFillsPerRequest)expected['cache-fill']=requests*scenario.cacheFillsPerRequest;
  if(scenario.id==='stream'){expected['async:stream']=requests;expected['complete:stream']=requests}
  assert.deepEqual(counts,expected,'actual application function execution counts');
  assert.equal(backend.length,requests*scenario.backendPerRequest,'actual backend call count');
  assert.ok(backend.every(event=>event.method==='GET'),'unexpected backend mutation');
  if(options){
    const wanted=[],reads=[];
    for(let i=0;i<requests;i++){
      const spec=specFor(scenario.id,i,options.prefix,options.constant),v=spec.expected;
      let input;
      if(scenario.id==='ssr')input={token:v.token};
      else if(scenario.id==='product')input=v;
      else if(spec.json){const {catalogue,...argumentsUsed}=v;input=argumentsUsed}
      else if(scenario.id==='data')input={key:'data',tenant:v.data.tenant,token:v.token};
      else if(scenario.id==='session')input={session:v.session};
      else if(scenario.id.startsWith('cache-'))input={key:v.data.key};
      else input={};
      wanted.push({kind:scenario.event,input});
      if(scenario.cacheFillsPerRequest)wanted.push({kind:'cache-fill',input:{key:v.data.key}});
      if(scenario.id==='stream')wanted.push({kind:'async:stream',input:{}},{kind:'complete:stream',input:{}});
      if(scenario.backendPerRequest)reads.push({method:'GET',key:v.data.key,tenant:v.data.tenant});
    }
    const sorted=rows=>rows.map(x=>JSON.stringify(x)).sort();
    assert.deepEqual(sorted(events.map(({kind,input})=>({kind,input}))),sorted(wanted),'all actual execution arguments');
    assert.deepEqual(sorted(backend),sorted(reads),'all actual backend arguments');
  }
  return {counts,backendCalls:backend.length,processes:[...new Set(events.map(e=>e.pid))].length};
}
