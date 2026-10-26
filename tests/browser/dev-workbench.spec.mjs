import {test,expect} from '@playwright/test';
import {devFixture,counterSource} from '../dev-fixture.mjs';

test.describe('development viewport and client console',()=>{
  test.setTimeout(90000);
  let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function menu(page){const host=page.locator('prnext-dev-tools');await host.getByRole('button',{name:/Open PRNext developer tools/}).click();return host;}

  for(const router of ['pages','app'])test(`${router} viewport applies real media queries, rotates without reloading and preserves original state`,async({page})=>{
    fixture=await devFixture(); await page.goto(fixture.url+'/docs/'+router);
    await page.getByTestId('counter').click();
    const host=await menu(page);await host.getByRole('button',{name:'Phone',exact:true}).click();
    const preview=host.getByRole('dialog',{name:'Device preview'});
    await expect(preview).toBeVisible();
    const frame=page.frameLocator('prnext-dev-tools iframe');
    await expect(frame.getByTestId('counter')).toHaveText('Original 0');
    await expect(frame.locator('prnext-dev-tools')).toHaveCount(0);
    expect(await frame.locator('body').evaluate(()=>({width:innerWidth,mobile:matchMedia('(max-width:500px)').matches}))).toEqual({width:390,mobile:true});
    await frame.getByTestId('counter').click();
    await preview.getByRole('button',{name:'Tablet',exact:true}).click();
    expect(await frame.locator('body').evaluate(()=>innerWidth)).toBe(768);
    await expect(frame.getByTestId('counter')).toHaveText('Original 1');
    await preview.getByRole('button',{name:'Rotate',exact:true}).click();
    expect(await frame.locator('body').evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual({width:1024,height:768});
    await fixture.write('components/Counter.jsx',counterSource('Preview refreshed'));
    await expect(frame.getByTestId('counter')).toHaveText('Preview refreshed 1',{timeout:25000});
    await preview.getByRole('button',{name:'Desktop',exact:true}).click();
    await expect(preview.getByRole('button',{name:'Desktop',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(frame.getByTestId('counter')).toHaveText('Preview refreshed 1');
    await preview.getByRole('button',{name:'Close device preview'}).click();
    await expect(preview).not.toBeVisible();await expect(host.locator('iframe')).toHaveCount(0);
    await expect(page.getByTestId('counter')).toHaveText('Preview refreshed 1',{timeout:25000});
    await expect(host.getByRole('button',{name:/Open PRNext developer tools/})).toBeFocused();
  });

  test('console Escape preserves focused-tooltip dismissal but ignores unrelated hovered tooltips',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');
    const host=await menu(page);await host.getByRole('button',{name:'Client console',exact:true}).click();
    const panel=host.getByRole('dialog',{name:'Client console'}),pause=panel.getByRole('button',{name:'Pause',exact:true}),search=panel.getByRole('searchbox'),tooltip=host.getByRole('tooltip');
    await pause.hover();await pause.focus();await expect(tooltip).toBeVisible();await expect(pause).toBeFocused();
    await page.keyboard.press('Escape');await expect(tooltip).toBeHidden();await expect(panel).toBeVisible();await expect(pause).toBeFocused();
    await page.mouse.move(0,0);await pause.hover();await expect(tooltip).toBeVisible();
    await search.focus();await expect(search).toBeFocused();
    await page.keyboard.press('Escape');await expect(tooltip).toBeHidden();await expect(panel).toBeHidden();
    await expect(host.getByRole('button',{name:/Open PRNext developer tools/})).toBeFocused();
  });

  test('console records early/native messages, filters, pauses, clears, copies and survives refresh',async({page,context})=>{
    fixture=await devFixture({files:{'components/Counter.jsx':counterSource()+"\nconsole.info('module-loaded');"}});
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});
    const native=[];page.on('console',entry=>native.push(entry.text()));
    await page.goto(fixture.url+'/docs/pages');
    await page.evaluate(()=>{console.log('hello',{count:2});console.warn('warning-example');console.error('error-example');});
    const host=await menu(page);await host.getByRole('button',{name:'Client console',exact:true}).click();
    const panel=host.getByRole('dialog',{name:'Client console'}),logs=panel.getByRole('region',{name:'Console messages'});
    await panel.getByRole('combobox',{name:'Console source'}).selectOption('browser');
    await expect(logs).toContainText('module-loaded');await expect(logs).toContainText('hello {count: 2}');
    await expect(panel.locator('.wb-foot')).toContainText('1 error · 1 warning');expect(native.some(line=>line.includes('warning-example'))).toBe(true);
    await panel.getByRole('combobox',{name:'Console level'}).selectOption('error');await expect(logs).toContainText('error-example');await expect(logs).not.toContainText('hello');
    await panel.getByRole('button',{name:'Copy visible logs'}).click();
    await expect(panel.getByRole('button',{name:'Copy visible logs'})).toHaveText('Copied');
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('error-example');
    await panel.getByRole('combobox',{name:'Console level'}).selectOption('all');
    await panel.getByRole('searchbox',{name:'Filter console messages'}).fill('warning-example');await expect(logs).toContainText('warning-example');await expect(logs).not.toContainText('error-example');
    await panel.getByRole('searchbox').fill('');const pause=panel.getByRole('button',{name:'Pause',exact:true});
    await expect(pause).toHaveText('');await expect(pause.locator('svg')).toHaveCount(2);await pause.click();
    await expect(panel.getByRole('button',{name:'Resume',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.evaluate(()=>console.info('after-pause'));await expect(logs).not.toContainText('after-pause');
    await panel.getByRole('button',{name:'Resume',exact:true}).click();await expect(logs).toContainText('after-pause');
    await fixture.write('components/Counter.jsx',counterSource('Console refreshed'));
    await expect(page.getByTestId('counter')).toHaveText('Console refreshed 0',{timeout:25000});await expect(logs).toContainText('hello');
    await page.evaluate(()=>{const a={value:'<img src=x onerror=alert(1)>'};a.self=a;console.log(a);});await expect(logs).toContainText('[Circular]');await expect(logs.locator('img')).toHaveCount(0);
    await panel.getByRole('button',{name:'Clear',exact:true}).click();await expect(logs).toContainText('No client messages yet');await expect(panel.locator('.wb-foot')).toContainText('0 errors');
    await host.getByRole('button',{name:/Open PRNext developer tools/}).click();
    const menuPanel=host.getByRole('dialog',{name:'PRNext developer tools'});await expect(menuPanel).toBeVisible();
    await menuPanel.getByRole('button',{name:'Tablet',exact:true}).click();
    const preview=host.getByRole('dialog',{name:'Device preview'});await expect(preview).toBeVisible();
    await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();
    await preview.getByRole('button',{name:'Close device preview'}).click();await expect(panel).toBeVisible();
    await panel.getByRole('searchbox').focus();await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(host.getByRole('button',{name:/Open PRNext developer tools/})).toBeFocused();
  });

  test('preview console follows the child context, captures unhandled errors and cleans up on close',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/app');
    await page.evaluate(()=>console.warn('parent-only'));
    const host=await menu(page);await host.getByRole('button',{name:'Phone',exact:true}).click();
    const preview=host.getByRole('dialog',{name:'Device preview'}),frame=page.frameLocator('prnext-dev-tools iframe');
    await expect(frame.getByTestId('counter')).toBeVisible();
    await preview.getByRole('button',{name:'Console',exact:true}).click();
    const panel=preview.getByRole('dialog',{name:'Client console'}),logs=panel.getByRole('region',{name:'Console messages'});
    await expect(panel.locator('.wb-head')).toHaveText('Client console');
    await frame.getByTestId('counter').click();await expect(frame.getByTestId('counter')).toHaveText('Original 1');
    await frame.locator('body').evaluate(()=>{console.log('child-only');setTimeout(()=>{throw new Error('child-runtime-failure');},0);});
    await expect(logs).toContainText('child-runtime-failure');await expect(logs).toContainText('child-only');await expect(logs).not.toContainText('parent-only');
    await expect(logs).toContainText('at ');
    await expect(frame.getByRole('alertdialog')).toContainText('child-runtime-failure');
    await frame.getByRole('button',{name:'Dismiss',exact:true}).click();
    await expect(frame.getByTestId('counter')).toHaveText('Original 1');await expect(logs).toContainText('child-only');
    await frame.locator('body').evaluate(()=>{void Promise.reject(new Error('child-rejection'));});
    await expect(logs).toContainText('Unhandled rejection:');await expect(logs).toContainText('child-rejection');
    await expect(panel.locator('.wb-foot')).toContainText('2 errors');
    await frame.getByRole('button',{name:'Dismiss',exact:true}).click();
    await preview.getByRole('button',{name:'Close device preview'}).click();
    const standalone=host.getByRole('dialog',{name:'Client console'});await expect(standalone).toBeVisible();await expect(standalone).toContainText('parent-only');await expect(standalone).not.toContainText('child-only');
    await expect(host.locator('iframe')).toHaveCount(0);
  });

  test('small screens and keyboard can reach and close both tools with reduced motion',async({page})=>{
    fixture=await devFixture();await page.setViewportSize({width:320,height:568});await page.emulateMedia({reducedMotion:'reduce'});await page.goto(fixture.url+'/docs/pages');
    const host=await menu(page);const phone=host.getByRole('button',{name:'Phone',exact:true});await phone.focus();await page.keyboard.press('Enter');
    const preview=host.getByRole('dialog',{name:'Device preview'});await expect(preview).toBeVisible();
    const frame=page.frameLocator('prnext-dev-tools iframe');await expect(frame.getByTestId('counter')).toBeVisible();
    const rect=await preview.boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(320);expect(rect.y+rect.height).toBeLessThanOrEqual(568);
    await preview.getByRole('button',{name:'Console',exact:true}).click();const panel=preview.getByRole('dialog',{name:'Client console'});
    await expect(panel.getByRole('searchbox')).toBeFocused();await page.keyboard.press('Escape');await expect(panel).toBeHidden();
    await expect(preview.getByRole('button',{name:'Console',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(preview).not.toBeVisible();
    await expect(host.getByRole('button',{name:/Open PRNext developer tools/})).toBeFocused();
  });

  test('blocked embedding stays closable and reports unavailable preview',async({page})=>{
    fixture=await devFixture();
    await page.route('**/docs/pages',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'x-frame-options':'DENY'}});});
    await page.goto(fixture.url+'/docs/pages');
    const host=await menu(page);await host.getByRole('button',{name:'Phone',exact:true}).click();
    const preview=host.getByRole('dialog',{name:'Device preview'});await expect(preview.locator('.wb-preview-note')).toContainText('Preview unavailable',{timeout:20000});
    await preview.getByRole('button',{name:'Close device preview'}).click();await expect(preview).not.toBeVisible();await expect(page.getByTestId('counter')).toBeVisible();
  });
});
