import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cacheGeneration,cachedValue} from '../compat/data-cache.cjs';

async function cache(t,handler){
  const previous=[process.env.RUSTYX_CACHE_URL,process.env.RUSTYX_CACHE_TOKEN];
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.RUSTYX_CACHE_URL=`http://127.0.0.1:${server.address().port}/cache?version=1`;
  process.env.RUSTYX_CACHE_TOKEN='rpc-test';
  t.after(async()=>{for(const[i,name]of ['RUSTYX_CACHE_URL','RUSTYX_CACHE_TOKEN'].entries()){if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i]}server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  return server;
}
test('local RPC reuses its connection without caching generation or dropping authentication',async t=>{
  let generation=0,connections=0;
  const server=await cache(t,async(req,res)=>{
    assert.equal(req.method,'POST');assert.equal(req.url,'/cache?version=1');assert.equal(req.headers.authorization,'Bearer rpc-test');
    let body='';for await(const chunk of req)body+=chunk;
    assert.deepEqual(JSON.parse(body),{op:'generation'});res.end(JSON.stringify({generation:++generation}));
  });server.on('connection',()=>connections++);
  for(let i=1;i<=12;i++)assert.equal(await cacheGeneration(),i);
  assert.equal(connections,1);
});
test('local RPC retries saturation and rejects malformed or oversized responses',async t=>{
  let calls=0,mode='retry';await cache(t,(req,res)=>{req.resume();if(mode==='retry'&&++calls<3){res.writeHead(503);res.end('busy')}else if(mode==='malformed')res.end('{broken');else if(mode==='large')res.end('x'.repeat(4*1024*1024+1));else res.end('{"generation":7}')});
  assert.equal(await cacheGeneration(),7);assert.equal(calls,3);
  mode='malformed';await assert.rejects(cacheGeneration(),SyntaxError);
  mode='large';await assert.rejects(cacheGeneration(),/exceeds 4 MiB/);
  mode='recovered';assert.equal(await cacheGeneration(),7);
});
test('local RPC aborts a response body and removes its request signal listener',async t=>{
  let release;const started=new Promise(resolve=>release=resolve);
  await cache(t,(req,res)=>{req.resume();res.writeHead(200);res.write('{"generation":');release()});
  const controller=new AbortController();
  const pending=cacheGeneration(controller.signal);const rejected=assert.rejects(pending,/cancel RPC/);
  await started;controller.abort(new Error('cancel RPC'));await rejected;
  await assert.rejects(cacheGeneration(controller.signal),/cancel RPC/);
});

test('versioned reads use the acquired namespace for commits and recheck it after waiting',async t=>{
  const base='a'.repeat(64),old='b'.repeat(64),next='c'.repeat(64),lease='d'.repeat(64);
  const operations=[];let reads=0;
  await cache(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const op=JSON.parse(body);operations.push(op);
    if(op.op==='read'){
      assert.equal(op.key,base);assert.equal(op.versioned,true);
      const state=++reads===1?{state:'pending',key:old,generation:0,retryAfterMs:5}
        :reads===2?{state:'miss',key:next,generation:1,lease}:{state:'fresh',key:next,generation:1,value:Buffer.from('fresh').toString('base64')};
      res.end(JSON.stringify(state));
    }else{assert.equal(op.op,'commit');assert.equal(op.key,next);assert.equal(op.lease,lease);res.end('{"stored":true}')}
  });
  let produced=0;
  assert.equal((await cachedValue(base,({generation})=>{produced++;assert.equal(generation,1);return Buffer.from('fresh')},{versioned:true})).toString(),'fresh');
  assert.equal((await cachedValue(base,()=>{throw new Error('hit ran producer')},{versioned:true})).toString(),'fresh');
  assert.equal(produced,1);assert.deepEqual(operations.map(op=>op.op),['read','read','commit','read']);
});

test('a cache outage never authorizes reusing a versioned build artifact',async t=>{
  await cache(t,(req,res)=>{req.resume();res.writeHead(500);res.end()});
  const value=await cachedValue('a'.repeat(64),info=>{
    assert.equal(info.generation,undefined);assert.equal(info.cache,false);return Buffer.from('regenerated');
  },{versioned:true});
  assert.equal(value.toString(),'regenerated');
});


test('bursty cache RPC keeps a bounded reusable pool instead of churning ephemeral ports', async t => {
  const width=16;let connections=0,pending=[];
  const server=await cache(t,async(req,res)=>{
    for await(const _ of req){}
    pending.push(res);
    if(pending.length===width){const batch=pending;pending=[];setImmediate(()=>{for(const response of batch)response.end('{"generation":7}')})}
  });
  server.on('connection',()=>connections++);
  for(let wave=0;wave<6;wave++){
    assert.deepEqual(await Promise.all(Array.from({length:width},()=>cacheGeneration())),Array(width).fill(7));
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(connections,width,'Idle sockets must survive gaps between concurrent cache bursts');
});
