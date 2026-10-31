import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot, startServer } from '../support.mjs';

test('hydration, retained layout, bound action, CSS, history and streamed fetch work together', async ({ page }) => {
  const fixture = await appFixture();
  let server;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const name of ['app', 'pages', 'components', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'next.config.mjs': 'export default {navigationCache:{maxEntries:4,ttlMs:30000}}',
      'app/style.css': 'body{font:18px system-ui}button,input{font:inherit;min-height:44px}.result{color:rgb(12,34,56)}',
      'app/layout.jsx': "import './style.css';import Counter from './counter';export default function Layout({children}){return <html><body><Counter/>{children}</body></html>}",
      'app/counter.jsx': "'use client';import{useState}from'react';export default function Counter(){const[n,set]=useState(0);return <button onClick={()=>set(n+1)}>Layout {n}</button>}",
      'app/actions.js': "'use server';export async function save(id,previous,form){return id+':'+String(form.get('body'))}",
      'app/form.jsx': "'use client';import{useActionState}from'react';import{save}from'./actions';export default function Form(){const[value,action,pending]=useActionState(save.bind(null,'record-42'),'');return <form action={action}><label htmlFor='body'>Record</label><input id='body' name='body'/><button disabled={pending}>Save record</button><output className='result' data-testid='result'>{value}</output></form>}",
      'app/page.jsx': "import Link from'next/link';import Form from'./form';export default function Home(){return <main><h1>Engine contract</h1><Form/><Link href='/next'>Next page</Link></main>}",
      'app/next/page.jsx': "import Link from'next/link';import Stream from'../stream';export default function Next(){return <main><h1>Next page</h1><Stream/><Link href='/'>Home</Link></main>}",
      'app/stream.jsx': "'use client';import{useState}from'react';export default function Stream(){const[value,set]=useState('');return <><button onClick={async()=>{const response=await fetch('/api/stream');const reader=response.body.getReader(),decoder=new TextDecoder();let text='';for(;;){const{done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});set(text)}}}>Read stream</button><output data-testid='stream'>{value}</output></>}",
      'app/api/stream/route.js': "export function GET(){let timer;const encoder=new TextEncoder();return new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode('first\\n'));timer=setTimeout(()=>{controller.enqueue(encoder.encode('last\\n'));controller.close()},100)},cancel(){clearTimeout(timer)}}),{headers:{'content-type':'text/plain','cache-control':'no-store'}})}",
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture.root, name)), { recursive: true });
      await writeFile(path.join(fixture.root, name), content);
    }
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4e6 });
    server = await startServer(fixture.root);
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Engine contract' })).toBeVisible();
    await page.getByRole('button', { name: 'Layout 0', exact: true }).click();
    await page.getByLabel('Record', { exact: true }).fill('browser contract');
    await page.getByRole('button', { name: 'Save record', exact: true }).click();
    await expect(page.getByTestId('result')).toHaveText('record-42:browser contract');
    await expect(page.getByTestId('result')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.getByRole('button', { name: 'Layout 1', exact: true })).toBeVisible();
    await page.evaluate(() => { window.__engineDocument = true; });
    await page.getByRole('link', { name: 'Next page', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Next page', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__engineDocument)).toBe(true);
    await expect(page.getByRole('button', { name: 'Layout 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Read stream', exact: true }).click();
    await expect(page.getByTestId('stream')).toHaveText('first\nlast\n');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Engine contract' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Layout 1', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
