import { test, expect } from '@playwright/test';
import path from 'node:path';
import { routeCssFixture, pageCss } from '../route-css-fixture.mjs';
import { startServer } from '../support.mjs';
import { partialFixture } from '../partial-fixture.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

function errors(page) {
  const values=[];
  page.on('pageerror',error=>values.push(error.message));
  page.on('console',message=>{if(message.type()==='error')values.push(message.text());});
  return values;
}

async function open(page,url,{development=false}={}) {
  await page.goto(url+'/docs/a');
  await expect(page.getByTestId('lazy')).toHaveCSS('color','rgb(98, 76, 54)');
  await expect(page.getByTestId('client-module')).toHaveCSS('border-top-color','rgb(12, 34, 56)');
  if(development)await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
  await page.getByTestId('persistent').click();
  await expect(page.getByTestId('persistent')).toHaveText('Count 1');
  await page.evaluate(()=>{window.__cssDocument=true;});
}

for(const webpack of [false,true])test(`${webpack?'webpack':'esbuild'} App route styles: CSS-only updates retain state and navigation removes obsolete globals`,async({page},testInfo)=>{
  test.setTimeout(180_000);
  const fixture=await routeCssFixture({development:true,webpack});
  const failures=errors(page);
  try{
    await open(page,fixture.url,{development:true});
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(170, 20, 30)');
    await fixture.write('app/a/page.css',pageCss('a','rgb(150,30,90)'));
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(150, 30, 90)',{timeout:30_000});
    await expect(page.getByTestId('persistent')).toHaveText('Count 1');
    expect(await page.evaluate(()=>window.__cssDocument)).toBe(true);
    await page.getByRole('link',{name:'B',exact:true}).click();
    await expect(page.locator('.main-tone')).toHaveText('Page B',{timeout:30_000});
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(20, 40, 170)');
    await expect(page.getByTestId('persistent')).toHaveText('Count 1');
    const css=await page.evaluate(()=>[...document.styleSheets].flatMap(sheet=>{try{return[...sheet.cssRules].map(rule=>rule.cssText)}catch{return[]}}).join('\n'));
    expect(css).not.toContain('--page-a');
    await page.goBack();
    await expect(page.locator('.main-tone')).toHaveText('Page A',{timeout:30_000});
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(150, 30, 90)');
    expect(await page.evaluate(()=>window.__cssDocument)).toBe(true);
    expect(failures).toEqual([]);
  }catch(error){
    const state=await page.evaluate(()=>({url:location.href,styles:[...document.querySelectorAll('link[rel="stylesheet"]')].map(link=>({href:link.href,media:link.media,loaded:!!link.sheet})),dev:window.__PRNEXT_DEV__?{applying:window.__PRNEXT_DEV__.applying,confirmed:window.__PRNEXT_DEV__.confirmed,buildId:window.__PRNEXT_DEV__.buildId,sequence:window.__PRNEXT_DEV__.sequence,lastRefresh:window.__PRNEXT_DEV__.lastRefresh}:null})).catch(()=>null);
    await testInfo.attach('css-failure-state',{body:JSON.stringify({failures,state}),contentType:'application/json'});
    throw error;
  }finally{await fixture.close();}
});

test('production route CSS: delayed sheets cannot flash unstyled content and Node/Edge keep shared layout state',async({page},testInfo)=>{
  test.setTimeout(180_000);
  const fixture=await routeCssFixture();let server;
  const failures=errors(page);
  try{
    const manifest=await fixture.build();server=await startServer(fixture.root);
    const routes=new Map(manifest.routes.map(route=>[route.pattern,route]));
    const requests=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('.css'))requests.push(request.url());});
    await open(page,server.url);
    const a=routes.get('/a'),b=routes.get('/b');
    expect(a.css[0]).toBe(b.css[0]);
    expect(requests.some(url=>b.css.filter(css=>!a.css.includes(css)).some(css=>url.endsWith(css)))).toBe(false);
    let release,requested;const blocked=new Promise(resolve=>{requested=resolve});
    const gate=new Promise(resolve=>{release=resolve});
    const target=b.css.find(css=>!a.css.includes(css));
    await page.route('**/'+path.basename(target),async route=>{requested();await gate;await route.continue();});
    await page.evaluate(()=>{
      window.__cssFrames=[];window.__cssSampling=true;
      const sample=()=>{if(!window.__cssSampling)return;const main=document.querySelector('main[data-page]');if(main)window.__cssFrames.push([main.dataset.page,getComputedStyle(main.querySelector('.main-tone')).color]);requestAnimationFrame(sample)};sample();
    });
    await page.getByRole('link',{name:'B',exact:true}).click();await blocked;
    await expect(page.locator('.main-tone')).toHaveText('Page A');
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(170, 20, 30)');
    release();await expect(page.locator('.main-tone')).toHaveText('Page B');
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(20, 40, 170)');
    await page.goBack();await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(170, 20, 30)');
    await page.getByRole('link',{name:'EDGE',exact:true}).click();
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(30, 140, 90)');
    await expect(page.getByTestId('persistent')).toHaveText('Count 1');
    expect(await page.evaluate(()=>window.__cssDocument)).toBe(true);
    const frames=await page.evaluate(()=>{window.__cssSampling=false;return window.__cssFrames});
    for(const[name,color]of frames)expect(color).toBe({a:'rgb(170, 20, 30)',b:'rgb(20, 40, 170)',edge:'rgb(30, 140, 90)'}[name]);
    expect(requests.filter(url=>new URL(url).pathname===new URL(a.css[0],server.url).pathname), 'shared layout CSS must never move or download again during navigation').toHaveLength(1);
    expect(failures).toEqual([]);
    await testInfo.attach('styled-frames',{body:JSON.stringify({requests,frames}),contentType:'application/json'});
  }finally{await server?.close();await fixture.remove();}
});

