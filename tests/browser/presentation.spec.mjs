import {test,expect} from '@playwright/test';
import {presentationFixture,presentationSecrets} from '../presentation-fixture.mjs';
import {startServer} from '../support.mjs';

let fixture,server;
test.beforeAll(async()=>{fixture=await presentationFixture();await fixture.build();server=await startServer(fixture.root);});
test.afterAll(async()=>{await server?.close();await fixture?.remove();});

test('compact presentation hydrates, retains state across navigation and updates through a Server Action',async({page})=>{
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
  const transferred=(await Promise.all(bodies)).join('\n');
  for(const secret of presentationSecrets)expect(transferred).not.toContain(secret);
  expect(transferred).not.toContain('SERVER-IMPORT-IS-PRIVATE');
  expect(errors).toEqual([]);
});

test('Babel and Oxc memoization hydrate compiled presentation entries and ordinary client imports',async({page})=>{
  for(const reactCompiler of [true,{backend:'oxc'}]){
    const candidate=await presentationFixture({reactCompiler});let serving;
    try{
      await candidate.build();serving=await startServer(candidate.root);
      const errors=[];const handler=error=>errors.push(error.message);page.on('pageerror',handler);
      await page.goto(`${serving.url}/?rows=20`);
      await expect(page.locator('tbody tr')).toHaveCount(20);
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
