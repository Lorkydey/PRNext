import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,symlink,mkdtemp,cp,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {appFixture,startServer,repositoryRoot} from './support.mjs';
import {redisServer} from './redis-test-support.mjs';

test('two real PRNext servers share Redis components and observe cross-instance invalidation',{timeout:120000},async()=>{
  const redis=await redisServer(),fixture=await appFixture();let a,b,deployed;
  try{
    await rm(path.join(fixture.root,'app'),{recursive:true});
    await mkdir(path.join(fixture.root,'node_modules/@redis'));
    await symlink(fileURLToPath(new URL('./toolchain/node_modules/@redis/client',import.meta.url)),path.join(fixture.root,'node_modules/@redis/client'),'junction');
    const files={
      'prnext.config.mjs':`export default{output:'standalone',cacheComponents:true,cacheHandlers:{remote:'./redis-handler.mjs'}}`,
      'redis-handler.mjs':`import{createRedisCache}from'@thomas.f/prnext/cache/redis';export default createRedisCache({namespace:${JSON.stringify(randomUUID())},urlEnv:'PRNEXT_REDIS_TEST_URL'})`,
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx':`import{Suspense}from'react';import{product}from'./product';async function Value(){const result=await product();return <h1>Redis generation {result.n}</h1>}export default()=> <Suspense fallback={<p>Loading</p>}><Value/></Suspense>`,
      'app/product.js':`import{cacheTag,cacheLife}from'next/cache';import{appendFile,readFile}from'node:fs/promises';export async function product(){'use cache: remote';cacheTag('products');cacheLife('hours');await appendFile('redis-http-producers','x');return{n:(await readFile('redis-http-producers','utf8')).length}}`,
      'app/invalidate/route.js':`import{revalidateTag}from'next/cache';export async function POST(){revalidateTag('products',{expire:0});return Response.json({ok:true})}`,
    };
    for(const[name,source]of Object.entries(files)){const filename=path.join(fixture.root,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,source);}
    const env={PRNEXT_REDIS_TEST_URL:redis.url};
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root],{cwd:fixture.root,env:{...process.env,...env},maxBuffer:8*1024*1024});
    a=await startServer(fixture.root,['--workers','1'],env);b=await startServer(fixture.root,['--workers','1'],env);
    const first=await(await fetch(a.url)).text(),second=await(await fetch(b.url)).text();
    const generation=html=>Number(/Redis generation <!-- -->(\d+)/.exec(html)?.[1]||/Redis generation (\d+)/.exec(html)?.[1]);
    assert.ok(generation(first)>0,first.slice(0,2000));assert.equal(generation(second),generation(first));
    const count=await readFile(path.join(fixture.root,'redis-http-producers'),'utf8');
    const invalidated=await fetch(b.url+'/invalidate',{method:'POST'});assert.equal(invalidated.status,200);await invalidated.body?.cancel();
    const fresh=await(await fetch(a.url)).text();assert.ok(generation(fresh)>generation(first),fresh.slice(0,2000));assert.equal((await readFile(path.join(fixture.root,'redis-http-producers'),'utf8')).length,count.length+1);
    await a.close();a=undefined;await b.close();b=undefined;
    // Match Node's canonical module resolution for confinement on macOS /var.
    deployed=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-redis-standalone-')));
    // Preserve the artifact's relative dependency links while relocating it.
    await cp(path.join(fixture.root,'.prnext/standalone'),deployed,{recursive:true,verbatimSymlinks:true});
    await fixture.remove();
    const metadata=JSON.parse(await readFile(path.join(deployed,'standalone.json'),'utf8')),app=path.join(deployed,metadata.app);
    // Resolve from the actual provider: standalone dependencies may be bridged
    // beside their importer instead of hoisted into the application's root.
    const require=createRequire(path.join(app,metadata.distDir,'compat/redis-cache.cjs')),client=await readFile(require.resolve('@redis/client/package.json'),'utf8');assert.equal(JSON.parse(client).version,'6.3.0');
    const clientPath=path.relative(deployed,require.resolve('@redis/client/package.json'));assert.ok(!clientPath.startsWith('..')&&!path.isAbsolute(clientPath),'Redis must be traced inside the isolated deployment');
    a=await startServer(app,['--workers','1'],env);const relocated=await fetch(a.url);assert.equal(relocated.status,200);assert.equal(generation(await relocated.text()),generation(fresh),a.output());
  }finally{await a?.close();await b?.close();await fixture.remove();if(deployed)await rm(deployed,{recursive:true,force:true,maxRetries:5,retryDelay:100});await redis.close();}
});
