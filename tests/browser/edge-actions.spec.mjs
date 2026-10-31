import {test,expect} from '@playwright/test';
import {edgeActionsFixture} from '../edge-actions-fixture.mjs';
import {startServer} from '../support.mjs';
for (const delayedClient of [false,true]) test('Edge RPC and encrypted inline form actions update an hydrated page'+(delayedClient?' when the Client chunk arrives after load':''),async({page})=>{
  const fixture=await edgeActionsFixture();let server,release=()=>{};
  try{
    const manifest=await fixture.build();server=await startServer(fixture.root);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let arrived;
    if(delayedClient){
      const client=Object.values(manifest.app.clientModules)[0].browserModule;
      const gate=new Promise(resolve=>{release=resolve});
      let receive;arrived=new Promise(resolve=>{receive=resolve});
      await page.route(new URL(client,server.url).href,async route=>{receive();await gate;await route.continue();},{times:1});
    }
    await page.goto(server.url);
    const button=page.getByRole('button',{name:'Edge action',exact:true});
    if(delayedClient){
      await arrived;
      expect(await page.evaluate(()=>document.readyState)).toBe('complete');
      await expect(button).toHaveAttribute('data-hydrated','false');
      release();
    }
    await expect(button).toHaveAttribute('data-hydrated','true');
    await button.click();
    await expect(page.locator('#result')).toContainText('"runtime":"edge"');
    await expect(page.locator('#result')).toContainText('"node":"undefined"');
    await expect(page.locator('#cookie')).toHaveText('browser');
    await page.getByRole('button',{name:'Inline',exact:true}).click();
    await expect.poll(async()=> (await page.context().cookies()).find(cookie=>cookie.name==='inline-edge')?.value).toBe('encrypted-edge%3Abound');
    await page.goto(server.url+'/node');
    await expect(button).toHaveAttribute('data-hydrated','true');
    await button.click();
    await expect(page.locator('#result')).toContainText('"runtime":"nodejs"');
    await expect(page.locator('#result')).toContainText('"node":"function"');
    expect(errors).toEqual([]);
  }finally{release();await page.unrouteAll({behavior:'ignoreErrors'});await server?.close();await fixture.remove()}
});
