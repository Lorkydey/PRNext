import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';

test.describe('detached developer tools',()=>{
  test.setTimeout(90000);
  let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function openMenu(page){const host=page.locator('prnext-dev-tools');await host.getByRole('button',{name:/Open PRNext developer tools/}).click();return host;}
  async function popupFor(page,action){const opened=page.waitForEvent('popup');await action();return opened;}
  const dockOwners=new WeakMap();
  async function popupForDock(owner,action){
    // Observe the owner's retained Window reference without changing opening,
    // reverse-opener isolation or any pointer event.
    const token=await owner.evaluate(()=>{
      const token=crypto.randomUUID(),open=window.open;
      window.__restoreDockTestOpen=()=>{window.open=open;delete window.__restoreDockTestOpen;};
      window.open=function(...args){const child=Reflect.apply(open,this,args);if(child)(window.__dockTestWindows||=new Map()).set(token,child);return child;};
      return token;
    });
    try{const popup=await popupFor(owner,action);dockOwners.set(popup,{owner,token});return popup;}
    finally{if(!owner.isClosed())await owner.evaluate(()=>window.__restoreDockTestOpen?.());}
  }
  async function dockPopup(popup,button,label){
    const {owner,token}=dockOwners.get(popup);
    await owner.evaluate(({token,label})=>{
      const child=window.__dockTestWindows.get(token),shadow=child.document.querySelector('prnext-dev-window').shadowRoot;
      const target=[...shadow.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===label);
      if(!target)throw Error('The expected docking button is missing');
      const record={trusted:0};(window.__dockTestClicks||=new Map()).set(token,record);
      // This listener belongs to the parent realm, so its evidence survives the
      // popup closing synchronously in its own real click handler.
      target.addEventListener('click',event=>{if(event.isTrusted)record.trusted++;},{capture:true,once:true});
    },{token,label});
    const closed=popup.waitForEvent('close',{timeout:5000});void closed.catch(()=>{});
    let clickError;
    try{await button.click();}catch(error){clickError=error;}
    if(clickError&&!clickError.message.includes('Target page, context or browser has been closed'))throw clickError;
    await closed;
    expect(owner.isClosed()).toBe(false);expect(owner.context().browser().isConnected()).toBe(true);
    expect(await owner.evaluate(token=>window.__dockTestClicks.get(token).trusted,token)).toBe(1);
    expect(popup.isClosed()).toBe(true);
    await owner.evaluate(token=>{window.__dockTestWindows.delete(token);window.__dockTestClicks.delete(token);},token);
  }

  test('console popout follows live page logs, preserves filters, copies and docks back',async({page,context})=>{
    fixture=await devFixture();await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});
    await page.goto(fixture.url+'/docs/pages');await page.getByTestId('counter').click();
    const host=await openMenu(page);await host.getByRole('button',{name:'Client console',exact:true}).click();
    const inline=host.getByRole('dialog',{name:'Client console'});
    await inline.getByRole('searchbox').fill('matching');
    await inline.getByRole('button',{name:'Pause',exact:true}).click();
    const popup=await popupForDock(page,()=>inline.getByRole('button',{name:'Open console in new window'}).click());
    const panel=popup.getByRole('dialog',{name:'Client console'});await expect(panel).toBeVisible();await expect(inline).toBeHidden();
    expect(await popup.evaluate(()=>opener)).toBeNull();await expect(panel.getByRole('searchbox')).toHaveValue('matching');
    const resume=panel.getByRole('button',{name:'Resume',exact:true});await expect(resume).toHaveText('');await expect(resume).toHaveAttribute('aria-pressed','true');await resume.click();
    await page.evaluate(()=>{console.log('matching live output');console.warn('other output');});
    await expect(panel.getByRole('region',{name:'Console messages'})).toContainText('matching live output');await expect(panel.getByRole('region')).not.toContainText('other output');
    await popup.bringToFront();await panel.getByRole('button',{name:'Copy visible logs'}).click();
    await expect(panel.getByRole('button',{name:'Copy visible logs'})).toHaveText('Copied');
    expect(await popup.evaluate(()=>navigator.clipboard.readText())).toContain('matching live output');
    await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await openMenu(page);await host.getByRole('button',{name:'Open console in new window',exact:true}).click();expect(context.pages()).toHaveLength(2);
    await panel.getByRole('button',{name:'Pause',exact:true}).click();
    await dockPopup(popup,panel.getByRole('button',{name:'Dock console'}),'Dock console');
    await expect(inline).toBeVisible();await expect(inline.getByRole('searchbox')).toHaveValue('matching');await expect(inline).toContainText('matching live output');
    await expect(inline.getByRole('button',{name:'Resume',exact:true})).toHaveAttribute('aria-pressed','true');await inline.getByRole('button',{name:'Resume',exact:true}).click();
  });

  test('shared popout remembers the selected device, with real viewports, rotation, live console and docking',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/app');
    const host=await openMenu(page);
    const devices=host.getByRole('group',{name:'Preview device'});
    await expect(devices.getByRole('button')).toHaveCount(4);
    await expect(devices.getByRole('button',{name:'Open device preview in new window',exact:true})).toHaveCount(1);
    await devices.getByRole('button',{name:'Phone',exact:true}).click();
    const inline=host.getByRole('dialog',{name:'Device preview'});
    await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();
    expect(await page.frameLocator('prnext-dev-tools iframe').locator('body').evaluate(()=>innerWidth)).toBe(390);
    await inline.getByRole('button',{name:'Tablet',exact:true}).click();
    await inline.getByRole('button',{name:'Close device preview'}).click();
    await openMenu(page);await expect(devices.getByRole('button',{name:'Tablet',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(devices.getByRole('button',{name:'Open device preview in new window',exact:true})).toHaveAttribute('title','Open tablet in new window');
    const popup=await popupForDock(page,()=>devices.getByRole('button',{name:'Open device preview in new window',exact:true}).click());
    const preview=popup.getByRole('dialog',{name:'Device preview'}),frame=popup.frameLocator('prnext-dev-window iframe');
    await expect(frame.getByTestId('counter')).toBeVisible();expect(await frame.locator('body').evaluate(()=>innerWidth)).toBe(768);
    await preview.getByRole('button',{name:'Phone',exact:true}).click();expect(await frame.locator('body').evaluate(()=>innerWidth)).toBe(390);
    await expect(frame.locator('prnext-dev-tools')).toHaveCount(0);await expect(host.getByRole('dialog',{name:'Device preview'})).not.toBeVisible();
    await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await preview.getByRole('button',{name:'Rotate',exact:true}).click();expect(await frame.locator('body').evaluate(()=>innerWidth)).toBe(844);
    await preview.getByRole('button',{name:'Console',exact:true}).click();await frame.locator('body').evaluate(()=>console.log('detached preview log'));
    await expect(preview.getByRole('region',{name:'Console messages'})).toContainText('detached preview log');
    await dockPopup(popup,preview.getByRole('button',{name:'Dock device preview'}),'Dock device preview');
    const embedded=host.getByRole('dialog',{name:'Device preview'});await expect(embedded).toBeVisible();
    await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();
    expect(await page.frameLocator('prnext-dev-tools iframe').locator('body').evaluate(()=>innerWidth)).toBe(844);
    await embedded.getByRole('button',{name:'Close device preview'}).click();await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await openMenu(page);await expect(devices.getByRole('button',{name:'Phone',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(devices.getByRole('button',{name:'Open device preview in new window',exact:true})).toHaveAttribute('title','Open phone in new window');
  });

  test('embedded preview can detach and its nested console closes with its owner window',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');const host=await openMenu(page);await host.getByRole('button',{name:'Tablet',exact:true}).click();
    const embedded=host.getByRole('dialog',{name:'Device preview'});await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();
    const popup=await popupFor(page,()=>embedded.getByRole('button',{name:'Open device preview in new window'}).click());
    const preview=popup.getByRole('dialog',{name:'Device preview'});await expect(embedded).not.toBeVisible();await expect(popup.frameLocator('prnext-dev-window iframe').getByTestId('counter')).toBeVisible();
    await preview.getByRole('button',{name:'Console',exact:true}).click();
    const terminal=await popupFor(popup,()=>preview.getByRole('dialog',{name:'Client console'}).getByRole('button',{name:'Open console in new window',exact:true}).click());
    await expect(terminal.getByRole('dialog',{name:'Client console'})).toBeVisible();
    await popup.frameLocator('prnext-dev-window iframe').locator('body').evaluate(()=>console.warn('child popup warning'));
    await expect(terminal.getByRole('region',{name:'Console messages'})).toContainText('child popup warning');
    await popup.close();await expect.poll(()=>terminal.isClosed()).toBe(true);await expect(page.getByTestId('counter')).toBeVisible();
    await openMenu(page);await host.getByRole('button',{name:'Client console',exact:true}).click();await expect(host.getByRole('dialog',{name:'Client console'})).toBeVisible();
  });

  test('blocked popups give feedback and the embedded tools remain usable',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');await page.evaluate(()=>{window.open=()=>null;});
    const host=await openMenu(page);await host.getByRole('button',{name:'Open console in new window',exact:true}).click();
    await expect(host.getByRole('status').filter({hasText:'Popup blocked'})).toBeVisible();
    await page.evaluate(()=>console.log('still works'));await expect(host.getByRole('region',{name:'Console messages'})).toContainText('still works');
    await openMenu(page);await host.getByRole('button',{name:'Phone',exact:true}).click();await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();
    const preview=host.getByRole('dialog',{name:'Device preview'});await preview.getByRole('button',{name:'Open device preview in new window'}).click();await expect(preview.getByRole('status').filter({hasText:'Popup blocked'})).toBeVisible();await expect(preview).toBeVisible();
  });

  test('closing a popup permits reopening; source reload closes owned tool windows',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');const host=await openMenu(page);
    const popup=await popupFor(page,()=>host.getByRole('button',{name:'Open console in new window',exact:true}).click());await expect(popup.getByRole('dialog',{name:'Client console'})).toBeVisible();await popup.close();
    await openMenu(page);const second=await popupFor(page,()=>host.getByRole('button',{name:'Open console in new window',exact:true}).click());await expect(second.getByRole('dialog',{name:'Client console'})).toBeVisible();
    await page.reload();await expect.poll(()=>second.isClosed()).toBe(true);await expect(host.getByRole('button',{name:/Open PRNext developer tools/})).toBeVisible();
  });

  test('desktop opens a normal independent application window and icons work from the keyboard',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');await page.getByTestId('counter').click();const host=await openMenu(page);
    await host.getByRole('button',{name:'Client console',exact:true}).click();
    await host.getByRole('button',{name:'Close console',exact:true}).click();
    await openMenu(page);
    const devices=host.getByRole('group',{name:'Preview device'});
    await expect(devices.getByRole('button')).toHaveCount(4);await expect(devices.getByRole('button',{name:'Desktop',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(devices.locator('.detach')).toHaveCount(1);
    const icon=devices.getByRole('button',{name:'Open device preview in new window',exact:true});await icon.focus();
    const popup=await popupFor(page,()=>page.keyboard.press('Enter'));
    await expect(popup.getByTestId('counter')).toHaveText('Original 0');await expect(page.getByTestId('counter')).toHaveText('Original 1');expect(await popup.evaluate(()=>opener)).toBeNull();
    await expect(popup.locator('prnext-dev-tools')).toHaveCount(1);await popup.close();
  });
});
