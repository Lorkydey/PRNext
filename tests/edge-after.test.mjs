import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from '../packages/prnext/build/index.mjs';
import {appFixture,startServer} from './support.mjs';

test('Edge after preserves response completion, request identity and nested work in handlers, renders and actions',{timeout:60000},async()=>{
  const f=await appFixture(),records=[];let server,cachedCalls=0;
  const origin=createServer(async(req,res)=>{if(req.url==='/cached'){res.end(String(++cachedCalls));return}records.push(JSON.parse(decodeURIComponent(req.url.slice(1))));res.end('ok')});
  origin.listen(0,'127.0.0.1');await once(origin,'listening');
  const url=`http://127.0.0.1:${origin.address().port}/`;
  const report=`async function report(kind,user){await fetch(${JSON.stringify(url)}+encodeURIComponent(JSON.stringify({kind,user,runtime:process.env.NEXT_RUNTIME,node:typeof Buffer})))}`;
  try{
    const files={
      'app/edge-after/route.js':`import{after}from'next/server';import{cookies}from'next/headers';export const runtime='edge';export const maxDuration=10;${report};export async function GET(){after(async()=>{await new Promise(done=>setTimeout(done,300));const user=(await cookies()).get('user')?.value;await report('handler',user);after(()=>report('nested',user))});return new Response('ready')}`,
      'app/edge-after-cache/route.js':`import{after}from'next/server';import{revalidateTag}from'next/cache';export const runtime='edge';export async function GET(){return new Response(await(await fetch(${JSON.stringify(url+'cached')},{cache:'force-cache',next:{tags:['edge-after-cache'],revalidate:3600}})).text())}export async function POST(){after(()=>revalidateTag('edge-after-cache',{expire:0}));return new Response('invalidating')}`,
      'app/edge-after-page/page.jsx':`import{after}from'next/server';import{cookies}from'next/headers';import Client from'./client';export const runtime='edge';export const dynamic='force-dynamic';${report};async function action(){'use server';const user=(await cookies()).get('user')?.value;after(async()=>{await new Promise(done=>setTimeout(done,300));await report('action',user)})}export default async function Page(){const user=(await cookies()).get('user')?.value;after(async()=>{await new Promise(done=>setTimeout(done,300));await report('render',user)});return <><Client/><form action={action}><button>Run after</button></form></>}`,
      'app/edge-after-page/client.jsx':`'use client';import Form from'next/form';import Link,{useLinkStatus}from'next/link';import{useServerInsertedHTML}from'next/navigation';import{useReportWebVitals}from'next/web-vitals';export default function Client(){useReportWebVitals(()=>{});useServerInsertedHTML(()=> <style data-edge-inserted='yes'>{'.edge-inserted{color:red}'}</style>);const status=useLinkStatus();return <section className='edge-scope'><Link href='/edge-after'>{status.pending?'pending':'Edge link'}</Link><Form action='/edge-after'><input name='value' defaultValue='edge'/><button>Edge GET form</button></Form><style jsx>{'.edge-scope{color:rgb(4,5,6)}'}</style></section>}`,
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(f.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)}
    await build(f.root);server=await startServer(f.root,['--workers','1']);
    const responses=await Promise.all(['alice','bob'].map(user=>fetch(server.url+'/edge-after',{headers:{cookie:'user='+user}})));
    for(const response of responses)assert.equal(await response.text(),'ready');
    assert.equal(records.filter(x=>x.kind==='handler').length,0,'after must not delay the HTTP body');
    const page=await fetch(server.url+'/edge-after-page',{headers:{cookie:'user=carol'}}),html=await page.text();assert.equal(page.status,200,server.output().slice(-4000));
    assert.match(html,/data-edge-inserted="yes"/);assert.match(html,/\.edge-scope\.jsx-/);assert.match(html,/Edge GET form/);
    const id=/name="\$ACTION_ID_([^"]+)"/.exec(html)?.[1];assert.ok(id);
    const action=await fetch(server.url+'/edge-after-page',{method:'POST',headers:{cookie:'user=dave',origin:server.url,'Next-Action':id,'content-type':'text/plain'},body:'[]'});
    assert.equal(action.status,200);await action.text();
    for(let i=0;i<100&&!records.some(x=>x.kind==='action');i++)await new Promise(done=>setTimeout(done,50));
    for(const[kind,user]of [['handler','alice'],['handler','bob'],['nested','alice'],['nested','bob'],['render','carol'],['action','dave']])assert.ok(records.some(x=>x.kind===kind&&x.user===user&&x.runtime==='edge'&&x.node==='undefined'),JSON.stringify(records));
    assert.doesNotMatch(server.output(),/after\(\) failed|restarting render worker|EPIPE/);
    const cached=()=>fetch(server.url+'/edge-after-cache').then(r=>r.text());assert.equal(await cached(),'1');assert.equal(await cached(),'1');
    assert.equal(await(await fetch(server.url+'/edge-after-cache',{method:'POST'})).text(),'invalidating');
    let value;for(let i=0;i<100;i++){value=await cached();if(value==='2')break;await new Promise(done=>setTimeout(done,20))}assert.equal(value,'2');assert.equal(cachedCalls,2);
  }finally{await server?.close();origin.closeAllConnections();await new Promise(done=>origin.close(done));await f.remove()}
});
