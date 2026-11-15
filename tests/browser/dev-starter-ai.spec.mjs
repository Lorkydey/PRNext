import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';
import {starterPage,starterConnection,starterStyles} from '../../packages/prnext/build/starter-template.mjs';

test.describe('starter AI setup',()=>{
  test.setTimeout(90000);let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function start(page){
    fixture=await devFixture({files:{
      'app/page.jsx':starterPage(),
      'app/connect-ai.jsx':starterConnection('jsx'),
      'app/layout.jsx':'import "./starter.css";export default function Layout({children}){return <html><body>{children}</body></html>}',
      'app/starter.css':starterStyles,
    }});
    await page.goto(fixture.url+'/docs');
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
      await expect(page.getByRole('button',{name:'Open app/page.jsx in your editor',exact:true})).toBeDisabled();
    }finally{await context.close();}
  });
  test('the filename requests a validated editor link and the AI accent respects motion preferences',async({page})=>{
    await page.addInitScript(()=>{
      window.__starterEditorLinks=[];const click=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(...args){
        if(/^(vscode|cursor):\/\/file\//.test(this.href)){window.__starterEditorLinks.push(this.href);return;}
        return click.apply(this,args);
      };
    });
    await start(page);await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
    const file=page.getByRole('button',{name:'Open app/page.jsx in your editor',exact:true});await expect(file).toBeEnabled();await file.click();
    await expect.poll(()=>page.evaluate(()=>window.__starterEditorLinks.length)).toBe(1);
    const link=await page.evaluate(()=>window.__starterEditorLinks[0]);expect(decodeURIComponent(link)).toContain(fixture.root.replaceAll('\\','/'));expect(decodeURIComponent(link)).toMatch(/\/app\/page\.jsx:1:1$/);
    await file.focus();await page.keyboard.press('Enter');await expect.poll(()=>page.evaluate(()=>window.__starterEditorLinks.length)).toBe(2);
    const connect=page.getByRole('link',{name:'Connect AI',exact:true}),orbit=connect.locator('.starter-ai-border');
    await expect(connect).toHaveCSS('background-color','rgb(17, 17, 17)');
    expect(await orbit.evaluate(node=>getComputedStyle(node,'::before').animationName)).toBe('starter-ai-orbit');
    await page.emulateMedia({reducedMotion:'reduce'});expect(await orbit.evaluate(node=>getComputedStyle(node,'::before').animationName)).toBe('none');
    await page.emulateMedia({forcedColors:'active'});await expect(orbit).toBeHidden();await expect(connect).toBeVisible();
  });
});
