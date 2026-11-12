import {test,expect} from '@playwright/test';
import {frameworkOptimizationsFixture} from '../framework-optimizations-fixture.mjs';
import {startServer} from '../support.mjs';

let fixture,server,widget;
test.beforeAll(async()=>{fixture=await frameworkOptimizationsFixture();await fixture.build();widget=await fixture.widgetAsset();server=await startServer(fixture.root);});
test.afterAll(async()=>{await server?.close();await fixture?.remove();});

function errorsFor(page){const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});return errors;}
async function ready(page,url='/deferred'){
  await page.goto(server.url+url);
  await page.getByTestId('eager').click();
  await expect(page.getByTestId('eager')).toHaveText('Eager 1');
}
async function holdWidget(page){
  let release;const released=new Promise(done=>{release=done;});let requests=0;
  await page.route('**'+widget,async route=>{requests++;await released;await route.continue();});
  return {release,requests:()=>requests};
}

test('query-only navigation updates only subscribed memoized consumers',async({page})=>{
  const errors=errorsFor(page);
  await page.goto(server.url+'/navigation/one');
  await expect(page.getByTestId('search-observer')).toHaveText('empty');
  await page.waitForFunction(()=>window.__navRenders?.search>0);
  const before=await page.evaluate(()=>({...window.__navRenders}));
  await page.getByRole('button',{name:'Update query',exact:true}).click();
  await expect(page.getByTestId('search-observer')).toHaveText('second');
  const after=await page.evaluate(()=>({...window.__navRenders}));
  expect(after.search).toBeGreaterThan(before.search);
  for(const key of ['router','path','params'])expect(after[key],key).toBe(before[key]);
  await page.getByRole('button',{name:'Update slug',exact:true}).click();
  await expect(page.getByTestId('path-observer')).toHaveText('/navigation/two');
  await expect(page.getByTestId('params-observer')).toHaveText('two');
  expect(errors).toEqual([]);
});

test('SSR Query state is reused without refetch, shares observers and changes account safely',async({page})=>{
  const errors=errorsFor(page),requests=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/query')requests.push(request.url());});
  await page.goto(server.url+'/query');
  await page.waitForFunction(()=>window.__queryHydrated);
  await page.waitForLoadState('networkidle');
  for(const name of ['one','two'])await expect(page.getByTestId('query-'+name)).toHaveText('owner-A:ssr:1');
  expect(requests).toHaveLength(0);
  await page.getByRole('button',{name:'Refresh query',exact:true}).click();
  await expect(page.getByTestId('query-one')).toHaveText(/owner-A:browser:/);
  await expect(page.getByTestId('query-two')).toHaveText(await page.getByTestId('query-one').textContent());
  expect(requests).toHaveLength(1);
  await page.getByRole('button',{name:'Change query owner',exact:true}).click();
  for(const name of ['one','two'])await expect(page.getByTestId('query-'+name)).toHaveText('owner-B:ssr:1');
  await page.waitForLoadState('networkidle');
  expect(requests).toHaveLength(1);
  await expect(page.locator('body')).not.toContainText('owner-A');
  expect(errors).toEqual([]);
});

test('Pages Query snapshots share the same SSR and browser provider',async({page})=>{
  const errors=errorsFor(page),requests=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/query')requests.push(r.url());});
  await page.goto(server.url+'/query-legacy');await page.waitForFunction(()=>window.__queryHydrated);await page.waitForLoadState('networkidle');
  for(const name of ['one','two'])await expect(page.getByTestId('query-'+name)).toHaveText('owner-A:ssr:1');expect(requests).toHaveLength(0);
  await page.getByRole('button',{name:'Refresh query',exact:true}).click();await expect(page.getByTestId('query-one')).toHaveText(/owner-A:browser:/);expect(requests).toHaveLength(1);expect(errors).toEqual([]);
});

test('retained Query caches survive Activity and nested providers share the owned client',async({page})=>{
  const errors=errorsFor(page),requests=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/query')requests.push(r.url());});
  await page.goto(server.url+'/query');await page.waitForFunction(()=>window.__queryHydrated);
  await page.getByRole('button',{name:'Remember query draft',exact:true}).click();
  for(const name of ['one','two'])await expect(page.getByTestId('draft-'+name)).toHaveText('kept');
  await page.getByRole('link',{name:'Other query page',exact:true}).click();await expect(page.getByRole('heading',{name:'Other page',exact:true})).toBeVisible();
  await page.goBack();
  for(const name of ['one','two'])await expect(page.locator('[data-testid="draft-'+name+'"]:visible')).toHaveText('kept');
  await page.waitForLoadState('networkidle');expect(requests).toHaveLength(0);
  await page.getByRole('button',{name:'Change query owner',exact:true}).click();
  for(const name of ['one','two']){await expect(page.getByTestId('query-'+name)).toHaveText('owner-B:ssr:1');await expect(page.getByTestId('draft-'+name)).toHaveText('empty');}
  expect(errors).toEqual([]);
});

