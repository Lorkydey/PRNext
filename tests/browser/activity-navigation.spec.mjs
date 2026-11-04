import { test, expect } from '@playwright/test';
import { appFixture, repositoryRoot, startServer } from '../support.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { setupPrefetchNetwork } from './prefetch-network.mjs';

let fixture, server;
test.beforeAll(async () => {
  fixture = await appFixture();
  for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), { force: true, recursive: true });
  const files = {
    'prnext.config.mjs': `export default{cacheComponents:true,navigationCache:{authCookies:['tenant']}}`,
    'app/layout.jsx': `import Shell from './shell';export default({children})=><html><body><Shell/>{children}</body></html>`,
    'app/shell.jsx': `'use client';import Link from 'next/link';import{useRouter}from'next/navigation';import{useEffect,useState}from'react';import{logout,loginB,loginBRedirect}from'./session-actions';export default function Shell(){const router=useRouter(),[n,set]=useState(0),[session,setSession]=useState('');useEffect(()=>{window.__activityReady=true;window.__activityRouter=router;window.__sessionActions={logout,loginB,loginBRedirect}},[router]);return <header><input aria-label="Layout draft"/><button onClick={()=>set(n+1)}>Layout {n}</button>{['a','b','c','d','e','f','g'].map(id=><Link key={id} prefetch={false} href={'/'+id}>{id}</Link>)}<button onClick={()=>router.refresh()}>Refresh</button><button onClick={async()=>{await logout();setSession('signed out')}}>Log out</button><button onClick={async()=>{await loginB();setSession('account B signed in')}}>Sign in account B</button><output data-testid="session-action-status">{session}</output></header>}`,
    'app/session-actions.js': `'use server';import{cookies}from'next/headers';import{redirect}from'next/navigation';async function bump(){const jar=await cookies();jar.set('session-mutations',String(Number(jar.get('session-mutations')?.value||0)+1),{httpOnly:true,path:'/',sameSite:'lax'});return jar}export async function logout(){(await bump()).delete('tenant')}export async function loginB(){(await bump()).set('tenant','account-b',{httpOnly:true,path:'/',sameSite:'lax'})}export async function loginBRedirect(){await loginB();redirect('/private')}`,
    'app/editor.jsx': `'use client';import{useEffect,useState}from'react';import{usePathname}from'next/navigation';export default function Editor({id}){const[n,set]=useState(0);const pathname=usePathname();useEffect(()=>{window.__effects??={};window.__effects[id]=(window.__effects[id]||0)+1;return()=>window.__effects[id]--},[id]);return <main><h1>Page {id}</h1><input aria-label={'Draft '+id}/><button onClick={()=>set(n+1)}>Count {id} {n}</button><p>{pathname}</p><div style={{height:1800}}/><h2 id="end">End {id}</h2></main>}`,
    'app/private/page.jsx': `import{cookies}from'next/headers';import Editor from'../editor';export const dynamic='force-dynamic';export default async()=> <><p>{(await cookies()).get('tenant')?.value||'guest'}</p><Editor id="private"/></>`,
    'app/ppr-private/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';import Editor from'../editor';async function Content(){const tenant=(await cookies()).get('tenant')?.value||'guest';return <><p>{tenant}</p><Editor id="ppr"/></>}export default()=> <Suspense fallback={<p>Loading tenant</p>}><Content/></Suspense>`,
    'app/ppr-shell/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';import Editor from'../editor';async function Session(){return <p data-testid="shell-session">{(await cookies()).get('tenant')?.value||'guest'}</p>}export default()=> <><h1>Private shell</h1><Editor id="shell"/><Suspense fallback={<p>Loading shell tenant</p>}><Session/></Suspense></>`,
  };
  // These retention cases deliberately receive a live identity. Separate
  // wholly static pages below exercise strict unknown-identity isolation.
  for (const id of ['a','b','c','d','e','f','g']) files[`app/${id}/page.jsx`] = `import{Suspense}from'react';import{cookies}from'next/headers';import Editor from '../editor';async function Content(){await cookies();return <Editor id="${id}"/>}export default()=> <Suspense fallback={<p>Loading identity</p>}><Content/></Suspense>`;
  for (const id of ['static-a','static-b']) files[`app/${id}/page.jsx`] = `import Editor from '../editor';export default()=> <Editor id="${id}"/>`;
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
  await page.getByRole('textbox', { name: 'Layout draft' }).fill('PRIVATE_ACCOUNT_A_LAYOUT_DRAFT');
  await visit(page, 'a');
  await context.addCookies([{ name: 'tenant', value: 'two', url: server.url }]);
  await page.evaluate(() => window.__activityRouter.push('/private'));
  await expect(page.getByRole('heading', { name: 'Page private' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft private' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Layout draft' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Draft private' }).fill('Same URL, different user');
  await context.addCookies([{ name: 'tenant', value: 'three', url: server.url }]);
  await page.evaluate(() => window.__activityRouter.refresh());
  await expect(page.getByText('three', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Draft private' })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Draft private' }).fill('Drop on custom auth');
  await page.getByRole('textbox', { name: 'Layout draft' }).fill('DROP_LAYOUT_ON_EXPLICIT_AUTH_INVALIDATION');
  await visit(page, 'a');
  await page.evaluate(() => { window.__beforeAuthInvalidation = true; });
  await page.evaluate(() => window.dispatchEvent(new Event('prnext:invalidate-navigation')));
  await expect.poll(() => page.evaluate(() => window.__beforeAuthInvalidation === undefined)).toBe(true);
  await page.waitForFunction(() => window.__activityReady);
  await page.evaluate(() => window.__activityRouter.push('/private'));
  await expect(page.getByRole('textbox', { name: 'Draft private' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Layout draft' })).toHaveValue('');
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

for (const retained of [false, true]) test(`account A -> logout -> account B isolates the whole ${retained ? 'inactive' : 'active'} private document without replaying mutations`, async ({ page, context }) => {
  const errors=[],posts=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')posts.push(request);});
  await context.addCookies([{ name:'tenant', value:'account-a', url:server.url, httpOnly:true }]);
  await page.goto(server.url+'/private');await page.waitForFunction(()=>window.__activityReady);
  await expect(page.getByText('account-a',{exact:true})).toBeVisible();
  await page.evaluate(()=>{window.__accountTestDocument=true;});
  await page.getByRole('textbox',{name:'Draft private'}).fill('ACCOUNT_A_PRIVATE_DRAFT');
  await page.getByRole('textbox',{name:'Layout draft'}).fill('ACCOUNT_A_LAYOUT_DRAFT');
  await page.getByRole('button',{name:'Count private 0',exact:true}).click();
  if(retained)await visit(page,'a');
  await page.getByRole('button',{name:'Log out',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__accountTestDocument===undefined)).toBe(true);
  await page.waitForFunction(()=>window.__activityReady);
  expect((await context.cookies(server.url)).some(cookie=>cookie.name==='tenant')).toBe(false);
  expect((await context.cookies(server.url)).find(cookie=>cookie.name==='session-mutations')?.value).toBe('1');
  if(retained)await page.evaluate(()=>window.__activityRouter.push('/private'));
  await expect(page.getByText('guest',{exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Draft private'})).toHaveValue('');
  await expect(page.getByRole('textbox',{name:'Layout draft'})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Count private 0',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Draft private'}).fill('GUEST_PRIVATE_DRAFT');
  await page.getByRole('textbox',{name:'Layout draft'}).fill('GUEST_LAYOUT_DRAFT');
  if(retained)await visit(page,'a');
  await page.evaluate(()=>{window.__guestDocument=true;});
  await page.getByRole('button',{name:'Sign in account B',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__guestDocument===undefined)).toBe(true);
  await page.waitForFunction(()=>window.__activityReady);
  if(retained)await page.evaluate(()=>window.__activityRouter.push('/private'));
  await expect(page.getByText('account-b',{exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Draft private'})).toHaveValue('');
  await expect(page.getByRole('textbox',{name:'Layout draft'})).toHaveValue('');
  for(const secret of ['ACCOUNT_A_PRIVATE_DRAFT','ACCOUNT_A_LAYOUT_DRAFT','GUEST_PRIVATE_DRAFT','GUEST_LAYOUT_DRAFT'])expect(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).not.toContain(secret);
  expect((await context.cookies(server.url)).find(cookie=>cookie.name==='session-mutations')?.value).toBe('2');
  expect(posts).toHaveLength(2);expect(errors).toEqual([]);
});

test('a full private prefetch cannot authorize a later navigation with changed HttpOnly cookies', async ({ page, context }) => {
  await setupPrefetchNetwork(page);
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

test('an account-changing action completes once and blocks later mutations while its document GET is pending', async ({ page, context }) => {
  await context.addCookies([{name:'tenant',value:'account-a',url:server.url,httpOnly:true}]);
  await page.goto(server.url+'/private');await page.waitForFunction(()=>window.__activityReady);
  await page.getByRole('textbox',{name:'Layout draft'}).fill('PRIVATE_ACTION_LAYOUT_DRAFT');
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request);});
  const oldWindow=await page.evaluateHandle(()=>window);
  // Hold only the already scheduled replacement task, before the browser
  // freezes evaluations in its old realm during a pending document request.
  await page.evaluate(()=>{const original=window.setTimeout;window.setTimeout=function(callback,delay,...args){if(delay===0&&document.documentElement.style.visibility==='hidden'){window.setTimeout=original;const id=original(()=>{},60000);window.__releaseDocumentRequest=()=>{clearTimeout(id);original(callback,0,...args);};return id;}return original(callback,delay,...args);};});
  let releaseDocument,documentPending=false;
  const gate=new Promise(resolve=>{releaseDocument=resolve;});
  await page.route('**/private',async route=>{if(route.request().isNavigationRequest()){documentPending=true;await gate;}await route.continue();});
  try{
    await page.evaluate(()=>{window.__firstAction=window.__sessionActions.loginB().then(result=>({ok:true,voidResult:result===undefined}),error=>({ok:false,message:error.message}));});
    await page.waitForFunction(()=>window.__releaseDocumentRequest);
    expect(await oldWindow.evaluate(window=>window.__firstAction)).toEqual({ok:true,voidResult:true});
    expect(await oldWindow.evaluate(window=>window.getComputedStyle(window.document.documentElement).visibility)).toBe('hidden');
    const rejected=await oldWindow.evaluate(async window=>Promise.all([window.__sessionActions.logout(),window.__sessionActions.loginB()].map(promise=>promise.then(()=>({ok:true}),error=>({ok:false,message:error.message})))));
    expect(rejected).toHaveLength(2);for(const result of rejected){expect(result.ok).toBe(false);expect(result.message).toContain('session changed');}
    await oldWindow.evaluate(window=>{window.__activityRouter.push('/a');window.__activityRouter.refresh();});
    expect(posts).toHaveLength(1);
    expect((await context.cookies(server.url)).find(cookie=>cookie.name==='session-mutations')?.value).toBe('1');
    await oldWindow.evaluate(window=>window.__releaseDocumentRequest());
    await expect.poll(()=>documentPending).toBe(true);
    releaseDocument();
    await expect(page.getByText('account-b',{exact:true})).toBeVisible();
    await expect(page.getByRole('textbox',{name:'Layout draft'})).toHaveValue('');
    await page.waitForFunction(()=>window.__activityReady);
    await page.getByRole('button',{name:'Sign in account B',exact:true}).click();
    await expect.poll(async()=>(await context.cookies(server.url)).find(cookie=>cookie.name==='session-mutations')?.value).toBe('2');
    expect(posts).toHaveLength(2);
  }finally{releaseDocument();await oldWindow.dispose();}
});

for(const newerNavigation of [false,true]) test(`an account-changing action fences an already queued mutation${newerNavigation?' without stealing the newer destination':''}`,async({page,context})=>{
  await context.addCookies([{name:'tenant',value:'account-a',url:server.url,httpOnly:true}]);
  await page.goto(server.url+'/private');await page.waitForFunction(()=>window.__activityReady);
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request);});
  await page.evaluate(()=>{const original=window.setTimeout;window.setTimeout=function(callback,delay,...args){if(delay===0&&document.documentElement.style.visibility==='hidden'){window.setTimeout=original;const id=original(()=>{},60000);window.__releaseDocumentRequest=()=>{clearTimeout(id);original(callback,0,...args);};return id;}return original(callback,delay,...args);};});
  let releaseResponse,releaseNavigation,responseHeld=false,navigationHeld=false,postCount=0;
  const responseGate=new Promise(resolve=>{releaseResponse=resolve;}),navigationGate=new Promise(resolve=>{releaseNavigation=resolve;});
  await page.route('**/private',async route=>{
    if(route.request().method()==='POST'&&postCount++===0){const response=await route.fetch();responseHeld=true;await responseGate;await route.fulfill({response});}
    else await route.continue();
  });
  if(newerNavigation)await page.route('**/b',async route=>{if(!route.request().isNavigationRequest()){navigationHeld=true;await navigationGate;}await route.continue();});
  try{
    await page.evaluate(()=>{const settle=promise=>promise.then(()=>({ok:true}),error=>({ok:false,message:error.message}));window.__queuedOutcomes=Promise.all([settle(window.__sessionActions.loginB()),settle(window.__sessionActions.logout())]);});
    await expect.poll(()=>responseHeld).toBe(true);expect(posts).toHaveLength(1);
    if(newerNavigation){await page.evaluate(()=>window.__activityRouter.push('/b'));await expect.poll(()=>navigationHeld).toBe(true);}
    releaseResponse();await page.waitForFunction(()=>window.__releaseDocumentRequest);
    const outcomes=await page.evaluate(()=>window.__queuedOutcomes);
    expect(outcomes[0]).toEqual({ok:true});expect(outcomes[1].ok).toBe(false);expect(outcomes[1].message).toContain('session changed');
    expect(posts).toHaveLength(1);expect((await context.cookies(server.url)).find(cookie=>cookie.name==='session-mutations')?.value).toBe('1');
    await page.evaluate(()=>window.__releaseDocumentRequest());releaseNavigation();
    await expect(page).toHaveURL(server.url+(newerNavigation?'/b':'/private'));
    await expect(page.getByRole('heading',{name:newerNavigation?'Page b':'Page private',exact:true})).toBeVisible();
    expect((await context.cookies(server.url)).find(cookie=>cookie.name==='tenant')?.value).toBe('account-b');
    expect(posts).toHaveLength(1);
  }finally{releaseResponse();releaseNavigation();}
});

test('an account-changing redirect action executes once and reauthorizes its redirect destination',async({page,context})=>{
  await context.addCookies([{name:'tenant',value:'account-a',url:server.url,httpOnly:true}]);
  await ready(page);await page.getByRole('textbox',{name:'Layout draft'}).fill('PRIVATE_REDIRECT_LAYOUT_DRAFT');
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request);});
  await page.evaluate(()=>{window.__redirectOutcome=window.__sessionActions.loginBRedirect();});
  await expect(page).toHaveURL(server.url+'/private');
  await expect(page.getByText('account-b',{exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Layout draft'})).toHaveValue('');
  expect(posts).toHaveLength(1);expect((await context.cookies(server.url)).find(cookie=>cookie.name==='session-mutations')?.value).toBe('1');
});

test('a restored strict document stays hidden until a GET reauthorizes its shared layout', async ({ page, context }) => {
  await context.addCookies([{name:'tenant',value:'account-a',url:server.url,httpOnly:true}]);
  await page.goto(server.url+'/private');await page.waitForFunction(()=>window.__activityReady);
  await page.getByRole('textbox',{name:'Layout draft'}).fill('PRIVATE_BFCACHE_LAYOUT_DRAFT');
  const oldWindow=await page.evaluateHandle(()=>window);
  let releaseDocument,documents=0;
  const gate=new Promise(resolve=>{releaseDocument=resolve;});
  await page.route('**/private',async route=>{if(route.request().isNavigationRequest()){documents++;await gate;}await route.continue();});
  try{
    await oldWindow.evaluate(window=>window.dispatchEvent(new window.PageTransitionEvent('pagehide',{persisted:true})));
    expect(documents).toBe(0);
    expect(await oldWindow.evaluate(window=>window.getComputedStyle(window.document.documentElement).visibility)).toBe('hidden');
    await context.addCookies([{name:'tenant',value:'account-b',url:server.url,httpOnly:true}]);
    await oldWindow.evaluate(window=>window.dispatchEvent(new window.PageTransitionEvent('pageshow',{persisted:true})));
    await expect.poll(()=>documents).toBe(1);
    releaseDocument();
    await expect(page.getByText('account-b',{exact:true})).toBeVisible();
    await expect(page.getByRole('textbox',{name:'Layout draft'})).toHaveValue('');
    expect(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).not.toContain('PRIVATE_BFCACHE_LAYOUT_DRAFT');
  }finally{releaseDocument();await oldWindow.dispose();}
});

for (const changedAccount of [false,true]) test(`strict static pages discard unidentified drafts when ${changedAccount?'the HttpOnly account changes':'the same account returns'}`,async({page,context})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.addCookies([{name:'tenant',value:'static-account-a',url:server.url,httpOnly:true}]);
  await page.goto(server.url+'/static-a');await page.waitForFunction(()=>window.__activityReady);
  await page.evaluate(()=>{window.__strictStaticDocument=true;});
  await page.getByRole('textbox',{name:'Draft static-a'}).fill('PRIVATE_UNIDENTIFIED_ACCOUNT_A_DRAFT');await page.getByRole('textbox',{name:'Layout draft'}).fill('PRIVATE_UNIDENTIFIED_LAYOUT_DRAFT');
  await page.evaluate(()=>window.__activityRouter.push('/static-b'));
  await expect(page.getByRole('heading',{name:'Page static-b',exact:true})).toBeVisible();
  if(changedAccount)await context.addCookies([{name:'tenant',value:'static-account-b',url:server.url,httpOnly:true}]);
  await page.evaluate(()=>window.__activityRouter.push('/static-a'));
  await expect(page.getByRole('textbox',{name:'Draft static-a'})).toHaveValue('');
  expect(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).not.toContain('PRIVATE_UNIDENTIFIED_ACCOUNT_A_DRAFT');expect(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).not.toContain('PRIVATE_UNIDENTIFIED_LAYOUT_DRAFT');
  expect(await page.evaluate(()=>window.__strictStaticDocument)).toBeUndefined();await expect(page.getByRole('textbox',{name:'Layout draft'})).toHaveValue('');expect(errors).toEqual([]);
});

for (const changedAccount of [false, true]) test(`strict PPR navigation defers its cached shell and ${changedAccount ? 'discards another account draft' : 'preserves the same account draft'}`, async ({ page, context }) => {
  await setupPrefetchNetwork(page);
  await context.addCookies([{ name: 'tenant', value: 'shell-account-a', url: server.url, httpOnly: true }]);
  await page.goto(server.url+'/ppr-shell');await page.waitForFunction(()=>window.__activityReady);
  await page.getByRole('textbox',{name:'Draft shell'}).fill('PRIVATE_ACCOUNT_A_SHELL_DRAFT');
  await visit(page,'a');
  await page.evaluate(()=>{
    const original=window.fetch;
    window.__shellPrefetch=new Promise((resolve,reject)=>{
      window.fetch=async function(input,init){
        const response=await original.call(this,input,init),headers=new Headers(init?.headers);
        if(new URL(typeof input==='string'?input:input.url,location.href).pathname!=='/ppr-shell')return response;
        if(headers.get('x-prnext-prefetch')==='1'){void response.clone().json().then(resolve,reject);return response;}
        if(headers.get('rsc')!=='1')return response;
        const reader=response.body.getReader(),gate=new Promise(resolveGate=>{window.__releaseShellFlight=resolveGate;});
        window.__shellHeadersArrived=true;
        const body=new ReadableStream({async pull(controller){await gate;const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value);},cancel(reason){window.__releaseShellFlight();return reader.cancel(reason);}},{highWaterMark:0});
        const getReader=body.getReader.bind(body);body.getReader=(...args)=>{window.__shellLiveReaderStarted=true;return getReader(...args);};
        return new Response(body,{status:response.status,headers:response.headers});
      };
    });
  });
  await page.evaluate(()=>window.__activityRouter.prefetch('/ppr-shell'));
  expect((await page.evaluate(()=>window.__shellPrefetch)).flight).toBeTruthy();
  const tenant=changedAccount?'shell-account-b':'shell-account-a';
  await context.addCookies([{ name: 'tenant', value: tenant, url: server.url, httpOnly: true }]);
  try{
    await page.evaluate(()=>window.__activityRouter.push('/ppr-shell'));
    // Acquiring the live reader occurs after the preview callback has returned.
    // Allow its queued React transition to paint while all live rows stay held.
    await page.waitForFunction(()=>window.__shellHeadersArrived&&window.__shellLiveReaderStarted);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.getByRole('heading',{name:'Page a',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Private shell',exact:true})).toHaveCount(0);
    await expect(page.getByRole('textbox',{name:'Draft shell'})).toHaveCount(0);
  }finally{await page.evaluate(()=>window.__releaseShellFlight?.()).catch(()=>{});}
  await expect(page.getByTestId('shell-session').filter({visible:true})).toHaveText(tenant);
  await expect(page.getByRole('textbox',{name:'Draft shell'})).toHaveValue(changedAccount?'':'PRIVATE_ACCOUNT_A_SHELL_DRAFT');
  if(changedAccount)expect(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).not.toContain('PRIVATE_ACCOUNT_A_SHELL_DRAFT');
});
