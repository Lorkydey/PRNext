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

test('specialized DOM adopts SSR, retains keyed nodes and focus across binary/flat packets, branches and small lists',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const response=await page.goto(`${server.url}/dom`),initial=await response.text();
  expect(initial).not.toContain('PRIVATE-DOM-NEVER');expect(initial).not.toContain('HIDDEN-UNTIL-BRANCH');
  const root=page.getByTestId('dom-display'),row=id=>root.locator(`tr[data-row="${id}"]`);
  await page.waitForFunction(()=>performance.getEntriesByName('presentation-hydrated').length>0);
  await expect(root.locator('tr')).toHaveCount(64);await expect(row(1).locator('td').nth(1)).toHaveText('1 €');
  await page.evaluate(()=>{window.__domRoot=document.querySelector('[data-testid="dom-display"]');window.__domRows=new Map([...window.__domRoot.querySelectorAll('tr')].map(n=>[n.dataset.row,n]));window.__domRows.get('1').focus();const text=window.__domRows.get('1').querySelector('td').firstChild;getSelection().setBaseAndExtent(text,0,text,4);});
  const advance=async()=>page.getByRole('button',{name:'Advance display',exact:true}).evaluate(button=>button.click());
  await advance();await expect(root.locator('tr').first()).toHaveAttribute('data-row','63');await expect(row(1).locator('td').nth(1)).toHaveText('2 €');
  expect(await page.evaluate(()=>[...document.querySelectorAll('[data-testid="dom-display"] tr')].every(n=>window.__domRows.get(n.dataset.row)===n))).toBe(true);
  expect(await page.evaluate(()=>document.activeElement===window.__domRows.get('1'))).toBe(true);
  expect(await page.evaluate(()=>getSelection().toString())).toBe('Item');
  await expect(page.getByTestId('focus-guard')).toHaveAttribute('data-blurs','0');
  await page.keyboard.press('Tab');await expect(row(0)).toBeFocused();
  await page.keyboard.press('Shift+Tab');await expect(row(1)).toBeFocused();
  await advance();await expect(row(999)).toHaveCount(1);await expect(row(0)).toHaveCount(0);await expect(row(1).locator('td').nth(1)).toHaveText('3 €');
  expect(await page.evaluate(()=>document.querySelector('[data-row="1"]')===window.__domRows.get('1'))).toBe(true);
  expect(await row(1).locator('svg').evaluate(n=>n.namespaceURI)).toBe('http://www.w3.org/2000/svg');
  await advance();await expect(root.locator('tr')).toHaveCount(12);await expect(row(1).locator('td').nth(1)).toHaveText('4 €');
  expect(await page.evaluate(()=>document.querySelector('[data-row="1"]')===window.__domRows.get('1'))).toBe(true);
  expect(await page.evaluate(()=>document.activeElement===window.__domRows.get('1'))).toBe(true);
  await advance();await expect(root.locator('tr')).toHaveCount(64);await expect(row(1).locator('td').nth(1)).toHaveText('5 €');
  expect(await page.evaluate(()=>document.querySelector('[data-testid="dom-display"]')===window.__domRoot)).toBe(true);
  await root.evaluate(node=>{const extra=document.createElement('span');extra.textContent='Unexpected external DOM';node.appendChild(extra);});
  await advance();await expect(row(1).locator('td').nth(1)).toHaveText('1 €');
  await expect(root).not.toContainText('Unexpected external DOM');
  expect(await page.evaluate(()=>document.querySelector('[data-testid="dom-display"]')===window.__domRoot)).toBe(true);
  await expect(page.getByTestId('focus-guard')).toHaveAttribute('data-blurs','2');
  expect(errors).toEqual([]);
});

test('removing a focused display row delegates to React without synthetic blur side effects',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${server.url}/dom`);await page.waitForFunction(()=>performance.getEntriesByName('presentation-hydrated').length>0);
  await page.locator('[data-row="0"]').focus();
  const advance=()=>page.getByRole('button',{name:'Advance display',exact:true}).evaluate(button=>button.click());
  await advance();await expect(page.locator('[data-testid="dom-display"] tr').first()).toHaveAttribute('data-row','63');
  await expect(page.getByTestId('focus-guard')).toHaveAttribute('data-blurs','0');
  await advance();await expect(page.locator('[data-row="0"]')).toHaveCount(0);await expect(page.locator('[data-row="999"]')).toHaveCount(1);
  await expect(page.getByTestId('focus-guard')).toHaveAttribute('data-blurs','0');
  expect(errors).toEqual([]);
});
