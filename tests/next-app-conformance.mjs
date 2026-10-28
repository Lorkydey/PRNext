import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appFixture,startServer,repositoryRoot} from './support.mjs';
import {linkNextReference,buildNextReference,nextServer} from './next-reference-support.mjs';

test('Next and PRNext agree on mounted App metadata, request context, form Actions and navigation state',{timeout:180000},async()=>{
  const fixture=await appFixture();let next,candidate,browser;
  try{
    for(const name of ['app','pages','public','components','proxy.ts','tsconfig.json','next-env.d.ts'])await rm(path.join(fixture.root,name),{recursive:true,force:true});
    const {cli,version}=await linkNextReference(fixture.root);
    await writeFile(path.join(fixture.root,'package.json'),JSON.stringify({name:'prnext-app-contract',private:true,type:'module',dependencies:{next:version,react:'19.3.1','react-dom':'19.3.1'}}));
    const files={
      'next.config.mjs':`export default{basePath:'/docs'}`,
      'app/layout.jsx':`import Counter from './counter';export const metadata={title:'Oracle App'};export default({children})=><html><body><Counter/>{children}</body></html>`,
      'app/counter.jsx':`'use client';import{useState}from'react';export default function Counter(){const[n,set]=useState(0);return <button onClick={()=>set(n+1)}>counter {n}</button>}`,
      'app/actions.js':`'use server';import{cookies}from'next/headers';export async function save(previous,form){const jar=await cookies();const value=Number(jar.get('oracle-count')?.value||0)+Number(form.get('amount'));jar.set('oracle-count',String(value),{path:'/docs',httpOnly:true,sameSite:'lax'});return{value}}`,
      'app/form.jsx':`'use client';import{useActionState}from'react';import{save}from'./actions';export default function Form(){const[state,action,pending]=useActionState(save,{value:0});return <form action={action}><input name='amount' value='2' readOnly/><button disabled={pending}>Save</button><output data-testid='result'>{state.value}</output></form>}`,
      'app/page.jsx':`import Form from './form';import Link from'next/link';export const dynamic='force-dynamic';export default()=> <main><h1>Oracle home</h1><Form/><Link href='/item/two?tag=a&tag=b'>Open item</Link></main>`,
      'app/item/[id]/page.jsx':`export const dynamic='force-dynamic';export async function generateMetadata({params}){return{title:'Item '+(await params).id}}export default async function Item({params,searchParams}){const{id}=await params,{tag}=await searchParams;return <main><h1>Item {id}</h1><pre data-testid='params'>{JSON.stringify({id,tag})}</pre></main>}`,
      'app/api/context/route.js':`import{cookies,headers}from'next/headers';export const dynamic='force-dynamic';export async function GET(request){return Response.json({count:(await cookies()).get('oracle-count')?.value||null,probe:(await headers()).get('x-probe'),path:request.nextUrl.pathname,tags:request.nextUrl.searchParams.getAll('tag')})}`,
      'app/go/page.jsx':`import{redirect}from'next/navigation';export default()=>redirect('/item/one?source=redirect')`,
      'app/missing/page.jsx':`import{notFound}from'next/navigation';export default()=>notFound()`,
      'app/not-found.jsx':`export default()=> <h1>Oracle missing</h1>`,
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    await buildNextReference(cli,fixture.root);next=await nextServer(cli,fixture.root);
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root],{maxBuffer:4*1024*1024});
    candidate=await startServer(fixture.root,['--workers','1']);
    browser=await chromium.launch();const observations=[];
    for(const server of [next,candidate]){
      const context=await browser.newContext(),page=await context.newPage();const errors=[];let documents=0;
      page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.resourceType()==='document')documents++;});
      await page.goto(server.url+'/docs');await page.getByRole('button',{name:'counter 0',exact:true}).click();
      await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByTestId('result').filter({hasText:'2'}).waitFor();
      await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="result"]')?.textContent==='4');
      const cookie=(await context.cookies()).find(cookie=>cookie.name==='oracle-count');assert.ok(cookie);
      const api=await fetch(server.url+'/docs/api/context?tag=a&tag=b',{headers:{cookie:'oracle-count='+cookie.value,'x-probe':'one'}});
      const requestContext=await api.json();
      await page.getByRole('link',{name:'Open item'}).click();await page.getByRole('heading',{name:'Item two',exact:true}).waitFor();
      await page.waitForFunction(()=>document.title==='Item two');
      const redirect=await fetch(server.url+'/docs/go',{redirect:'manual'}),missing=await fetch(server.url+'/docs/missing');
      observations.push({count:cookie.value,httpOnly:cookie.httpOnly,sameSite:cookie.sameSite,path:cookie.path,requestContext,params:await page.getByTestId('params').textContent(),title:await page.title(),counter:await page.getByRole('button',{name:'counter 1',exact:true}).textContent(),documents,redirect:{status:redirect.status,location:redirect.headers.get('location')},missing:{status:missing.status,heading:(await missing.text()).includes('Oracle missing')},errors});
      await context.close();
    }
    assert.deepEqual(observations[1],observations[0]);
    assert.equal(observations[1].count,'4');assert.equal(observations[1].documents,1);assert.deepEqual(observations[1].errors,[]);
  }finally{await browser?.close();await candidate?.close();await next?.close();await fixture.remove();}
});
