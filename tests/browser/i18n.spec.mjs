import {test,expect} from '@playwright/test';
import {i18nFixture} from '../i18n-fixture.mjs';
import {startServer} from '../support.mjs';
test('Pages locale navigation preserves App state and unprefixed router paths',async({page})=>{
  const f=await i18nFixture();let server;const errors=[];let documents=0;
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.resourceType()==='document')documents++});
  try{
    await f.build();server=await startServer(f.root);await page.goto(server.url);
    await page.getByRole('button',{name:'count 0'}).click();
    await page.getByRole('link',{name:'French'}).click();await expect(page.getByRole('heading')).toHaveText('Home fr');
    await expect(page.locator('#path')).toHaveText('/');await expect(page.getByRole('button',{name:'count 1'})).toBeVisible();
    await page.getByRole('link',{name:'Article',exact:true}).click();await expect(page.getByRole('heading')).toHaveText('Article fr one');
    await expect(page.locator('#route')).toHaveText('/article/[id]');await expect(page.locator('#path')).toHaveText('/article/one');
    await page.getByRole('link',{name:'Home',exact:true}).click();await page.getByRole('link',{name:'English'}).click();await expect(page.getByRole('heading')).toHaveText('Home en');
    expect(documents).toBe(1);expect(errors).toEqual([]);
  }finally{await server?.close();await f.remove()}
});
