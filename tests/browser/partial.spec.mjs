import { test, expect } from '@playwright/test';
import { partialFixture } from '../partial-fixture.mjs';
import { startServer } from '../support.mjs';

test('partial Map and Set props hydrate and refresh with current visitor data',async({page,context})=>{
  const fixture=await partialFixture();let server;
  const {mkdir,writeFile}=await import('node:fs/promises'), path=await import('node:path');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  try {
    const directory=path.join(fixture.root,'app/collections');await mkdir(directory);
    await writeFile(path.join(directory,'page.jsx'),`import{Suspense}from'react';import{cookies}from'next/headers';import Collections from'./client';async function visitor(){return(await cookies()).get('name')?.value||'guest'}export default function Page(){const value=visitor();return <Suspense fallback={<p>Waiting collections</p>}><Collections map={new Map([['visitor',value],['date',new Date('2020-01-01')]])} set={new Set([value])}/></Suspense>}`);
    await writeFile(path.join(directory,'client.jsx'),`'use client';import{use,useState}from'react';import{useRouter}from'next/navigation';export default function Collections({map,set}){const[n,setN]=useState(0),router=useRouter();return <><p data-testid="collections">{use(map.get('visitor'))+'|'+use([...set][0])+'|'+map.get('date').getUTCFullYear()}</p><button onClick={()=>setN(n+1)}>Count {n}</button><button onClick={()=>router.refresh()}>Refresh</button></>}`);
    await fixture.build();server=await startServer(fixture.root);
    await context.addCookies([{name:'name',value:'Ada',url:server.url}]);
    const response=await page.goto(server.url+'/collections');
    expect(response.headers()['x-prnext-prerender']).toBe('partial');
    await expect(page.getByTestId('collections')).toHaveText('Ada|Ada|2020');
    const shell=await page.getByTestId('shell').textContent();
    await page.getByRole('button',{name:'Count 0',exact:true}).click();
    await context.addCookies([{name:'name',value:'Lin',url:server.url}]);
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await expect(page.getByTestId('collections')).toHaveText('Lin|Lin|2020');
    await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
    await expect(page.getByTestId('shell')).toHaveText(shell);
    expect(errors).toEqual([]);
  }finally{await server?.close();await fixture.remove();}
});