test('parallel slot CSS survives soft navigation while the inactive main page globals are removed',async({page})=>{
  test.setTimeout(180_000);
  const fixture=await routeCssFixture({development:true,parallel:true});
  const failures=errors(page);
  try{
    await open(page,fixture.url,{development:true});
    await expect(page.getByTestId('detail')).toHaveCSS('color','rgb(30, 140, 90)');
    await page.getByRole('link',{name:'B',exact:true}).click();
    await expect(page.locator('.main-tone')).toHaveText('Page B');
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(20, 40, 170)');
    await expect(page.getByTestId('detail')).toHaveText('Detail A');
    await expect(page.getByTestId('detail')).toHaveCSS('color','rgb(30, 140, 90)');
    const css=await page.evaluate(()=>[...document.styleSheets].flatMap(sheet=>{try{return[...sheet.cssRules].map(rule=>rule.cssText)}catch{return[]}}).join('\n'));
    expect(css).not.toContain('--page-a');
    await fixture.write('app/@detail/a/detail.css','.detail-tone{color:rgb(20,80,150)}');
    await expect(page.getByTestId('detail')).toHaveCSS('color','rgb(20, 80, 150)',{timeout:30_000});
    await expect(page.getByTestId('persistent')).toHaveText('Count 1');
    expect(await page.evaluate(()=>window.__cssDocument)).toBe(true);
    expect(failures).toEqual([]);
  }finally{await fixture.close();}
});

test('a failed route stylesheet falls back to a fresh document without leaving the old page globals active',async({page})=>{
  test.setTimeout(180_000);
  const fixture=await routeCssFixture();let server;
  const failures=[];page.on('pageerror',error=>failures.push(error.message));
  try{
    const manifest=await fixture.build();server=await startServer(fixture.root);
    await open(page,server.url);
    const route=manifest.routes.find(route=>route.pattern==='/c');
    const a=manifest.routes.find(route=>route.pattern==='/a');
    const css=route.css.find(href=>!a.css.includes(href));let attempts=0;
    await page.route('**/'+path.basename(css),async route=>{if(++attempts===1)await route.abort('failed');else await route.continue();});
    await page.getByRole('link',{name:'C',exact:true}).click();
    await expect(page.locator('.main-tone')).toHaveText('Page C',{timeout:30_000});
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(140, 60, 20)');
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(()=>window.__cssDocument)).toBeUndefined();
    const rules=await page.evaluate(()=>[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules].map(rule=>rule.cssText)).join('\n'));
    expect(rules).not.toContain('--page-a');
    expect(failures).toEqual([]);
  }finally{await server?.close();await fixture.remove();}
});

