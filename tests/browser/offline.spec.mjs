import {test,expect} from '@playwright/test';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {appFixture,startServer,repositoryRoot} from '../support.mjs';

let fixture,server;
test.beforeAll(async()=>{
  fixture=await appFixture();
  await rm(path.join(fixture.root,'app'),{recursive:true});
  const files={
    'app/layout.jsx':`import Client from './offline-client';export default function Layout({children}){return <html><body><Client/>{children}</body></html>}`,
    'app/page.jsx':`export default function Home(){return <h1>Offline home</h1>}`,
    'app/offline-client.jsx':`'use client';import{useState}from'react';import Link from'next/link';import{useOffline}from'next/offline';import{save}from'./offline-action';export default function Client(){const[text,setText]=useState(''),[status,setStatus]=useState('ready'),offline=useOffline();return <section><input aria-label='Draft' value={text} onChange={event=>setText(event.target.value)}/><p data-testid='connection'>{offline?'offline':'online'}</p><Link prefetch={false} href='/offline-a'>Page A</Link><Link prefetch={false} href='/offline-b'>Page B</Link><button onClick={async()=>{try{await save();setStatus('saved')}catch{setStatus('unconfirmed')}}}>Save once</button><output data-testid='save-status'>{status}</output></section>}`,
    'app/offline-action.js':`'use server';import{appendFile}from'node:fs/promises';export async function save(){await appendFile('offline-mutations','x');return 'saved'}`,
    'app/offline-a/page.jsx':`import{cookies}from'next/headers';export const dynamic='force-dynamic';export default async function Page(){return <main><h1>Offline A</h1><p data-testid='visitor'>{(await cookies()).get('visitor')?.value||'none'}</p></main>}`,
    'app/offline-b/page.jsx':`export const dynamic='force-dynamic';export default function Page(){return <h1>Offline B</h1>}`,
  };
  for(const[name,source]of Object.entries(files)){const target=path.join(fixture.root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,source);}
  await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root],{maxBuffer:8*1024*1024});server=await startServer(fixture.root,['--workers','1']);
});
test.afterAll(async()=>{await server?.close();await fixture?.remove();});

async function prepare(page){
  await page.goto(server.url);await expect(page.getByRole('heading',{name:'Offline home'})).toBeVisible();await page.getByLabel('Draft').fill('Keep this draft');await page.evaluate(()=>window.__offlineDocument='preserved');
}
test('a real connection loss preserves drafts and refetches current visitor data on reconnect',async({page,context})=>{
  await context.addCookies([{name:'visitor',value:'before',url:server.url}]);await prepare(page);
  await context.setOffline(true);await page.getByRole('link',{name:'Page A',exact:true}).click();await expect(page.getByTestId('connection')).toHaveText('offline');await expect(page.getByLabel('Draft')).toHaveValue('Keep this draft');
  await context.addCookies([{name:'visitor',value:'after',url:server.url}]);await context.setOffline(false);
  await expect(page.getByRole('heading',{name:'Offline A',exact:true})).toBeVisible();await expect(page.getByTestId('visitor')).toHaveText('after');await expect(page.getByLabel('Draft')).toHaveValue('Keep this draft');expect(await page.evaluate(()=>window.__offlineDocument)).toBe('preserved');await expect(page.getByTestId('connection')).toHaveText('online');
});
test('a newer navigation cancels an offline destination and only the newest page commits',async({page,context})=>{
  await prepare(page);await context.setOffline(true);await page.getByRole('link',{name:'Page A',exact:true}).click();await page.getByRole('link',{name:'Page B',exact:true}).click();await context.setOffline(false);
  await expect(page.getByRole('heading',{name:'Offline B',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Offline A',exact:true})).toHaveCount(0);await expect(page.getByLabel('Draft')).toHaveValue('Keep this draft');expect(await page.evaluate(()=>window.__offlineDocument)).toBe('preserved');
});
test('a transient failed Flight GET retries without a document reload',async({page})=>{
  await prepare(page);let attempts=0;
  await page.route('**/offline-a',route=>{if(route.request().headers().rsc==='1'&&++attempts===1)return route.abort('failed');return route.continue();});
  await page.getByRole('link',{name:'Page A',exact:true}).click();await expect(page.getByRole('heading',{name:'Offline A',exact:true})).toBeVisible();expect(attempts).toBe(2);expect(await page.evaluate(()=>window.__offlineDocument)).toBe('preserved');
});
test('a Server Action whose acknowledgement is lost is never replayed automatically',async({page})=>{
  await prepare(page);const before=await readFile(path.join(fixture.root,'offline-mutations'),'utf8').catch(()=>'');let posts=0;
  await page.route('**/*',async route=>{if(route.request().headers()['next-action']){posts++;await route.fetch();return route.abort('failed');}return route.continue();});
  await page.getByRole('button',{name:'Save once',exact:true}).click();await expect(page.getByTestId('save-status')).toHaveText('unconfirmed');await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(500);
  expect(posts).toBe(1);expect(await readFile(path.join(fixture.root,'offline-mutations'),'utf8')).toBe(before+'x');await expect(page.getByLabel('Draft')).toHaveValue('Keep this draft');
});
