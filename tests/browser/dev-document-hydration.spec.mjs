import {test, expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';

const home = 'export default function Home(){return <main><h1>PRNext</h1><p>Edit <code>app/page.jsx</code> to get started.</p></main>}';
const layout = attributes => `export default function RootLayout({children}){return <html lang="en"><body ${attributes}>${'{children}'}</body></html>}`;
const hydrationLogs = page => {
  const messages = [];
  page.on('console', message => {if (['error','warning'].includes(message.type()) && /hydration-mismatch|Hydration failed|A tree hydrated/.test(message.text())) messages.push(message.text());});
  return messages;
};

// Reproduce ColorZilla's document-start attribute injection without installing
// an extension or changing the application. Its mock keyboard listener remains.
async function injectColorZilla(page, extraAttribute) {
  await page.addInitScript(extra => {
    const install = () => {
      if (!document.body) return false;
      document.body.setAttribute('cz-shortcut-listen','true');
      if (extra) document.body.setAttribute(extra,'browser');
      window.__czShortcutCalls = 0;
      window.addEventListener('keydown',event => {if(event.altKey && event.code==='KeyC') window.__czShortcutCalls++;});
      return true;
    };
    if (!install()) {const observer = new MutationObserver(() => {if(install()) observer.disconnect();});observer.observe(document,{childList:true,subtree:true});}
  }, extraAttribute);
}

test('a fresh dev page hydrates with ColorZilla and retains its marker and keyboard listener', async ({page}) => {
  const fixture = await devFixture({files:{'app/layout.jsx':layout(''),'app/page.jsx':home}});
  try {
    const logs = hydrationLogs(page);await injectColorZilla(page);
    for (let load = 0; load < 2; load++) {
      if (load) await page.reload();else await page.goto(fixture.url+'/docs/');
      await page.waitForFunction(() => window.__PRNEXT_DEV__?.confirmed===true);
      await expect(page.getByRole('heading',{name:'PRNext',exact:true})).toBeVisible();
      await expect(page.locator('body')).toHaveAttribute('cz-shortcut-listen','true');
      expect(await page.evaluate(() => window.__PRNEXT_DEV__.recoverableIssue)).toBeUndefined();
      await expect(page.locator('prnext-dev-tools').locator('.trigger')).toHaveAttribute('data-issue-severity','none');
      await page.keyboard.press('Alt+c');expect(await page.evaluate(() => window.__czShortcutCalls)).toBe(1);
    }
    expect(logs).toEqual([]);
  } finally {await fixture.close();}
});

test('an extension reinserting its marker while hydration is queued does not produce a warning', async ({page}) => {
  const fixture = await devFixture({files:{'app/layout.jsx':layout(''),'app/page.jsx':home}});
  try {
    const logs=hydrationLogs(page);
    await injectColorZilla(page);
    await page.addInitScript(()=>{
      const install=()=>{
        if(!document.body)return false;
        const body=document.body,marker='cz-shortcut-listen';
        const observer=new MutationObserver(()=>{
          if(!body.hasAttribute(marker)){
            observer.disconnect();
            // Extensions run after the framework's initial preparation too.
            queueMicrotask(()=>{body.setAttribute(marker,'true');window.__lateExtensionWrite=true;});
          }
        });
        observer.observe(body,{attributes:true,attributeFilter:[marker]});
        return true;
      };
      if(!install()){const observer=new MutationObserver(()=>{if(install())observer.disconnect();});observer.observe(document,{childList:true,subtree:true});}
    });
    await page.goto(fixture.url+'/docs/');
    await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
    expect(await page.evaluate(()=>window.__lateExtensionWrite)).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('cz-shortcut-listen','true');
    expect(await page.evaluate(()=>window.__PRNEXT_DEV__.recoverableIssue)).toBeUndefined();
    expect(logs).toEqual([]);
  } finally {await fixture.close();}
});

test('real attribute mismatches stay reported and the colored AI action preserves keyboard handoff', async ({page}) => {
  const fixture = await devFixture({files:{'app/layout.jsx':layout('data-app-label="server"'),'app/page.jsx':home}});
  try {
    const logs = hydrationLogs(page);await injectColorZilla(page,'data-app-label');await page.goto(fixture.url+'/docs/');
    await page.waitForFunction(() => window.__PRNEXT_DEV__?.confirmed===true && !!window.__PRNEXT_DEV__.recoverableIssue);
    expect(logs.join('\n')).toContain('data-app-label');expect(logs.join('\n')).not.toContain('cz-shortcut-listen');
    await expect(page.locator('body')).toHaveAttribute('cz-shortcut-listen','true');
    await fixture.connectAI();
    await expect.poll(() => page.evaluate(async () => (await window.__PRNEXT_DEV__.tools.refresh()).ai?.connected)).toBe(true);
    const host=page.locator('prnext-dev-tools');await host.getByRole('button',{name:/Open PRNext developer tools/}).click();await host.getByRole('button',{name:/View issues/}).click();
    const dialog=page.getByRole('alertdialog',{name:'PRNext development error'}),ai=dialog.getByRole('button',{name:'Send to AI',exact:true});
    await expect(ai).toBeVisible();expect(await ai.evaluate(node=>getComputedStyle(node).backgroundImage)).toBe('none');
    expect(await ai.evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(17, 17, 17)');
    const orbit=ai.locator('.error-ai-border');await expect(orbit).toHaveAttribute('aria-hidden','true');
    expect(await orbit.evaluate(node=>getComputedStyle(node,'::before').animationName)).not.toBe('none');
    const transform=await orbit.evaluate(node=>getComputedStyle(node,'::before').transform);
    await expect.poll(()=>orbit.evaluate(node=>getComputedStyle(node,'::before').transform)).not.toBe(transform);
    await page.emulateMedia({reducedMotion:'reduce'});expect(await ai.evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
    expect(await orbit.evaluate(node=>getComputedStyle(node,'::before').animationName)).toBe('none');
    await page.emulateMedia({forcedColors:'active'});expect(await ai.evaluate(node=>getComputedStyle(node).backgroundImage)).toBe('none');
    await expect(orbit).toBeHidden();
    await page.emulateMedia({forcedColors:'none'});
    for (let step=0;step<20&&!await ai.evaluate(node=>node===node.getRootNode().activeElement);step++) await page.keyboard.press('Tab');
    await expect(ai).toBeFocused();expect(await ai.evaluate(node=>node.matches(':focus-visible'))).toBe(true);expect(await ai.evaluate(node=>getComputedStyle(node).outlineWidth)).toBe('2px');
    await page.keyboard.press('Enter');await expect(dialog).toHaveCount(0);
    const panel=host.getByRole('dialog',{name:'Development inspector'});await expect(panel.getByRole('textbox',{name:'Instruction for your assistant'})).toBeFocused();
    expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context.error.message)).toContain('data-app-label');
  } finally {await fixture.close();}
});

test('a marker explicitly rendered by the application remains part of hydration', async ({page}) => {
  const fixture = await devFixture({files:{'app/layout.jsx':layout('cz-shortcut-listen="true"'),'app/page.jsx':home}});
  try {
    const logs=hydrationLogs(page);await page.goto(fixture.url+'/docs/');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
    await expect(page.locator('body')).toHaveAttribute('cz-shortcut-listen','true');
    expect(await page.evaluate(()=>window.__PRNEXT_DEV__.recoverableIssue)).toBeUndefined();expect(logs).toEqual([]);
  } finally {await fixture.close();}
});