test('a resumed partial document hydrates client islands with the original build shell and per-request data', async ({ page, context }) => {
  const fixture = await partialFixture();
  let server;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await fixture.build();
    server = await startServer(fixture.root);
    await context.addCookies([{ name: 'name', value: 'Browser', url: server.url }]);
    const response = await page.goto(server.url);
    expect(response.headers()['x-prnext-prerender']).toBe('partial');
    await expect(page.getByTestId('personal')).toHaveText('Browser');
    await expect(page.getByTestId('pending')).toHaveCount(0);
    const stamp = await page.getByTestId('shell').textContent();
    await page.getByRole('button', { name: 'Count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rename visitor', exact: true }).click();
    await expect(page.getByTestId('personal')).toHaveText('Action visitor');
    await expect(page.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible();
    await context.addCookies([{ name: 'name', value: 'Browser', url: server.url }]);
    await page.reload();
    await expect(page.getByTestId('personal')).toHaveText('Browser');
    await expect(page.getByTestId('shell')).toHaveText(stamp);
    await page.goto(server.url + '/query?q=browser-query');
    await expect(page.getByTestId('query')).toHaveText('browser-query');
    await page.goto(server.url + '/client-query?q=client-browser');
    await expect(page.getByTestId('client-query')).toHaveText('client-browser');
    await page.goto(server.url + '/metadata');
    await expect(page).toHaveTitle('Hello Browser');
    await expect(page.getByRole('heading', { name: 'Metadata shell' })).toBeVisible();
    await page.goto(server.url + '/mixed');
    await expect(page.getByTestId('private')).toHaveText('Browser');
    await expect(page.getByTestId('connection')).toHaveText('Request connected');
    await expect(page.getByTestId('network')).toHaveText('Network response');
    await page.goto(server.url + '/redirect');
    await expect(page).toHaveURL(server.url + '/query?q=redirected');
    await expect(page.getByTestId('query')).toHaveText('redirected');
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});


test('unlisted params, rewrites and ordinary client navigations hydrate resumable and complete artifacts', async ({ page, context }) => {
  const fixture = await partialFixture();
  let server;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await fixture.build(); server = await startServer(fixture.root);
    await context.addCookies([{ name: 'name', value: 'Visitor', url: server.url }]);
    await page.goto(server.url + '/product/new');
    await expect(page.getByTestId('product')).toHaveText('new');
    await expect(page.getByTestId('product-visitor')).toHaveText('Visitor');
    await page.getByRole('button', { name: 'Count 0', exact: true }).click();
    const flight = page.waitForResponse(response => response.url().includes('/product/other') && response.request().headers().rsc === '1');
    await page.getByRole('link', { name: 'Other product' }).click();
    expect((await flight).headers()['x-prnext-prerender']).toBe('partial');
    await expect(page.getByTestId('product')).toHaveText('other');
    await expect(page.getByRole('button', { name: 'Count 0', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Count 0', exact: true }).click();
    await context.addCookies([{ name: 'name', value: 'Refreshed', url: server.url }]);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('product-visitor')).toHaveCount(1);
    await expect(page.getByTestId('product-visitor')).toHaveText('Refreshed');
    await expect(page.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible();
    await page.goto(server.url + '/visible/new');
    await expect(page.getByTestId('pathname')).toHaveText('/visible/new');
    await expect(page.getByTestId('product')).toHaveText('new');
    await page.getByRole('button', { name: 'Count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible();
    const complete = await page.goto(server.url + '/complete/first');
    expect(complete.headers()['x-prnext-prerender']).toBe('partial');
    await expect(page.getByTestId('complete')).toContainText('first:');
    const text = await page.getByTestId('complete').textContent();
    await page.reload();
    await expect(page.getByTestId('complete')).toHaveText(text);
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});

test('partial Link prefetch keeps private data fresh and authenticates before committing prefetched UI', async ({ page, context }) => {
  const fixture = await partialFixture();
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  let server;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await mkdir(path.join(fixture.root, 'app/prefetch'), { recursive: true });
    await writeFile(path.join(fixture.root, 'app/prefetch/page.jsx'), `'use client';import Link from'next/link';import{useRouter}from'next/navigation';export default function Page(){const router=useRouter();return <><Link href="/product/first">First product</Link><button onClick={()=>router.prefetch('/product/second')}>Prefetch second</button><button onClick={()=>router.push('/product/second')}>Open second</button><Link prefetch={false} href="/mixed">No speculative network</Link></>}`);
    const file = path.join(fixture.root, 'app/product/[id]/page.jsx');
    await writeFile(file, (await readFile(file, 'utf8')).replace("import{cookies}from'next/headers'", "import{cookies,headers}from'next/headers'").replace('async function Visitor(){', "async function Visitor(){const delay=(await headers()).get('x-test-delay');if(delay)await new Promise(r=>setTimeout(r,Number(delay)));"));
    await writeFile(path.join(fixture.root, 'proxy.js'), `import{NextResponse}from'next/server';export function proxy(req){if(req.nextUrl.pathname.startsWith('/product/')&&req.cookies.get('deny')?.value==='yes')return NextResponse.redirect(new URL('/query?q=denied',req.url));return NextResponse.next()}`);
    await fixture.build(); server = await startServer(fixture.root);
    await context.addCookies([{ name: 'name', value: 'OldPrivate', url: server.url }]);
    const firstFetch = page.waitForResponse(r => r.url().endsWith('/product/first') && r.request().headers()['x-prnext-prefetch'] === '1');
    await page.goto(server.url + '/prefetch');
    await page.getByRole('link', { name: 'First product' }).hover();
    const first = await (await firstFetch).json();
    expect(first.flight).toBeTruthy(); expect(fixture.fetches()).toBe(0);
    const secondFetch = page.waitForResponse(r => r.url().endsWith('/product/second') && r.request().headers()['x-prnext-prefetch'] === '1');
    await page.getByRole('button', { name: 'Prefetch second' }).click();
    const second = await (await secondFetch).json();
    expect(second.id).toBe(first.id); expect(second.flight).toBeUndefined();
    await context.addCookies([{ name: 'name', value: 'CurrentPrivate', url: server.url }]);
    await context.setExtraHTTPHeaders({ 'x-test-delay': '1200' });
    await page.getByRole('button', { name: 'Open second' }).click();
    await expect(page).toHaveURL(server.url + '/product/second');
    await expect(page.getByRole('heading', { name: 'Product shell' })).toBeVisible();
    await expect(page.getByText('Waiting visitor', { exact: true })).toBeVisible();
    await expect(page.getByTestId('product-visitor')).toHaveText('CurrentPrivate');
    await expect(page.getByTestId('product')).toHaveText('second');
    await page.getByRole('button', { name: 'Count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible();
    await context.setExtraHTTPHeaders({});
    const nextFetch = page.waitForResponse(r => r.url().endsWith('/product/first') && r.request().headers()['x-prnext-prefetch'] === '1');
    await page.goto(server.url + '/prefetch'); await nextFetch;
    await context.addCookies([{ name: 'deny', value: 'yes', url: server.url }]);
    await page.getByRole('link', { name: 'First product' }).click();
    await expect(page).toHaveURL(server.url + '/query?q=denied');
    await expect(page.getByTestId('query')).toHaveText('denied');
    await expect(page.getByRole('heading', { name: 'Product shell' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});

test('a generic parallel shell hydrates aliased params, templates and selected segments', async ({ page }) => {
  const fixture = await partialFixture();
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  let server;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const files = {
      'app/parallel/layout.jsx': `import{Suspense}from'react';import Selected from'./selected';export default({children,detail})=><section><Suspense fallback={<p>Segments pending</p>}><Selected/></Suspense>{children}{detail}</section>`,
      'app/parallel/template.jsx': `export default({children})=><div data-testid="template">{children}</div>`,
      'app/parallel/selected.jsx': `'use client';import{useParams,useSelectedLayoutSegments}from'next/navigation';export default()=> <p data-testid="selected">{JSON.stringify([useParams(),useSelectedLayoutSegments('detail')])}</p>`,
      'app/parallel/[id]/page.jsx': `import{Suspense}from'react';import Counter from'../../counter';async function Main({params}){return <><p data-testid="parallel-main">{(await params).id}</p><Counter/></>}export default({params})=><Suspense fallback={<p>Main pending</p>}><Main params={params}/></Suspense>`,
      'app/parallel/@detail/[alias]/page.jsx': `import{Suspense}from'react';async function Detail({params}){return <p data-testid="parallel-detail">{(await params).alias}</p>}export default({params})=><Suspense fallback={<p>Detail pending</p>}><Detail params={params}/></Suspense>`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    await fixture.build(); server = await startServer(fixture.root);
    let stamp;
    for (const id of ['alpha', 'beta']) {
      const response = await page.goto(server.url + '/parallel/' + id);
      expect(response.headers()['x-prnext-prerender']).toBe('partial');
      await expect(page.getByTestId('parallel-main')).toHaveText(id);
      await expect(page.getByTestId('parallel-detail')).toHaveText(id);
      const selected = JSON.parse(await page.getByTestId('selected').textContent());
      expect(selected[0]).toEqual({ id, alias: id }); expect(selected[1]).toEqual([id]);
      await page.getByRole('button', { name: 'Count 0', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Count 1', exact: true })).toBeVisible();
      if (stamp) await expect(page.getByTestId('shell')).toHaveText(stamp);
      stamp = await page.getByTestId('shell').textContent();
    }
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
