import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {publishDevCacheCapability,invalidateDevRouteCache,normalizeDevCachePath} from './dev-cache-control.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-dev-cache-')),directory=path.join(root,'.prnext-dev','session','build');await mkdir(directory,{recursive:true});
  const manifest={dev:true,devSession:'session',buildId:'build',config:{}};await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  const env={PRNEXT_CACHE_URL:'http://127.0.0.1:1234/cache',PRNEXT_CACHE_TOKEN:'a'.repeat(64)};
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,directory,manifest,env,session:'session',buildId:'build'};
}
test('development-only native cache capability is private, scoped and never returned',async t=>{
  const f=await fixture(t);assert.equal(await publishDevCacheCapability({...f,distDir:f.directory,manifest:{...f.manifest,dev:false}}),false);
  assert.equal(await publishDevCacheCapability({...f,distDir:f.directory}),true);
  const value=JSON.parse(await readFile(path.join(f.directory,'.dev-cache-rpc.json'),'utf8'));assert.equal(value.token,f.env.PRNEXT_CACHE_TOKEN);
  const requests=[];const result=await invalidateDevRouteCache({...f,paths:['/docs/a/','/a?secret=yes'],fetcher:async(url,init)=>{requests.push({url,init});return new Response('{}');}});
  assert.deepEqual(JSON.parse(requests[0].init.body),{op:'invalidate',paths:['page:/docs/a','page:/a'],mode:'expire'});
  assert.equal(result.generationPreserved,true);assert.equal(result.invalidated,true);assert.doesNotMatch(JSON.stringify(result),/aaaaaaa/);
});
test('cold and custom cache handlers return explicit non-success without issuing RPC',async t=>{
  const f=await fixture(t);let called=false;const fetcher=()=>{called=true;throw Error('Not expected');};
  assert.equal((await invalidateDevRouteCache({...f,paths:['/a'],fetcher})).invalidated,false);
  await writeFile(path.join(f.directory,'manifest.json'),JSON.stringify({...f.manifest,config:{cacheHandler:'custom.js'}}));
  const custom=await invalidateDevRouteCache({...f,paths:['/a'],fetcher});assert.equal(custom.invalidated,false);assert.equal(custom.scope,'custom-handler');assert.equal(called,false);
});
test('cache controls reject production, stale identities, redirects and unsafe endpoints',async t=>{
  const f=await fixture(t);await publishDevCacheCapability({...f,distDir:f.directory});
  await assert.rejects(invalidateDevRouteCache({...f,buildId:'old',paths:['/a']}),/generation changed/);
  await assert.rejects(publishDevCacheCapability({...f,distDir:f.directory,env:{...f.env,PRNEXT_CACHE_URL:'http://attacker.example/cache'}}),/Invalid development cache endpoint/);
  await writeFile(path.join(f.directory,'manifest.json'),JSON.stringify({...f.manifest,dev:false}));
  await assert.rejects(invalidateDevRouteCache({...f,paths:['/a']}),/generation changed/);
  for(const value of ['//example.test/a','https://example.test/a','/a\\b','/a\0b'])assert.throws(()=>normalizeDevCachePath(value));
});
test('cache capabilities cannot escape the managed development generation through aliases',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');await mkdir(outside);
  await assert.rejects(publishDevCacheCapability({...f,distDir:outside}),/live project generation/);
  const alias=path.join(f.root,'.prnext-dev','session','alias');try{await symlink(outside,alias,'junction');await assert.rejects(publishDevCacheCapability({...f,distDir:alias}),/live project generation/);}catch(error){if(!['EPERM','EACCES','ENOTSUP'].includes(error.code))throw error;}
});