test('deferred SSR HTML waits for interaction, preserves its DOM and replays the first click once',async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{
    await ready(page);
    await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 0');
    expect(held.requests()).toBe(0);
    await page.getByTestId('deferred-button').evaluate(node=>{window.__originalDeferred=node;});
    await page.getByTestId('deferred-button').click();
    await expect.poll(held.requests).toBe(1);
    await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 0');
    await page.evaluate(()=>{window.__focusBeforeHydration=document.activeElement;});
    held.release();
    await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 1');
    expect(await page.evaluate(()=>window.__originalDeferred===document.querySelector('[data-testid="deferred-button"]'))).toBe(true);
    expect(await page.evaluate(()=>window.__deferredClicks)).toBe(1);
    expect(await page.evaluate(()=>document.activeElement===window.__focusBeforeHydration)).toBe(true);
    expect(errors).toEqual([]);
  }finally{held.release();}
});

test('Edge-rendered deferred widgets hydrate against the same browser entries',async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{await ready(page,'/deferred-edge');expect(held.requests()).toBe(0);await page.getByTestId('deferred-button').click();held.release();await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 1');expect(await page.evaluate(()=>window.__deferredClicks)).toBe(1);expect(errors).toEqual([]);}finally{held.release();}
});

for(const key of ['Enter','Space'])test('deferred first keyboard activation is preserved: '+key,async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{await ready(page);await page.getByTestId('deferred-button').focus();await page.keyboard.press(key);held.release();await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 1');await expect(page.getByTestId('deferred-button')).toBeFocused();expect(await page.evaluate(()=>window.__deferredClicks)).toBe(1);expect(errors).toEqual([]);}finally{held.release();}
});

test('deferred hydration retains typed input and submits once',async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{await ready(page);await page.getByTestId('deferred-input').fill('typed before hydration');await page.getByTestId('deferred-submit').click();held.release();await page.waitForFunction(()=>window.__deferredSubmits===1);await expect(page.getByTestId('deferred-input')).toHaveValue('typed before hydration');expect(errors).toEqual([]);}finally{held.release();}
});

test('visible widgets load on visibility, idle widgets load automatically and client navigation renders normally',async({page})=>{
  const errors=errorsFor(page),assets=[];
  page.on('request',request=>{if(new URL(request.url()).pathname===widget)assets.push(request.url());});
  await ready(page,'/deferred-visible');expect(assets).toHaveLength(0);
  await page.getByTestId('deferred-button').scrollIntoViewIfNeeded();await page.waitForFunction(()=>window.__deferredHydrated);expect(assets).toHaveLength(1);
  await page.waitForLoadState('networkidle');await page.goto(server.url+'/deferred-idle');await page.waitForFunction(()=>window.__deferredHydrated);
  await page.waitForLoadState('networkidle');await page.goto(server.url+'/other');await page.waitForFunction(()=>[...document.querySelectorAll('a')].some(node=>Object.keys(node).some(key=>key.startsWith('__reactProps$'))));await page.evaluate(()=>{window.__sameDocument=true});await page.getByRole('link',{name:'Deferred visible',exact:true}).click();await expect.poll(()=>page.evaluate(()=>({sameDocument:window.__sameDocument,hydrated:window.__deferredHydrated}))).toEqual({sameDocument:true,hydrated:true});await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 0');expect(errors).toEqual([]);
});

test('nested deferred widgets preserve the original activation',async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{await ready(page,'/deferred-nested');await page.getByTestId('deferred-button').click();held.release();await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 1');expect(await page.evaluate(()=>window.__deferredClicks)).toBe(1);expect(errors).toEqual([]);}finally{held.release();}
});

test('updated props discard pending stale activations',async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{
    await ready(page);await page.getByTestId('deferred-button').click();
    await page.getByRole('button',{name:'Change deferred props',exact:true}).click();held.release();
    await expect(page.getByTestId('deferred-label')).toHaveText('label-B');await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 0');expect(await page.evaluate(()=>window.__deferredClicks||0)).toBe(0);expect(errors).toEqual([]);
  }finally{held.release();}
});

test('leaving a deferred widget cancels queued activation before its code arrives',async({page})=>{
  const errors=errorsFor(page),held=await holdWidget(page);
  try{
    await ready(page,'/deferred-visible');await page.evaluate(()=>{window.__cancelDocument=true;});await page.getByTestId('deferred-button').click();
    await page.getByRole('link',{name:'Leave deferred',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Other page',exact:true})).toBeVisible();
    held.release();await page.waitForLoadState('networkidle');
    expect(await page.evaluate(()=>window.__cancelDocument)).toBe(true);expect(await page.evaluate(()=>window.__deferredClicks||0)).toBe(0);expect(errors).toEqual([]);
  }finally{held.release();}
});

test('deferred widgets retain complete SSR HTML with JavaScript disabled',async({browser})=>{
  const context=await browser.newContext({javaScriptEnabled:false});
  try{const page=await context.newPage();await page.goto(server.url+'/deferred');await expect(page.getByTestId('deferred-button')).toHaveText('Deferred 0');await expect(page.getByTestId('deferred-label')).toHaveText('label-A');await expect(page.getByTestId('deferred-input')).toHaveValue('server text');}finally{await context.close();}
});
