import {test,expect} from '@playwright/test';
import {htmlOnlyFixture} from '../html-only-fixture.mjs';
import {startServer} from '../support.mjs';
import {startStandalone} from '../standalone-output-fixture.mjs';
import path from 'node:path';
import {mkdtemp,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';

test.describe('production HTML-only documents',()=>{
  let fixture,server;
  test.beforeAll(async()=>{fixture=await htmlOnlyFixture();await fixture.build();server=await startServer(fixture.root,['--workers','1']);});
  test.afterAll(async()=>{await server?.close();await fixture?.remove();});

  test('HTML/CSS/fonts/metadata and ordinary navigation work with JavaScript disabled',async({browser})=>{
    const context=await browser.newContext({javaScriptEnabled:false}),page=await context.newPage(),scripts=[];
    page.on('request',request=>{if(request.resourceType()==='script')scripts.push(request.url());});
    try{
      const response=await page.goto(server.url+'/docs/legal');expect(response.status()).toBe(200);
      expect(await response.text()).not.toMatch(/<script\b|__PRNEXT_(?:FLIGHT|DATA|PPR)/i);
      await expect(page).toHaveTitle('Legal document');await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://example.test/legal');
      await expect(page.locator('h1')).toHaveCSS('color','rgb(22, 110, 77)');await expect(page.locator('body')).toHaveCSS('background-color','rgb(10, 20, 30)');
      await expect(page.getByTestId('resolved')).toHaveText('Fully resolved content');await expect(page.getByTestId('pending')).toHaveCount(0);
      await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(1);
      await page.getByRole('link',{name:'Other document',exact:true}).click();await expect(page.locator('h1')).toHaveText('Other document');await expect(page.locator('h1')).toHaveCSS('color','rgb(22, 110, 77)');
      expect(scripts).toEqual([]);expect(await page.locator('script').count()).toBe(0);
    }finally{await context.close();}
  });

  test('hydrated Link skips HTML-only prefetch and uses a document while a more-specific hydrated route stays client-side',async({page})=>{
    const flights=[],documents=[];page.on('request',request=>{if(request.headers().rsc==='1')flights.push(request.url());if(request.resourceType()==='document')documents.push(request.url());});
    await page.goto(server.url+'/docs/interactive');await page.waitForFunction(()=>window.__interactiveReady===true);
    await page.evaluate(()=>{window.__htmlDocumentMarker='hydrated';});
    await page.waitForTimeout(250);
    expect(flights.filter(url=>/\/docs\/(?:legal|guide\/first)$/.test(url))).toEqual([]);
    await page.getByRole('link',{name:'Edit hydrated'}).click();await expect(page).toHaveURL(server.url+'/docs/guide/edit');
    expect(await page.evaluate(()=>window.__htmlDocumentMarker)).toBe('hydrated');expect(documents).toHaveLength(1);
    await page.getByRole('link',{name:'Guide HTML'}).click();await expect(page).toHaveURL(server.url+'/docs/guide/first');await expect(page.locator('h1')).toHaveText('Guide first');
    expect(await page.evaluate(()=>window.__htmlDocumentMarker)).toBeUndefined();expect(documents).toHaveLength(2);await expect(page.locator('script')).toHaveCount(0);
    expect(flights.filter(url=>url.endsWith('/docs/guide/first'))).toEqual([]);
  });

  test('transport requests and unlisted parameters never reveal Flight or invoke a hydrated fallback',async({request})=>{
    for(const headers of [{RSC:'1'},{RSC:'1','x-prnext-prefetch':'1'}]){
      const response=await request.get(server.url+'/docs/legal',{headers});expect(response.status()).toBe(409);expect(response.headers()['x-prnext-document-navigation']).toBe('1');expect(response.headers()['cache-control']).toContain('no-store');expect(await response.text()).not.toMatch(/<script\b|__PRNEXT_FLIGHT|text\/x-component/i);
    }
    const missing=await request.get(server.url+'/docs/guide/missing');expect(missing.status()).toBe(404);expect(await missing.text()).not.toMatch(/<script\b|__PRNEXT_FLIGHT/i);
    const action=await request.post(server.url+'/docs/legal',{headers:{RSC:'1','Next-Action':'not-executed'},data:'[]'});expect(action.status()).toBe(409);expect(await action.text()).not.toMatch(/__PRNEXT_|text\/x-component/);
  });

  test('a rewrite discovered by Flight falls back to the HTML-only document',async({page})=>{
    const flights=[],documents=[];page.on('request',request=>{if(request.headers().rsc==='1')flights.push(request.url());if(request.resourceType()==='document')documents.push(request.url());});
    await page.goto(server.url+'/docs/interactive');await page.waitForFunction(()=>window.__interactiveReady===true);
    await page.getByRole('link',{name:'Masked HTML'}).click();await expect(page).toHaveURL(server.url+'/docs/masked');await expect(page.locator('h1')).toHaveText('Legal document');
    await expect(page.locator('script')).toHaveCount(0);expect(flights.filter(url=>url.endsWith('/docs/masked'))).toHaveLength(1);expect(documents).toHaveLength(2);
  });
});

test('portable standalone serves HTML-only documents after removing the source checkout',async({page})=>{
  test.setTimeout(180000);
  const fixture=await htmlOnlyFixture({output:'standalone'});let deployed,server;
  try{
    await fixture.build();deployed=await mkdtemp(path.join(tmpdir(),'prnext-html-only-standalone-'));await cp(path.join(fixture.root,'.prnext/standalone'),deployed,{recursive:true});await fixture.remove();
    server=await startStandalone(deployed);const response=await page.goto(server.url+'/docs/legal');expect(response.status()).toBe(200);expect(await response.text()).not.toMatch(/<script\b|__PRNEXT_FLIGHT/i);await expect(page.locator('h1')).toHaveCSS('color','rgb(22, 110, 77)');await expect(page.getByTestId('resolved')).toBeVisible();
  }finally{
    await server?.close();await fixture.remove();
    if(deployed){
      if(path.dirname(path.resolve(deployed))!==path.resolve(tmpdir())||!path.basename(deployed).startsWith('prnext-html-only-standalone-'))throw new Error('Refusing to remove an unowned standalone fixture');
      await rm(deployed,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    }
  }
});
