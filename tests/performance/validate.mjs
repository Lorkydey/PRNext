import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const url=process.argv[2];
const nonce=/nonce:([0-9a-f-]{36})/;
const seen=new Set();
for(const route of ['ssr','stream','api/json']){
  // Revisit each user/route: unique users alone cannot detect a per-user cache.
  for(let repeat=0;repeat<3;repeat++) await Promise.all(Array.from({length:32},async(_,i)=>{
    const user='validation'+i;
    const r=await fetch(url+'/'+route,{headers:{cookie:'user='+user}});assert.equal(r.status,200);
    const body=await r.text();const id=route==='api/json'?JSON.parse(body).nonce:body.match(nonce)?.[1];
    assert.ok(id,'fresh identifier present');assert.ok(!seen.has(id),'identifier unique across concurrent requests');seen.add(id);
    if(route==='api/json')assert.equal(JSON.parse(body).user,user);else assert.ok(body.includes('user:'+user+'<'),'cookies stay isolated');
  }));
}
const start=performance.now();
const r=await fetch(url+'/stream?delay=2000',{headers:{'accept-encoding':'identity'}});
const headersMs=performance.now()-start;
const reader=r.body.getReader();let prefix='',tail='';
while(!prefix.includes('pending-stream')){const {value,done}=await reader.read();assert.ok(!done);prefix+=Buffer.from(value).toString()}
assert.ok(!prefix.includes('completed:anonymous:'),'fallback arrives before result');const firstMs=performance.now()-start;
for(;;){const {value,done}=await reader.read();if(done)break;tail+=Buffer.from(value).toString()}
const streamCompleteMs=performance.now()-start;
assert.ok(tail.includes('completed:anonymous:'));assert.ok(streamCompleteMs>=1800,'producer really waited from request start');
const pid=async()=>{const r=await fetch(url+'/api/json');await r.arrayBuffer();return r.headers.get('x-worker-pid')};
const before=await pid();
for(let i=0;i<20;i++){
  const r=await fetch(url+'/stream?delay=200',{headers:{'accept-encoding':'identity'}});
  const rd=r.body.getReader();await rd.read();await rd.cancel();await delay(220);
}
const after=await pid();
assert.equal(after,before,'normal cancellation must preserve the healthy host');
console.log(JSON.stringify({uniqueResponses:seen.size,cookieIsolation:true,progressiveStreaming:true,responseHeadersMs:headersMs,firstChunkMs:firstMs,streamCompleteMs,progressiveGapMs:streamCompleteMs-firstMs,cancellations:20,workerBefore:before,workerAfter:after,sameWorker:before===after}));
