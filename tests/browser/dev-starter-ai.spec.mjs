import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';
import {starterPage,starterConnection,starterStyles} from '../../packages/prnext/build/starter-template.mjs';

test.describe('starter AI setup',()=>{
  test.setTimeout(90000);let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function start(page){
    fixture=await devFixture({files:{
      'app/app/page.jsx':starterPage('jsx'),
      'app/app/connect-ai.jsx':starterConnection(),
      'app/layout.jsx':'import "./starter.css";export default function Layout({children}){return <html><body>{children}</body></html>}',
      'app/starter.css':starterStyles,
    }});
    await page.goto(fixture.url+'/docs/app');
  }
  for(const width of [1440,390])test(`opens the real AI setup without navigation at ${width}px`,async({page,context})=>{
    await page.setViewportSize({width,height:900});await start(page);
    await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
    const original=page.url(),opened=[];page.on('popup',popup=>opened.push(popup));
    const link=page.getByRole('link',{name:'Connect AI',exact:true});await link.click();
    const panel=page.locator('prnext-dev-tools').getByRole('dialog',{name:'Development inspector',exact:true});
    await expect(panel).toBeVisible();await expect(panel).toContainText('Connect your assistant');
    await expect(panel.locator('button[data-panel=ai]')).toHaveAttribute('aria-current','page');
    expect(page.url()).toBe(original);expect(opened).toHaveLength(0);expect(context.pages()).toHaveLength(1);
    await panel.getByRole('button',{name:'Close inspector',exact:true}).click();await expect(link).toBeFocused();
  });
  test('keyboard setup restores hidden tools and returns focus to the starter',async({page})=>{
    await start(page);await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
    const host=page.locator('prnext-dev-tools');await host.locator('.trigger').click();await host.locator('#tools').getByRole('button',{name:'Hide until reload',exact:true}).click();
    await expect(host).toBeHidden();const link=page.getByRole('link',{name:'Connect AI',exact:true});await link.focus();await page.keyboard.press('Enter');
    const panel=host.getByRole('dialog',{name:'Development inspector',exact:true});await expect(panel).toBeVisible();await expect(host).toBeVisible();
    await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(link).toBeFocused();
  });
  test('without JavaScript the setup remains a normal documentation link',async({browser})=>{
    const context=await browser.newContext({javaScriptEnabled:false});
    try{const page=await context.newPage();await start(page);const link=page.getByRole('link',{name:'Connect AI',exact:true});
      await expect(link).toBeVisible();await expect(link).toHaveAttribute('href','https://github.com/Lorkydey/PRNext/blob/main/packages/prnext/docs/ai/troubleshooting.md#connect-the-existing-development-mcp');await expect(link).toHaveAttribute('target','_blank');
    }finally{await context.close();}
  });
});
