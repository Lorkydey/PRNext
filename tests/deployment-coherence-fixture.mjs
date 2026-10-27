import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

export async function deploymentFixture() {
  const f=await appFixture(), servers=[];let mutations=0, hooks=0, middlewares=0, upstream;
  const effects=createServer((req,res)=>{if(req.url==='/mutation')mutations++;if(req.url==='/hook')hooks++;if(req.url==='/middleware')middlewares++;res.end('ok');});
  const proxy=createServer(async(req,res)=>{
    try{
      const headers={...req.headers};delete headers.host;
      const result=await fetch(upstream+req.url,{method:req.method,headers,redirect:'manual',...(req.method==='GET'||req.method==='HEAD'?{}:{body:req,duplex:'half'})});
      const outputHeaders=Object.fromEntries(result.headers);delete outputHeaders['content-encoding'];delete outputHeaders['content-length'];
      res.writeHead(result.status,outputHeaders);
      if(result.body)for await(const chunk of result.body)res.write(chunk);res.end();
    }catch{res.writeHead(502);res.end();}
  });
  try{
    effects.listen(0,'127.0.0.1');await once(effects,'listening');
    const effectsURL=`http://127.0.0.1:${effects.address().port}`;
    for(const directory of ['app','pages','components','lib','proxy.ts'])await rm(path.join(f.root,directory),{recursive:true,force:true});
    const files={
      'prnext.config.mjs':`export default{generateBuildId:()=> 'constant-build',basePath:'/docs',assetPrefix:'/cdn',async headers(){return[{source:'/next',headers:[{key:'x-prnext-deployment-id',value:'forged'}]}]}}`,
      'proxy.js':`import {NextResponse} from 'next/server';export async function proxy(){await fetch(${JSON.stringify(effectsURL+'/middleware')});const response=NextResponse.next();response.headers.set('x-prnext-deployment-id','forged');return response}export const config={matcher:['/next']}` ,
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/actions.js':`'use server';export async function mutate(){await fetch(${JSON.stringify(effectsURL+'/mutation')},{method:'POST'});return 'saved'}`,
      'app/control.jsx':`'use client';import {useState,useEffect} from 'react';import Link from 'next/link';import {mutate} from './actions';export default function Control(){const [ready,setReady]=useState(false),[message,setMessage]=useState('');useEffect(()=>setReady(true),[]);return <><button disabled={!ready} onClick={async()=>{try{setMessage(await mutate())}catch(error){setMessage(error.code||error.message)}}}>save</button><output>{message}</output><Link prefetch={false} href="/next">next page</Link></>}`,
      'app/page.jsx':`import Control from './control';export default()=> <><h1>Deployment one</h1><Control/></>`,
      'app/next/page.jsx':`export default()=> <h1>Next one</h1>`,
      'pages/legacy.jsx':`export default({value})=><h1>{value}</h1>;export async function getServerSideProps(){await fetch(${JSON.stringify(effectsURL+'/hook')});return {props:{value:'Legacy props'}}}`,
    };
    for(const [name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(f.root,name)),{recursive:true});await writeFile(path.join(f.root,name),source);}
    async function compile(version){
      await writeFile(path.join(f.root,'app/page.jsx'),`import Control from './control';export default()=> <><h1>Deployment ${version}</h1><Control/></>`);
      await writeFile(path.join(f.root,'app/next/page.jsx'),`export default()=> <h1>Next ${version}</h1>`);
      await build(f.root);
      const manifest=JSON.parse(await readFile(path.join(f.root,'.prnext','manifest.json'),'utf8'));
      const server=await startServer(f.root);servers.push(server);upstream=server.url;
      return {manifest,server};
    }
    async function restartWithManifest(change){
      const file=path.join(f.root,'.prnext','manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));change(manifest);await writeFile(file,JSON.stringify(manifest));
      const server=await startServer(f.root);servers.push(server);upstream=server.url;return server;
    }
    const first=await compile('one');
    proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
    return {...f,first,url:`http://127.0.0.1:${proxy.address().port}`,compile,restartWithManifest,counts:()=>({mutations,hooks,middlewares}),async close(){
      proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
      effects.closeAllConnections();await new Promise(resolve=>effects.close(resolve));
      for(const server of servers)await server.close();await f.remove();
    }};
  }catch(error){proxy.closeAllConnections();proxy.close();effects.closeAllConnections();effects.close();for(const server of servers)await server.close();await f.remove();throw error;}
}
