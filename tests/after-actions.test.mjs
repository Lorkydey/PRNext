import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../packages/prnext/build/index.mjs';
import { appFixture, startServer } from './support.mjs';

test('Server Action after waits for the HTTP stream and survives error, redirect and disconnect', {timeout:60000}, async () => {
 const fixture=await appFixture();let server;
 try {
  await rm(path.join(fixture.root,'app'),{recursive:true});
  await mkdir(path.join(fixture.root,'app','deferred'),{recursive:true});
  await writeFile(path.join(fixture.root,'app','layout.jsx'),`export default function Layout({children}){return <html><body>{children}</body></html>}`);
  await writeFile(path.join(fixture.root,'app','page.jsx'),`export default function Page(){return <p>home</p>}`);
  await writeFile(path.join(fixture.root,'app','deferred','action.js'),`'use server';
   import {after} from 'next/server';import{cookies}from'next/headers';import{redirect}from'next/navigation';import{appendFile}from'node:fs/promises';
   export async function defer(mode){after(async()=>{await new Promise(r=>setTimeout(r,mode==='abort'?6200:100));await appendFile('.after-actions',JSON.stringify({mode,user:(await cookies()).get('user')?.value})+'\\n')});
   if(mode==='error')throw Error('expected-action-error');if(mode==='redirect')redirect('/');return mode;}
  `);
  await writeFile(path.join(fixture.root,'app','deferred','page.jsx'),`import{Suspense}from'react';import{cookies}from'next/headers';import{defer}from'./action';export const dynamic='force-dynamic';export const maxDuration=15;
   async function Slow(){await cookies();await new Promise(r=>setTimeout(r,1500));return <p>finished-content</p>}
   export default function Page(){return <main><form action={defer}><button>Go</button></form><h1>response-start</h1><Suspense fallback={<p>waiting</p>}><Slow/></Suspense></main>}`);
  await build(fixture.root);
  const manifest=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
  assert.equal(Object.keys(manifest.app.actions).length,1);
  const [actionId]=Object.keys(manifest.app.actions);
  server=await startServer(fixture.root,['--workers','1','--worker-idle-seconds','1','--lane-idle-seconds','1']);
  const records=async()=>{try{return(await readFile(path.join(fixture.root,'.after-actions'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch(e){if(e.code==='ENOENT')return[];throw e}};
  const invoke=(mode,user,signal)=>fetch(server.url+'/deferred',{method:'POST',headers:{'Next-Action':actionId,'Content-Type':'text/plain',origin:server.url,cookie:'user='+user},body:JSON.stringify([mode]),signal});
  const response=await invoke('ok','alice');assert.equal(response.status,200,server.output());const reader=response.body.getReader();assert.match(Buffer.from((await reader.read()).value).toString(),/response-start/);
  await delay(400);assert.deepEqual(await records(),[],'after must wait for the slow response');
  let end='';for(;;){const n=await reader.read();if(n.done)break;end+=Buffer.from(n.value)}assert.match(end,/finished-content/);
  const error=await invoke('error','bob');assert.equal(error.status,500);await error.text();
  const redirected=await invoke('redirect','carol');await redirected.text();
  const abort=new AbortController();const abandoned=await invoke('abort','dave',abort.signal);await abandoned.body.getReader().read();abort.abort();
  await delay(5500);
  for(let i=0;i<35 && (await records()).length<4;i++)await delay(100);
  assert.deepEqual((await records()).sort((a,b)=>a.mode.localeCompare(b.mode)),[{mode:'abort',user:'dave'},{mode:'error',user:'bob'},{mode:'ok',user:'alice'},{mode:'redirect',user:'carol'}]);
  assert.doesNotMatch(server.output(),/restarting render worker|RSC background worker stopped|EPIPE/);
 } finally{await server?.close();await fixture.remove();}
});
