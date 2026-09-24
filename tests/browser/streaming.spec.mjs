import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, startServer, repositoryRoot } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => {
  fixture = await appFixture();
  await rm(path.join(fixture.root,'app'),{recursive:true});
  await mkdir(path.join(fixture.root,'app/slow'),{recursive:true});
  await writeFile(path.join(fixture.root,'app/layout.jsx'), `import {Shell} from './client';
    export default function Layout({children}){return <html><head/><body><Shell/>{children}</body></html>}`);
  await writeFile(path.join(fixture.root,'app/client.jsx'), `'use client';
    import {useState} from 'react';import {useRouter} from 'next/navigation';import Link from 'next/link';
    export function Counter({label}){const [count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{label+' '+count}</button>}
    export function Shell(){const router=useRouter();return <aside><Counter label="Layout"/><Link href="/">Home</Link><button onClick={()=>router.push('/slow'+location.search)}>Stream page</button></aside>}`);
  await writeFile(path.join(fixture.root,'app/page.jsx'), `export default function Page(){return <h1>Streaming home</h1>}`);
  await writeFile(path.join(fixture.root,'app/slow/loading.jsx'), `export default function Loading(){return <p data-testid="loading">Pending server content</p>}`);
  await writeFile(path.join(fixture.root,'app/slow/not-found.jsx'), `export default function NotFound(){return <h1>Late missing page</h1>}`);
  await writeFile(path.join(fixture.root,'app/slow/error.jsx'), `'use client';export default function ErrorPage({error,reset}){return <section data-testid="stream-error"><p>{error.message}</p><button onClick={reset}>Retry</button></section>}`);
  await writeFile(path.join(fixture.root,'app/slow/page.jsx'), `import {existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';import {notFound,redirect} from 'next/navigation';import {Counter} from '../client';
    export default async function Page({searchParams}){const {gate,mode}=await searchParams;while(!existsSync(gate))await delay(5);
      if(mode==='missing')notFound();if(mode==='redirect')redirect('/');if(mode==='error')throw new Error('PRIVATE_LATE_STREAM_ERROR');
      return <main><h1>Stream resolved é🚀</h1><Counter label="Child"/></main>}`);
  await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',fixture.root]);
  server=await startServer(fixture.root);
});
test.afterAll(async()=>{await server?.close();await fixture?.remove();});

function errors(page) {
  const values=[];
  page.on('pageerror',error=>values.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('status of 404'))values.push(message.text());});
  return values;
}
async function release(name) {await writeFile(path.join(fixture.root,name),'ready');}
function url(name,mode='') {return `${server.url}/slow?gate=${encodeURIComponent(path.join(fixture.root,name))}&mode=${mode}`;}

test('the streamed shell hydrates before the suspended server content is ready',async({page})=>{
  const failures=errors(page);
  try {
    const response=await page.goto(url('initial'),{waitUntil:'commit'});
    expect(response.status()).toBe(200);
    await expect(page.getByTestId('loading')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Stream resolved é🚀'})).toHaveCount(0);
    await page.getByRole('button',{name:'Layout 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Layout 1',exact:true})).toBeVisible();
    await page.evaluate(()=>{window.__streamMarker='same document';});
    await release('initial');
    await expect(page.getByRole('heading')).toHaveText('Stream resolved é🚀');
    await expect(page.getByTestId('loading')).toHaveCount(0);
    await page.getByRole('button',{name:'Child 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Child 1',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Layout 1',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>window.__streamMarker)).toBe('same document');
    expect(failures).toEqual([]);
  } finally {await release('initial');}
});

test('Flight navigation reveals loading UI while retaining an interactive layout',async({page})=>{
  const failures=errors(page);
  try {
    await page.goto(`${server.url}/?gate=${encodeURIComponent(path.join(fixture.root,'navigation'))}`);
    await page.getByRole('button',{name:'Layout 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Layout 1',exact:true})).toBeVisible();
    await page.evaluate(()=>{window.__streamMarker='navigation';});
    await page.getByRole('button',{name:'Stream page',exact:true}).click();
    await expect(page.getByTestId('loading')).toBeVisible();
    await page.getByRole('button',{name:'Layout 1',exact:true}).click();
    await expect(page.getByRole('button',{name:'Layout 2',exact:true})).toBeVisible();
    await release('navigation');
    await expect(page.getByRole('heading')).toHaveText('Stream resolved é🚀');
    await expect(page.getByRole('button',{name:'Layout 2',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>window.__streamMarker)).toBe('navigation');
    expect(failures).toEqual([]);
  } finally {await release('navigation');}
});

for(const mode of ['missing','redirect','error']) {
  test(`a ${mode} raised after the shell is sent reaches the correct browser boundary`,async({page})=>{
    const failures=errors(page);
    try {
      const response=await page.goto(url(mode,mode),{waitUntil:'commit'});
      expect(response.status()).toBe(200);
      await expect(page.getByTestId('loading')).toBeVisible();
      await release(mode);
      if(mode==='missing') await expect(page.getByRole('heading')).toHaveText('Late missing page');
      else if(mode==='redirect') {await expect(page).toHaveURL(`${server.url}/`);await expect(page.getByRole('heading')).toHaveText('Streaming home');}
      else {await expect(page.getByTestId('stream-error')).toBeVisible();expect(await page.content()).not.toContain('PRIVATE_LATE_STREAM_ERROR');}
      // React's production code 441 is the deliberately sanitized Server
      // Component error; the application error boundary must still receive it.
      expect(failures.filter(value=>!value.includes('An error occurred')&&!value.includes('NEXT_HTTP_ERROR_FALLBACK')&&!value.includes('NEXT_REDIRECT')&&!(mode==='error'&&value.includes('Minified React error #441;')))).toEqual([]);
    } finally {await release(mode);}
  });
}
