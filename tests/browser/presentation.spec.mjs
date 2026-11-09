import {test,expect} from '@playwright/test';
import {presentationFixture,presentationSecrets} from '../presentation-fixture.mjs';
import {startServer} from '../support.mjs';

let fixture,server;
test.beforeAll(async()=>{fixture=await presentationFixture();await fixture.build();server=await startServer(fixture.root);});
test.afterAll(async()=>{await server?.close();await fixture?.remove();});

test('automatic unmarked presentation hydrates, retains state across navigation and updates through a Server Action',async({page})=>{
  const errors=[];const bodies=[];
  const table=()=>page.locator('section[data-testid="presentation"]:visible tbody');
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('response',response=>{if(/text\/(html|x-component)|javascript/.test(response.headers()['content-type']||''))bodies.push(response.text().catch(()=>''));});
  await page.goto(`${server.url}/?rows=1000`);
  await expect(table().locator('tr')).toHaveCount(1000);
  await expect(table().locator('tr').first()).toContainText('Account A');
  await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Count 1');
  await page.getByRole('link',{name:'Next page',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Next products'})).toBeVisible();
  await expect(table().locator('tr')).toHaveCount(12);
  await expect(page.getByTestId('counter')).toHaveText('Count 1');
  await page.goBack();await expect(table().locator('tr')).toHaveCount(1000);
  await page.getByRole('button',{name:'Switch account',exact:true}).click();
  await expect(table().locator('tr').first()).toContainText('Account B');
  await expect(page.locator('body')).not.toContainText('Account A');
  await page.goto(`${server.url}/fallback`);
  await expect(page.getByTestId('fallback')).toHaveText('7');
  await expect(page.getByTestId('unsupported')).toHaveText('Ordinary server component');
  await page.goto(`${server.url}/client`);
  await expect(table().locator('tr')).toHaveCount(2);
  await expect(table()).toContainText('Client product');
  await page.getByRole('button',{name:'Client count 0',exact:true}).click();
  await expect(page.getByRole('button',{name:'Client count 1',exact:true})).toBeVisible();
  await page.goto(`${server.url}/computed`);
  await expect(page.getByTestId('computed').locator('p')).toHaveCount(64);
  await expect(page.getByTestId('computed').locator('p').first()).toHaveText('1Visiblestring');
  const transferred=(await Promise.all(bodies)).join('\n');
  for(const secret of presentationSecrets)expect(transferred).not.toContain(secret);
  expect(transferred).not.toContain('SERVER-IMPORT-IS-PRIVATE');
  for(const secret of ['987654321','987654320','PRIVATE-AUTO-TOKEN-987'])expect(transferred).not.toContain(secret);
  expect(errors).toEqual([]);
});

test('Babel and Oxc memoization hydrate compiled presentation entries and ordinary client imports',async({page})=>{
  for(const reactCompiler of [true,{backend:'oxc'}]){
    const candidate=await presentationFixture({reactCompiler});let serving;
    try{
      await candidate.build();serving=await startServer(candidate.root);
      const errors=[];const handler=error=>errors.push(error.message);page.on('pageerror',handler);
      await page.goto(`${serving.url}/?rows=80`);
      await expect(page.locator('tbody tr')).toHaveCount(80);
      await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Count 1');
      await page.goto(`${serving.url}/client`);
      await expect(page.locator('tbody tr')).toHaveCount(2);
      await page.getByRole('button',{name:'Client count 0',exact:true}).click();
      await expect(page.getByRole('button',{name:'Client count 1',exact:true})).toBeVisible();
      expect(errors).toEqual([]);page.off('pageerror',handler);
    }finally{await serving?.close();await candidate.remove();}
  }
});

test('the initial table is complete without JavaScript',async({browser})=>{
  const context=await browser.newContext({javaScriptEnabled:false});
  try{const page=await context.newPage();await page.goto(`${server.url}/?rows=1000`);await expect(page.locator('tbody tr')).toHaveCount(1000);await expect(page.locator('tbody tr').last()).toContainText('Product 999');}
  finally{await context.close();}
});

test('runtime compact to ordinary fallback preserves the same DOM through Server Action updates',async({page})=>{
  await page.goto(`${server.url}/resize`);
  await expect(page.locator('tbody tr')).toHaveCount(64);
  await page.evaluate(()=>{window.__presentationNode=document.querySelector('section[data-testid="presentation"]');});
  for(const count of [12,64,12]){
    await page.getByRole('button',{name:'Resize table',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(count);
    expect(await page.evaluate(()=>window.__presentationNode===document.querySelector('section[data-testid="presentation"]'))).toBe(true);
  }
});

test('automatic imported blocks, shared localized templates and static HTML hydrate and survive actions',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(`${server.url}/blocks`);
  const table=page.getByTestId('block-table');
  await expect(table.locator('tr')).toHaveCount(64);await expect(table.locator('tr').first()).toContainText('Account A');
  await expect(page.getByTestId('label-a').getByRole('heading')).toHaveText('Hello');
  await expect(page.getByTestId('label-b').getByRole('heading')).toHaveText('Bonjour');
  await expect(page.getByTestId('block-static').locator('p')).toHaveCount(70);
  await page.evaluate(()=>{window.__blockTable=document.querySelector('[data-testid="block-table"]');});
  for(const count of[12,64]){
    await page.getByRole('button',{name:'Resize table',exact:true}).click();await expect(table.locator('tr')).toHaveCount(count);
    expect(await page.evaluate(()=>window.__blockTable===document.querySelector('[data-testid="block-table"]'))).toBe(true);
  }
  await page.getByTestId('counter').first().click();await expect(page.getByTestId('counter').first()).toHaveText('Count 1');
  await page.getByRole('link',{name:'Other page',exact:true}).click();await expect(page.getByRole('heading',{name:'Next products'})).toBeVisible();
  await page.goBack();await expect(table.locator('tr')).toHaveCount(64);await expect(page.getByTestId('counter').first()).toHaveText('Count 1');
  await page.getByRole('button',{name:'Switch account',exact:true}).click();await expect(table.locator('tr').first()).toContainText('Account B');
  await expect(page.locator('body')).not.toContainText('Account A');expect(errors).toEqual([]);
});
