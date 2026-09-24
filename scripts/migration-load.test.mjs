import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {load} from './migration-load.mjs';
import {gzipSync} from 'node:zlib';

test('migration load checks POST bodies, request-specific content and counts invalid replies',async t=>{
  const seen=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    seen.push({url:req.url,cookie:req.headers.cookie,method:req.method,body});
    if(req.method==='POST'){res.writeHead(201);res.end('accepted '+body)}
    else if(req.url==='/bad'){res.writeHead(503);res.end('busy')}
    else if(req.url==='/stale')res.end('profile visitor-old');
    else res.end('profile '+(req.headers.cookie||'')+' '+req.url);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const workloads=[{endpoint:'/',marker:'profile',queryNonce:'q',cookieNonce:'visitor'},{endpoint:'/post',method:'POST',body:'{}',status:201,marker:'accepted {}'},{endpoint:'/bad',marker:'busy'},{endpoint:'/stale',marker:'profile',cookieNonce:'visitor'}];
  const result=await load({base:`http://127.0.0.1:${server.address().port}`,workloads,requests:12,concurrency:3});
  assert.equal(result.attempts,12);assert.equal(result.requests,6);assert.equal(result.errors,6);
  assert.deepEqual(result.failures,{'HTTP 503':3,'response content mismatch':3});
  assert.ok(seen.filter(r=>r.method==='POST').every(r=>r.body==='{}'));
  assert.deepEqual(seen.filter(r=>r.url.startsWith('/?')).map(r=>r.cookie).sort(),['visitor=visitor-0','visitor=visitor-4','visitor=visitor-8'].sort());
  assert.ok(result.p95Ms>=result.p50Ms);
});

test('load validates compressed content, binary responses and first-byte streaming timing',async t=>{
  const server=createServer((req,res)=>{
    if(req.url==='/gzip'){res.setHeader('content-encoding','gzip');res.end(gzipSync('payload '.repeat(1000)))}
    else if(req.url==='/broken'){res.setHeader('content-encoding','gzip');res.end('broken')}
    else if(req.url==='/binary'){res.setHeader('content-type','image/webp');res.end(Buffer.from('RIFF1234WEBP'))}
    else if(req.url==='/stream'){res.write('start');setTimeout(()=>res.end('end'),50)}
    else res.end('visitor-00');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const compressed=await load({base,requests:2,concurrency:1,encoding:'gzip',workloads:[{endpoint:'/gzip',marker:'payload',exactBytes:8000}]});
  assert.equal(compressed.errors,0);assert.equal(compressed.encodings.gzip,2);assert.equal(compressed.meanDecodedBytes,8000);assert.ok(compressed.meanBodyBytes<8000);
  const binary=await load({base,requests:1,concurrency:1,workloads:[{endpoint:'/binary',contentType:'image/webp',magicBase64:Buffer.from('RIFF').toString('base64'),exactBytes:12}]});assert.equal(binary.errors,0);
  const stream=await load({base,requests:1,concurrency:1,workloads:[{endpoint:'/stream',marker:'startend'}]});assert.equal(stream.errors,0);assert.ok(stream.p50Ms-stream.ttfbP50Ms>30);
  const broken=await load({base,requests:1,concurrency:1,workloads:[{endpoint:'/broken',marker:'x'}]});assert.equal(broken.failures['invalid compression'],1);
  const stale=await load({base,requests:1,concurrency:1,workloads:[{endpoint:'/nonce',cookieNonce:'visitor'}]});assert.equal(stale.failures['response content mismatch'],1);
});

test('fixed-rate load paces arrivals independently of fast responses and validates its rate',async t=>{
  const arrivals=[];
  const server=createServer((_req,res)=>{arrivals.push(performance.now());res.end('paced');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const options={base:`http://127.0.0.1:${server.address().port}`,workloads:[{endpoint:'/',marker:'paced'}],concurrency:5,durationMs:400,ratePerSecond:50};
  const result=await load(options);
  assert.equal(result.requests,20);assert.equal(result.errors,0);assert.equal(result.targetRatePerSecond,50);
  assert.ok(arrivals.at(-1)-arrivals[0]>=340,'fast replies must not turn pacing into a saturation test');
  assert.ok(Number.isFinite(result.scheduleLagP95Ms));
  for(const ratePerSecond of [0,-1,Infinity,NaN])await assert.rejects(load({...options,ratePerSecond}),/positive finite/);
});
