import {test,expect} from '@playwright/test';
import {edgeActionsFixture} from '../edge-actions-fixture.mjs';
import {startServer} from '../support.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
for (const delayedClient of [false,true]) test('Edge RPC and encrypted inline form actions update an hydrated page'+(delayedClient?' while its Client module is held during navigation':''),async({page})=>{
  const fixture=await edgeActionsFixture();let server,release=()=>{};
  try{
    const manifest=await fixture.build();server=await startServer(fixture.root);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let arrived=false,client;
    if(delayedClient){
      // The manifest also contains compatibility entries that this page never
      // imports. Its insertion order does not identify the fixture's Client.
      const candidates=(await Promise.all(Object.values(manifest.app.clientModules).map(async module=>{
        const source=await readFile(path.join(fixture.root,'.prnext/assets',path.basename(module.browserModule)),'utf8');
        return source.includes('data-hydrated')&&source.includes('Edge action')?module.browserModule:null;
      }))).filter(Boolean);
      expect(candidates,'The hydration fixture must identify one emitted Client module').toHaveLength(1);
      client=candidates[0];
      const gate=new Promise(resolve=>{release=resolve});
      await page.route(new URL(client,server.url).href,async route=>{arrived=true;await gate;await route.continue();},{times:1});
    }
    // A held module may itself delay load/DOMContentLoaded. Observe the SSR
    // document before releasing it, without waiting on that same dependency.
    await page.goto(server.url,{waitUntil:delayedClient?'commit':'load'});
    const button=page.getByRole('button',{name:'Edge action',exact:true});
    if(delayedClient){
      await test.step('The fixture Client module reaches its held request',async()=>{
        await expect.poll(()=>arrived,{message:'Expected the browser to request '+client}).toBe(true);
      });
      await expect(page.getByRole('heading',{name:'Edge actions',exact:true})).toBeVisible();
      await expect(page.locator('#result')).toHaveText('initial');
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