test('interception keeps styled backgrounds, excludes canonical globals and hard reload selects canonical CSS only',async({page})=>{
  test.setTimeout(180_000);
  const fixture=await routeCssFixture({parallel:true,interception:true});let server;
  const failures=errors(page);
  const rules=()=>page.evaluate(()=>[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules].map(rule=>rule.cssText)).join('\n'));
  try{
    await fixture.build();server=await startServer(fixture.root);
    await open(page,server.url);
    expect(await rules()).not.toContain('--modal-only');
    await page.getByRole('link',{name:'Photo',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCSS('color','rgb(160, 80, 20)');
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(170, 20, 30)');
    await expect(page.getByTestId('detail')).toHaveCSS('color','rgb(30, 140, 90)');
    expect(await rules()).not.toContain('--canonical-only');
    await page.goBack();await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await rules()).not.toContain('--modal-only');
    await page.goForward();await expect(page.getByRole('dialog')).toHaveCSS('color','rgb(160, 80, 20)');
    await expect(page.getByTestId('persistent')).toHaveText('Count 1');
    expect(await page.evaluate(()=>window.__cssDocument)).toBe(true);
    const response=await page.reload();expect(response.status()).toBe(200);
    await expect(page.getByTestId('canonical')).toBeVisible();
    await expect(page.locator('.main-tone')).toHaveCSS('color','rgb(10, 40, 160)');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await rules()).not.toContain('--modal-only');
    expect(await rules()).not.toContain('--page-a');
    expect(failures).toEqual([]);
  }finally{await server?.close();await fixture.remove();}
});

test('PPR route CSS loads before its authorized preview and a denied prefetched route cannot install its styles',async({page,context})=>{
  test.setTimeout(180_000);
  const fixture=await partialFixture();let server,release;
  const failures=errors(page);
  try{
    await mkdir(path.join(fixture.root,'app/prefetch'),{recursive:true});
    await writeFile(path.join(fixture.root,'app/prefetch/page.jsx'),`'use client';import Link from'next/link';import './start.css';export default()=> <main data-testid="prefetch-start"><h1>Choose product</h1><Link href="/product/first">First product</Link></main>`);
    await writeFile(path.join(fixture.root,'app/prefetch/start.css'),'main{--prefetch-start:1;color:rgb(30,120,70)}');
    const product=path.join(fixture.root,'app/product/[id]/page.jsx');
    await writeFile(product,"import './product.css';"+(await readFile(product,'utf8')).replace("import{cookies}from'next/headers'","import{cookies,headers}from'next/headers'").replace('async function Visitor(){',"async function Visitor(){const delay=(await headers()).get('x-test-delay');if(delay)await new Promise(r=>setTimeout(r,Number(delay)));").replace('<h2>Product shell</h2>','<h2 className="product-tone">Product shell</h2>'));
    await writeFile(path.join(fixture.root,'app/product/[id]/product.css'),'.product-tone{--product-css:1;color:rgb(180,70,20)}');
    await writeFile(path.join(fixture.root,'proxy.js'),`import{NextResponse}from'next/server';export function proxy(req){if(req.nextUrl.pathname.startsWith('/product/')&&req.cookies.get('deny')?.value==='yes')return NextResponse.redirect(new URL('/query?q=denied',req.url));return NextResponse.next()}`);
    const manifest=await fixture.build();server=await startServer(fixture.root);
    const css=manifest.routes.find(route=>route.pattern==='/product/[id]').css[0];
    const warm=page.waitForResponse(response=>response.request().headers()['x-prnext-prefetch']==='1'&&new URL(response.url()).pathname==='/product/first');
    await page.goto(server.url+'/prefetch');await(await warm).finished();
    await page.getByRole('link',{name:'First product'}).hover();
    let requested;const waiting=new Promise(resolve=>{requested=resolve});const gate=new Promise(resolve=>{release=resolve});
    await page.route('**/'+path.basename(css),async route=>{requested();await gate;await route.continue();});
    await context.addCookies([{name:'name',value:'Current visitor',url:server.url}]);
    await context.setExtraHTTPHeaders({'x-test-delay':'1600'});
    await page.getByRole('link',{name:'First product'}).click();await waiting;
    await expect(page.getByTestId('prefetch-start')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Product shell'})).toHaveCount(0);
    release();
    await expect(page.getByRole('heading',{name:'Product shell'})).toHaveCSS('color','rgb(180, 70, 20)');
    await expect(page.getByText('Waiting visitor',{exact:true})).toBeVisible();
    await expect(page.getByTestId('product-visitor')).toHaveText('Current visitor');
    await context.setExtraHTTPHeaders({});
    const warmAgain=page.waitForResponse(response=>response.request().headers()['x-prnext-prefetch']==='1');
    await page.goto(server.url+'/prefetch');await(await warmAgain).finished();
    await context.addCookies([{name:'deny',value:'yes',url:server.url}]);
    await page.getByRole('link',{name:'First product'}).click();
    await expect(page.getByTestId('query')).toHaveText('denied');
    await expect(page.getByRole('heading',{name:'Product shell'})).toHaveCount(0);
    expect(await page.evaluate(href=>[...document.querySelectorAll('link[rel="stylesheet"]')].some(link=>link.href.endsWith(href)),css)).toBe(false);
    expect(failures).toEqual([]);
  }finally{release?.();await server?.close();await fixture.remove();}
});
