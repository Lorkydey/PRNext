import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';

test.describe('compact device canvas and AI console copying',()=>{
  test.setTimeout(90000);let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function menu(page){const host=page.locator('prnext-dev-tools');await host.getByRole('button',{name:/Open PRNext developer tools/}).click();return host;}
  async function consolePanel(page){const host=await menu(page);await host.getByRole('button',{name:'Client console',exact:true}).click();return host.getByRole('dialog',{name:'Client console'});}

  test('clicking a message exposes complete copying, retains focus on new logs and supports keyboard',async({page,context})=>{
    fixture=await devFixture();await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});await page.goto(fixture.url+'/docs/pages');
    const text='Full message start\n'+ 'line content '.repeat(3000)+'\nFull message end';
    await page.evaluate(value=>{console.clear();console.error(value);},text);
    const panel=await consolePanel(page),row=panel.locator('.wb-entry').filter({hasText:'Full message start'});
    await row.locator('summary').focus();await page.keyboard.press('Enter');await expect(row).toHaveAttribute('open','');
    const copy=row.getByRole('button',{name:'Copy message',exact:true});await copy.click();await expect(copy).toHaveAttribute('data-copy-state','copied');expect((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')).toBe(text);
    await copy.focus();await page.evaluate(()=>console.info('new line while reading'));
    await expect(panel).toContainText('new line while reading');await expect(copy).toBeFocused();await expect(row).toHaveAttribute('open','');
    const ai=row.getByRole('button',{name:'Copy for AI',exact:true});await ai.click();await expect(ai).toHaveAttribute('data-copy-state','copied');
    const prompt=(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n');expect(prompt).toContain(text);expect(prompt).toContain('Investigate the client message below');
    await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('denied');};});await copy.click();await expect(copy).toHaveAttribute('data-copy-state','failed');await expect(panel.getByRole('status')).toContainText('Clipboard access unavailable');
  });

  test('AI menu copies every retained error despite filters/pause, deduplicates and omits query secrets',async({page,context})=>{
    fixture=await devFixture();await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});await page.goto(fixture.url+'/docs/pages?token=private-secret#hidden');
    await page.evaluate(()=>{console.clear();console.error('First error\n at first.tsx:3');console.error('First error\n at first.tsx:3');console.error('Second error\n at second.tsx:5');console.info('visible-only-log');});
    const panel=await consolePanel(page);await panel.getByRole('searchbox').fill('visible-only-log');
    await panel.getByRole('button',{name:'Pause',exact:true}).click();await page.evaluate(()=>console.error('New error while paused'));
    const toggle=panel.getByRole('button',{name:'AI copy options',exact:true});await toggle.focus();await page.keyboard.press('ArrowDown');
    const options=panel.getByRole('menu',{name:'AI copy options'});await expect(options).toBeVisible();
    const errors=options.getByRole('menuitem',{name:'Copy errors for AI',exact:true});await expect(errors).toBeFocused();await page.keyboard.press('Enter');
    await expect(toggle).toBeFocused();await expect(options).toBeHidden();await expect(panel.getByRole('button',{name:'Copy for AI',exact:true})).toHaveAttribute('data-copy-state','copied');
    const prompt=(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n');expect(prompt).toMatch(/^Fix all errors below\./);expect(prompt).toContain('First error\n at first.tsx:3');expect(prompt).toContain('Second error');expect(prompt).toContain('New error while paused');expect(prompt).toContain('2 occurrences');expect(prompt).toContain('4 (3 unique)');expect(prompt).not.toContain('visible-only-log');expect(prompt).not.toContain('private-secret');expect(prompt).not.toContain('#hidden');
    await panel.getByRole('button',{name:'Copy for AI',exact:true}).click();await expect(panel.getByRole('button',{name:'Copy for AI',exact:true})).toHaveAttribute('data-copy-state','copied');const visible=await page.evaluate(()=>navigator.clipboard.readText());expect(visible).toContain('visible-only-log');expect(visible).not.toContain('First error');
    await toggle.click();await page.keyboard.press('ArrowDown');await expect(options.getByRole('menuitem',{name:'Copy visible logs for AI'})).toBeFocused();await page.keyboard.press('Escape');await expect(toggle).toBeFocused();await expect(panel).toBeVisible();
    await toggle.click();await page.keyboard.press('Tab');await expect(panel.getByRole('region',{name:'Console messages'})).toBeFocused();await expect(options).toBeHidden();
    await panel.getByRole('button',{name:'Clear',exact:true}).click();await toggle.click();await expect(options.getByRole('menuitem',{name:'Copy errors for AI'})).toBeDisabled();
  });

  test('icon devices show widths and the canvas resizes with pointer and keyboard without reload',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/app');const host=await menu(page);await host.getByRole('button',{name:'Phone',exact:true}).click();
    const preview=host.getByRole('dialog',{name:'Device preview'}),frame=page.frameLocator('prnext-dev-tools iframe');await expect(frame.getByTestId('counter')).toBeVisible();await frame.getByTestId('counter').click();
    const tablet=preview.getByRole('button',{name:'Tablet',exact:true});await expect(tablet.locator('svg')).toHaveCount(1);await expect(tablet).toHaveAttribute('data-wb-tooltip-detail','768 × 1024');await tablet.click();await expect(tablet).toHaveAttribute('aria-pressed','true');
    const handle=preview.getByRole('slider',{name:'Preview width'});await handle.focus();await page.keyboard.press('ArrowRight');await expect(handle).toHaveAttribute('aria-valuenow','778');expect(await frame.locator('body').evaluate(()=>innerWidth)).toBe(778);
    const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2-50,box.y+box.height/2);await page.mouse.up();
    expect(Number(await handle.getAttribute('aria-valuenow'))).toBeLessThan(778);await expect(frame.getByTestId('counter')).toHaveText('Original 1');
    await preview.getByRole('button',{name:'Desktop',exact:true}).click();await expect(preview).toBeVisible();await expect(preview.getByRole('button',{name:'Desktop',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(frame.getByTestId('counter')).toHaveText('Original 1');const bounds=await preview.locator('.wb-frame-wrap').boundingBox(),canvas=await preview.locator('.wb-stage').boundingBox();expect(Math.abs(bounds.x+bounds.width/2-canvas.x-canvas.width/2)).toBeLessThanOrEqual(1);
    await preview.getByRole('button',{name:'Reload preview'}).click();await expect(frame.getByTestId('counter')).toHaveText('Original 0');
  });

  test('AI menus and message actions remain inside a small detached console',async({page,context})=>{
    fixture=await devFixture();await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});await page.goto(fixture.url+'/docs/app');await page.evaluate(()=>console.error('detached error'));
    const host=await menu(page),opened=page.waitForEvent('popup');await host.getByRole('button',{name:'Open console in new window',exact:true}).click();const popup=await opened;await popup.setViewportSize({width:320,height:568});
    const panel=popup.getByRole('dialog',{name:'Client console'});await expect(panel).toContainText('detached error');await panel.getByRole('button',{name:'AI copy options',exact:true}).click();
    const options=panel.getByRole('menu');await expect(options).toBeVisible();const box=await options.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);expect(box.y+box.height).toBeLessThanOrEqual(568);
    await options.getByRole('menuitem',{name:'Copy errors for AI'}).click();await expect(panel.getByRole('button',{name:'Copy for AI',exact:true})).toHaveAttribute('data-copy-state','copied');expect(await popup.evaluate(()=>navigator.clipboard.readText())).toContain('detached error');
    expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await panel.getByRole('button',{name:'AI copy options',exact:true}).click();await popup.close();await expect(page.getByTestId('counter')).toBeVisible();
  });
});
