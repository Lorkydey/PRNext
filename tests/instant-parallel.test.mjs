import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appFixture,repositoryRoot,startServer} from './support.mjs';

test('PPR validates instant named slots below preserved layouts without promoting warning branches to build errors',async()=>{
  const f=await appFixture();let server;
  try{
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(f.root,name),{recursive:true,force:true});
    const files={
      'next.config.mjs':`export default {cacheComponents:true}`,
      'app/layout.jsx':`import{Suspense}from'react';export default({children,detail})=><html><body><Suspense fallback={<p>Root pending</p>}>{children}{detail}</Suspense></body></html>`,
      'app/page.jsx':`export default()=> <h1>Main</h1>`,
      'app/@detail/page.jsx':`import{cookies}from'next/headers';export const instant={level:'experimental-error'};export default async()=> <p>{(await cookies()).get('visitor')?.value||'guest'}</p>`,
    };
    for(const[name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(f.root,name)),{recursive:true});await writeFile(path.join(f.root,name),source);}
    const build=()=>promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',f.root],{maxBuffer:4*1024*1024});
    await assert.rejects(build(),/instant navigation.*@detail/);
    await writeFile(path.join(f.root,'app/@detail/loading.jsx'),`export default()=> <p>Detail pending</p>`);
    await writeFile(path.join(f.root,'app/page.jsx'),`import{cookies}from'next/headers';export const instant={level:'warning'};export default async()=> <h1>{(await cookies()).get('main')?.value||'Main'}</h1>`);
    await build();
    const manifest=JSON.parse(await readFile(path.join(f.root,'.rustyx/manifest.json'),'utf8'));
    assert.equal(manifest.routes.find(route=>route.pattern==='/').instantBuild,true);
    server=await startServer(f.root);
    for(const visitor of ['Ada','Lin']){
      const response=await fetch(server.url,{headers:{cookie:'visitor='+visitor}});
      assert.equal(response.status,200);assert.equal(response.headers.get('x-rustyx-prerender'),'partial');assert.match(await response.text(),new RegExp(visitor));
    }
  }finally{await server?.close();await f.remove();}
});
