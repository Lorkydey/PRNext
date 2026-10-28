import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from '../packages/prnext/build/index.mjs';
import {appFixture,startServer} from './support.mjs';

for(const partial of [false,true])test(`Server Component after waits for the ${partial?'partial':'dynamic'} document and drains redirects, 404 and prerender work`,{timeout:90000},async()=>{
  const fixture=await appFixture();let server,reader;
  try{
    for(const name of ['app','pages','proxy.ts'])await rm(path.join(fixture.root,name),{recursive:true,force:true});
    const files={
      'prnext.config.mjs':`export default{cacheComponents:${partial}}`,
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx':`import{Suspense}from'react';import{cookies,headers}from'next/headers';import{after}from'next/server';import{existsSync,appendFileSync}from'node:fs';async function Slow(){const visitor=(await cookies()).get('visitor')?.value||'none';after(async()=>{let blocked=false;try{await headers()}catch{blocked=true}appendFileSync('completed.jsonl',JSON.stringify({visitor,blocked})+'\\n')});const until=Date.now()+20000;while(!existsSync('release-render')&&Date.now()<until)await new Promise(r=>setTimeout(r,20));return <p>DONE {visitor}</p>}export default()=> <main><h1>Shell</h1><Suspense fallback={<p>Waiting</p>}><Slow/></Suspense></main>`,
      'app/static/page.jsx':`import{after}from'next/server';import{appendFileSync}from'node:fs';async function record(value){await new Promise(resolve=>setTimeout(resolve,700));appendFileSync('build-after',value+'\\n')}export async function generateMetadata(){after(()=>record('metadata'));return{title:'Metadata'}}export default function Page(){after(()=>record('page'));return <p>Static</p>}`,
      ...Object.fromEntries(['redirect','notfound'].map(kind=>[`app/${kind}/page.jsx`,`import{cookies}from'next/headers';import{after}from'next/server';import{redirect,notFound}from'next/navigation';import{appendFileSync}from'node:fs';${partial?'export const instant=false;':''}export default async function Page(){await cookies();after(()=>appendFileSync('navigation-after','${kind}\\n'));${kind==='redirect'?"redirect('/static')":"notFound()"}}`])),
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    await build(fixture.root);
    const built=await readFile(path.join(fixture.root,'build-after'),'utf8');assert.ok(built.includes('page'));assert.ok(built.includes('metadata'));
    server=await startServer(fixture.root,['--workers','1']);
    const response=await fetch(server.url,{headers:{cookie:'visitor=one'},signal:AbortSignal.timeout(25000)});reader=response.body.getReader();
    let body='';while(!body.includes('Waiting')){const next=await reader.read();assert.equal(next.done,false);body+=Buffer.from(next.value).toString();}
    await assert.rejects(readFile(path.join(fixture.root,'completed.jsonl')),{code:'ENOENT'});
    await writeFile(path.join(fixture.root,'release-render'),'go');
    for(;;){const next=await reader.read();if(next.done)break;body+=Buffer.from(next.value).toString();}assert.match(body,/DONE/);
    let records;for(let i=0;i<100;i++){try{records=(await readFile(path.join(fixture.root,'completed.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);break;}catch{await delay(20);}}
    assert.deepEqual(records,[{visitor:'one',blocked:true}]);
    for(const[kind,status]of [['redirect',307],['notfound',404]]){const response=await fetch(server.url+'/'+kind,{redirect:'manual'});assert.equal(response.status,status);await response.text();}
    let navigation='';for(let i=0;i<100&&!navigation.includes('notfound');i++){try{navigation=await readFile(path.join(fixture.root,'navigation-after'),'utf8');}catch{}await delay(20);}
    assert.deepEqual(navigation.trim().split('\n'),['redirect','notfound']);
  }finally{await writeFile(path.join(fixture.root,'release-render'),'go').catch(()=>{});await reader?.cancel().catch(()=>{});await server?.close();await fixture.remove();}
});
