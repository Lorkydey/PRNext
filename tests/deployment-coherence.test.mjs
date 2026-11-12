import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import { deploymentFixture, deploymentProxy } from './deployment-coherence-fixture.mjs';

test('closing the deployment proxy also cancels its active upstream response',{timeout:5000},async()=>{
  let upstreamClosed;const ended=new Promise(resolve=>{upstreamClosed=resolve;});
  const upstream=createServer((req,res)=>{res.once('close',upstreamClosed);res.writeHead(200,{'content-type':'text/plain'});res.write('prefix');});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=deploymentProxy(()=>'http://127.0.0.1:'+upstream.address().port);
  proxy.server.listen(0,'127.0.0.1');await once(proxy.server,'listening');
  try{
    const response=await fetch('http://127.0.0.1:'+proxy.server.address().port+'/held');
    assert.equal(response.status,200);const reader=response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value),'prefix');
    await proxy.close();await ended;
    await reader.cancel().catch(()=>{});reader.releaseLock();
  }finally{await proxy.close();await new Promise(resolve=>{upstream.close(resolve);upstream.closeAllConnections();});}
});

test('deployment rejects stale Flight, Pages data and mutations before application effects while retaining immutable chunks',async()=>{
  const f=await deploymentFixture();
  try{
    const old=f.first.manifest, next=(await f.compile('two')).manifest;
    assert.equal(old.buildId,next.buildId);assert.notEqual(old.config.deploymentId,next.config.deploymentId);
    const stale={'x-prnext-deployment-id':old.config.deploymentId};
    const action=Object.keys(old.app.actions)[0];assert.ok(action);
    for(const [pathname,options]of [
      ['/docs/next',{headers:{...stale,rsc:'1',accept:'text/x-component'}}],
      ['/docs/_prnext/data/constant-build/legacy.json',{headers:{...stale,'x-nextjs-data':'1'}}],
      ['/docs/',{method:'POST',headers:{...stale,rsc:'1','next-action':action,'content-type':'text/plain'},body:'[]'}],
    ]){
      const response=await fetch(f.url+pathname,options);assert.equal(response.status,409,pathname);
      assert.equal(response.headers.get('x-prnext-deployment-id'),next.config.deploymentId);
      assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('location'),null);
    }
    const legacyAction=await fetch(f.url+'/docs',{method:'POST',headers:{rsc:'1','next-action':action,'content-type':'text/plain'},body:'[]'});
    assert.equal(legacyAction.status,404);await legacyAction.body?.cancel();
    assert.deepEqual(f.counts(),{mutations:0,hooks:0,middlewares:0});
    const retired=Object.keys(next.config.retainedAssets);assert.ok(retired.length);
    for(const name of retired){const response=await fetch(f.url+'/cdn/_prnext/assets/'+name);assert.equal(response.status,200,name);await response.body?.cancel();}
    const gzip=await fetch(f.url+'/cdn/_prnext/assets/'+retired[0]+'.gz');assert.equal(gzip.status,200);await gzip.body?.cancel();
    for(const file of ['manifest.json','deployment-assets.json','../manifest.json'])assert.equal((await fetch(f.url+'/cdn/_prnext/assets/'+file)).status,404,file);
    const fresh=await fetch(f.url+'/docs/next',{headers:{rsc:'1','x-prnext-deployment-id':next.config.deploymentId}});assert.equal(fresh.status,200);assert.equal(fresh.headers.get('x-prnext-deployment-id'),next.config.deploymentId);assert.match(await fresh.text(),/Next two/);
    await f.restartWithManifest(manifest=>{for(const name of Object.keys(manifest.config.retainedAssets))manifest.config.retainedAssets[name]=1;});
    for(const mount of ['/cdn','/docs'])for(const suffix of ['', '.gz', '.br']){
      const response=await fetch(f.url+mount+'/_prnext/assets/'+retired[0]+suffix);assert.equal(response.status,404,mount+suffix);await response.body?.cancel();
    }
    if(process.platform==='win32')assert.equal((await fetch(f.url+'/cdn/_prnext/assets/'+retired[0].toUpperCase())).status,404);
    const currentClient=next.routes.find(route=>route.pattern==='/next').client;
    assert.equal((await fetch(f.url+currentClient)).status,200);
  }finally{await f.close();}
});
