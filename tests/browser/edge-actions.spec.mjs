import {test,expect} from '@playwright/test';
import {edgeActionsFixture} from '../edge-actions-fixture.mjs';
import {startServer} from '../support.mjs';
test('Edge RPC and encrypted inline form actions update an hydrated page',async({page})=>{
  const fixture=await edgeActionsFixture();let server;
  try{
    await fixture.build();server=await startServer(fixture.root);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url);await page.getByRole('button',{name:'Edge action',exact:true}).click();
    await expect(page.locator('#result')).toContainText('"runtime":"edge"');
    await expect(page.locator('#result')).toContainText('"node":"undefined"');
    await expect(page.locator('#cookie')).toHaveText('browser');
    await page.getByRole('button',{name:'Inline',exact:true}).click();
    await expect.poll(async()=> (await page.context().cookies()).find(cookie=>cookie.name==='inline-edge')?.value).toBe('encrypted-edge%3Abound');
    await page.goto(server.url+'/node');await page.getByRole('button',{name:'Edge action',exact:true}).click();
    await expect(page.locator('#result')).toContainText('"runtime":"nodejs"');
    await expect(page.locator('#result')).toContainText('"node":"function"');
    expect(errors).toEqual([]);
  }finally{await server?.close();await fixture.remove()}
});
