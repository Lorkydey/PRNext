import { test, expect } from '@playwright/test';
import { appFixture, repositoryRoot, startServer } from '../support.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

let fixture, server;
test.beforeAll(async () => {
  fixture = await appFixture();
  for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), { force: true, recursive: true });
  const files = {
    'prnext.config.mjs': `export default{cacheComponents:true,navigationCache:{authCookies:['tenant']}}`,
    'app/layout.jsx': `import Shell from './shell';export default({children})=><html><body><Shell/>{children}</body></html>`,
    'app/shell.jsx': `'use client';import Link from 'next/link';import{useRouter}from'next/navigation';import{useEffect,useState}from'react';export default function Shell(){const router=useRouter(),[n,set]=useState(0);useEffect(()=>{window.__activityReady=true;window.__activityRouter=router},[router]);return <header><button onClick={()=>set(n+1)}>Layout {n}</button>{['a','b','c','d','e','f','g'].map(id=><Link key={id} prefetch={false} href={'/'+id}>{id}</Link>)}<button onClick={()=>router.refresh()}>Refresh</button></header>}`,
    'app/editor.jsx': `'use client';import{useEffect,useState}from'react';import{usePathname}from'next/navigation';export default function Editor({id}){const[n,set]=useState(0);const pathname=usePathname();useEffect(()=>{window.__effects??={};window.__effects[id]=(window.__effects[id]||0)+1;return()=>window.__effects[id]--},[id]);return <main><h1>Page {id}</h1><input aria-label={'Draft '+id}/><button onClick={()=>set(n+1)}>Count {id} {n}</button><p>{pathname}</p><div style={{height:1800}}/><h2 id="end">End {id}</h2></main>}`,
    'app/private/page.jsx': `import{cookies}from'next/headers';import Editor from'../editor';export const dynamic='force-dynamic';export default async()=> <><p>{(await cookies()).get('tenant')?.value||'guest'}</p><Editor id="private"/></>`,
    'app/ppr-private/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';import Editor from'../editor';async function Content(){const tenant=(await cookies()).get('tenant')?.value||'guest';return <><p>{tenant}</p><Editor id="ppr"/></>}export default()=> <Suspense fallback={<p>Loading tenant</p>}><Content/></Suspense>`,
  };
  for (const id of ['a','b','c','d','e','f','g']) files[`app/${id}/page.jsx`] = `import Editor from '../editor';export default()=> <Editor id="${id}"/>`;
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source);
  }
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 8 * 1024 * 1024 });
  server = await startServer(fixture.root);
});
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });
async function ready(page) { await page.goto(server.url + '/a'); await page.waitForFunction(() => window.__activityReady); }
async function visit(page, id) { await page.getByRole('link', { name: id, exact: true }).click(); await expect(page.getByRole('heading', { name: 'Page ' + id })).toBeVisible(); }

test('return navigation retains drafts and page state, pauses hidden effects and preserves shared layout state', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page); await page.getByRole('button', { name: 'Layout 0' }).click();
  await page.getByRole('textbox', { name: 'Draft a' }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Count a 0' }).click();
  await visit(page, 'b'); await expect.poll(() => page.evaluate(() => window.__effects.a)).toBe(0);
  await visit(page, 'a');
  await expect(page.getByRole('textbox', { name: 'Draft a' })).toHaveValue('Keep this draft');
  await expect(page.getByRole('button', { name: 'Count a 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout 1' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__effects.b)).toBe(0);
  expect(errors).toEqual([]);
});

test('refresh purges inactive pages and the shared retention limit evicts old drafts', async ({ page }) => {
  await ready(page); await page.getByRole('textbox', { name: 'Draft a' }).fill('Old');
  await visit(page, 'b'); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForTimeout(200); await visit(page, 'a');
  await expect(page.getByRole('textbox', { name: 'Draft a' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Draft a' }).fill('Evict me');
  for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) await visit(page, id);
  await visit(page, 'a'); await expect(page.getByRole('textbox', { name: 'Draft a' })).toHaveValue('');
});

test('history reauthorizes its destination and restores focus and scroll on retained DOM', async ({ page }) => {
  await ready(page);
  await page.getByRole('textbox', { name: 'Draft a' }).focus();
  await page.evaluate(() => { window.scrollTo(0, 500); window.__activityRouter.push('/b'); });
  await expect(page.getByRole('heading', { name: 'Page b' })).toBeVisible();
  const requests = []; page.on('request', request => { if (request.headers().rsc === '1' && new URL(request.url()).pathname === '/a') requests.push(request); });
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Page a' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft a' })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
  expect(requests.length).toBeGreaterThan(0);
});

test('observed authentication changes and explicit integration invalidation discard inactive drafts', async ({ page, context }) => {
  await context.addCookies([{ name: 'tenant', value: 'one', url: server.url }]);
  await page.goto(server.url + '/private'); await page.waitForFunction(() => window.__activityReady);
  await page.getByRole('textbox', { name: 'Draft private' }).fill('Private draft');
  await visit(page, 'a');
  await context.addCookies([{ name: 'tenant', value: 'two', url: server.url }]);
  await page.evaluate(() => window.__activityRouter.push('/private'));
  await expect(page.getByRole('heading', { name: 'Page private' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft private' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Draft private' }).fill('Same URL, different user');
  await context.addCookies([{ name: 'tenant', value: 'three', url: server.url }]);
  await page.evaluate(() => window.__activityRouter.refresh());
  await expect(page.getByText('three', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft private' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Draft private' }).fill('Drop on custom auth');
  await visit(page, 'a');
  await page.evaluate(() => window.dispatchEvent(new Event('prnext:invalidate-navigation')));
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__activityRouter.push('/private'));
  await expect(page.getByRole('textbox', { name: 'Draft private' })).toHaveValue('');
});

test('resumed PPR checks the live session identity before restoring a client draft', async ({ page, context }) => {
  await context.addCookies([{ name: 'tenant', value: 'old-ppr', url: server.url }]);
  await page.goto(server.url + '/ppr-private'); await page.waitForFunction(() => window.__activityReady);
  await page.getByRole('textbox', { name: 'Draft ppr' }).fill('Old session draft');
  await context.addCookies([{ name: 'tenant', value: 'new-ppr', url: server.url }]);
  await page.evaluate(() => window.__activityRouter.refresh());
  await expect(page.getByText('new-ppr', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft ppr' })).toHaveValue('');
});

test('a full private prefetch cannot authorize a later navigation with changed HttpOnly cookies', async ({ page, context }) => {
  await context.addCookies([{ name: 'tenant', value: 'prefetched-user', url: server.url, httpOnly: true }]);
  await ready(page);
  // Observe the actual browser-consumed bytes rather than a protocol-level
  // response-finished notification, and prove the old private data was fetched.
  await page.evaluate(() => {
    const original=window.fetch;
    window.__privatePrefetch=new Promise((resolve,reject)=>{
      window.fetch=async function(input,init){
        const response=await original.call(this,input,init);
        if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/private'&&new Headers(init?.headers).get('rsc')==='1'){
          window.fetch=original;
          void response.clone().text().then(text=>resolve({text,status:response.status}),reject);
        }
        return response;
      };
    });
  });
  await page.evaluate(() => window.__activityRouter.prefetch('/private', { full: true }));
  const prefetched=await page.evaluate(()=>window.__privatePrefetch);
  expect(prefetched.status).toBe(200);expect(prefetched.text).toContain('prefetched-user');
  await context.addCookies([{ name: 'tenant', value: 'current-user', url: server.url, httpOnly: true }]);
  await page.evaluate(() => window.__activityRouter.push('/private'));
  await expect(page.getByText('current-user', { exact: true })).toBeVisible();
  await expect(page.getByText('prefetched-user', { exact: true })).toHaveCount(0);
});
