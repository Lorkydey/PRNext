import { test, expect } from '@playwright/test';
import { devFixture, counterSource } from '../dev-fixture.mjs';

test.describe('local development inspector', () => {
  test.setTimeout(120000); let fixture;
  test.afterEach(async () => { await fixture?.close(); fixture = undefined; });
  async function inspect(page, tab) {
    const host = page.locator('prnext-dev-tools');
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await host.getByRole('button', { name: 'Inspect', exact: true }).click();
    const panel = host.getByRole('dialog', { name: 'Development inspector' });
    await expect(panel).toBeVisible(); if (tab) await panel.getByRole('button', { name: tab, exact: true }).click();
    return { host, panel };
  }
  async function connectAI(page) {
    const assistant=await fixture.connectAI();
    await expect.poll(async()=>page.evaluate(async()=>(await window.__PRNEXT_DEV__.tools.refresh()).ai?.connected)).toBe(true);
    return assistant;
  }
  async function startPicker(page) {
    await page.locator('prnext-dev-tools').getByRole('button',{name:'Select element for AI'}).click();
    await expect(page.locator('prnext-dev-picker')).toBeVisible();
  }

  test('compact error dialogs preserve full diagnostics, keyboard focus and the AI handoff',async({page,context})=>{
    let message='event refresh failure: '+'complete runtime context '.repeat(160)+' <img src=x onerror=alert(1)> COMPLETE_ERROR_END';
    fixture=await devFixture({files:{'components/Counter.jsx':counterSource('Overlay runtime',{eventError:true}).replace('event refresh failure',message)}});await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});await page.setViewportSize({width:320,height:720});await page.emulateMedia({reducedMotion:'reduce'});await page.goto(fixture.url+'/docs/app?token=private-query#private-fragment');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);await connectAI(page);
    const counter=page.getByTestId('counter');await counter.click();const dialog=page.getByRole('alertdialog',{name:'PRNext development error'}),dismiss=dialog.getByRole('button',{name:'Dismiss',exact:true});await expect(dialog).toBeVisible();expect(await dialog.evaluate(node=>node.tagName==='DIALOG'&&node.open&&node.matches(':modal'))).toBe(true);await expect(dismiss).toBeFocused();await expect(dialog.locator('#error-title')).toHaveText('Runtime error');await expect(dialog.locator('#error-summary')).toContainText('event refresh failure');expect(await dialog.locator('#error-summary').textContent()).not.toContain('COMPLETE_ERROR_END');await expect(dialog.locator('#message-disclosure')).toHaveJSProperty('open',false);await expect(dialog.locator('#stack-disclosure')).toHaveJSProperty('open',false);await expect(dialog.locator('#message')).toBeHidden();await expect(dialog.locator('#details')).toBeHidden();expect(await dialog.evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(0);for(let index=0;index<7;index++){await page.keyboard.press('Tab');expect(await dialog.evaluate(node=>getComputedStyle(node).outlineStyle)).toBe('none');}await dismiss.focus();
    await expect(dialog.locator('#error-details')).toBeHidden();const disclosureRow=dialog.locator('.error-row[aria-pressed=true]');await expect(disclosureRow).toHaveAttribute('aria-expanded','false');await disclosureRow.focus();await page.keyboard.press('Enter');await expect(disclosureRow).toHaveAttribute('aria-expanded','true');await expect(dialog.locator('#error-details')).toBeVisible();await dialog.locator('#error-title').click();await expect(dialog.locator('#error-details')).toBeHidden();await expect(disclosureRow).toBeFocused();await page.keyboard.press('Space');await expect(dialog.locator('#error-details')).toBeVisible();await dismiss.focus();await expect(dialog.locator('#source-location')).toContainText('components/Counter.jsx:',{timeout:15000});await expect(dialog.locator('#source-frame')).toBeVisible();await expect(dialog.locator('#source-frame')).toContainText('event refresh failure');const editor=dialog.getByRole('link',{name:'Open in editor'});await expect(editor).toHaveAttribute('href',/^vscode:\/\/file\//);await expect(dismiss).toBeFocused();await editor.evaluate(node=>node.addEventListener('click',event=>{window.__clickedEditorLink=node.href;event.preventDefault();},{once:true}));await editor.click();expect(await page.evaluate(()=>window.__clickedEditorLink)).toMatch(/^vscode:\/\/file\//);await expect(dialog).toBeVisible();
    await expect(dialog.locator('img[src="x"]')).toHaveCount(0);await dialog.getByRole('button',{name:'Copy for AI',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText().then(text=>text.replace(/\r\n/g,'\n')))).toContain(message);const copied=await page.evaluate(()=>navigator.clipboard.readText().then(text=>text.replace(/\r\n/g,'\n')));expect(copied.startsWith('Fix all errors below.')).toBe(true);expect(copied).toContain('/docs/app');expect(copied).not.toContain('private-query');expect(copied).not.toContain('private-fragment');expect(copied).not.toContain('Bearer ');expect(copied.length).toBeLessThanOrEqual(512*1024);await expect(dialog.locator('img[src="x"]')).toHaveCount(0);
    await page.evaluate(()=>{const original=navigator.clipboard.writeText;navigator.clipboard.writeText=()=>Promise.reject(new DOMException('Clipboard permission denied','NotAllowedError'));window.__restoreOverlayClipboard=()=>{navigator.clipboard.writeText=original;};});try{await dialog.locator('#copy-for-ai').click();await expect(dialog.locator('#error-copy-status')).toHaveText('Could not copy for AI.');await expect(dialog.getByRole('group',{name:'Errors',exact:true}).getByRole('button')).toHaveCount(1);}finally{await page.evaluate(()=>window.__restoreOverlayClipboard());}
    const remap=page.waitForRequest(request=>request.url().endsWith('/v1/tools/dev_source')&&request.postDataJSON()?.error?.message.endsWith('REUSED_ERROR')&&request.postDataJSON()?.stack.endsWith('PRNEXT_REUSED_ERROR_SOURCE_CHECK'));message+=' REUSED_ERROR';await page.evaluate(()=>{const error=window.__PRNEXT_DEV__.issue;window.__reusedOverlayError=error;const previous=error.message;error.message+=' REUSED_ERROR';error.stack=error.stack.replace(previous,error.message)+'\nPRNEXT_REUSED_ERROR_SOURCE_CHECK';window.__PRNEXT_DEV__.reportError(error);});await remap;expect(await page.evaluate(()=>window.__reusedOverlayError===window.__PRNEXT_DEV__.issue)).toBe(true);await expect(dialog.locator('#source-location')).toContainText('components/Counter.jsx:',{timeout:15000});await expect(dialog.locator('#message')).toHaveText(message);await expect(dialog.locator('#details')).toContainText('PRNEXT_REUSED_ERROR_SOURCE_CHECK');
    await expect(dialog.locator('#error-details')).toBeHidden();await dialog.locator('.error-row[aria-pressed=true]').click();await dialog.locator('#message-disclosure summary').focus();await page.keyboard.press('Enter');await expect(dialog.locator('#message')).toBeVisible();await expect(dialog.locator('#message')).toHaveText(message);await dialog.locator('#stack-disclosure summary').focus();await page.keyboard.press('Space');await expect(dialog.locator('#details')).toBeVisible();await expect(dialog.locator('#details')).toContainText('COMPLETE_ERROR_END');await dismiss.focus();await page.keyboard.press('Shift+Tab');expect(await dialog.evaluate(node=>!document.hasFocus()||node.contains(node.getRootNode().activeElement))).toBe(true);await page.keyboard.press('Tab');await expect(dismiss).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(counter).toBeFocused();
    const host=page.locator('prnext-dev-tools');await expect(host.locator('.trigger')).toHaveAttribute('data-issue-severity','critical');await host.locator('.trigger').click();await host.getByRole('button',{name:/View issues/}).click();await expect(dismiss).toBeFocused();await expect(dialog.locator('#message-disclosure')).toHaveJSProperty('open',false);await expect(dialog.locator('#stack-disclosure')).toHaveJSProperty('open',false);await dismiss.click();await expect(dialog).toHaveCount(0);await expect(host.locator('.trigger')).toBeFocused();await host.locator('.trigger').click();await host.getByRole('button',{name:/View issues/}).click();await expect(dismiss).toBeFocused();await expect(dialog.locator('#source-location')).toContainText('components/Counter.jsx:',{timeout:15000});await dialog.getByRole('button',{name:'Send to AI',exact:true}).click();await expect(dialog).toHaveCount(0);const panel=host.getByRole('dialog',{name:'Development inspector'});await expect(panel).toBeVisible();await expect(panel.getByRole('textbox',{name:'Instruction for your assistant'})).toBeFocused();const sent=await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context);expect(sent.kind).toBe('error');expect(sent.error.message).toBe(message);expect(sent.error.stack).toContain('COMPLETE_ERROR_END');expect(sent.mappedSource.file).toBe('components/Counter.jsx');
    await panel.getByRole('button',{name:'Close inspector'}).click();await fixture.write('components/Counter.jsx',counterSource('Overlay recovered'));await expect(counter).toHaveText('Overlay recovered 0',{timeout:25000});await expect(host.locator('.trigger')).toHaveAttribute('data-issue-severity','none');await counter.click();await expect(counter).toHaveText('Overlay recovered 1');
  });

  test('current error lists preserve mixed diagnostics and copy all while sending the selected source',async({page,context})=>{
    const mismatch=`'use client';export default function HydrationMismatch(){return <p data-testid="hydration-value">{typeof window==='undefined'?'Rendered on server':'Rendered in browser'}</p>}`;
    const runtime=`'use client';
export default function RuntimeFailure(){
  function saveProject(){
    throw new Error('mixed runtime failure: preserve this complete message');
  }
  return <button data-testid="runtime-failure" onClick={saveProject}>Cause runtime error</button>;
}`;
    fixture=await devFixture({files:{'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',strict:true,skipLibCheck:true},include:['check.ts']}),'check.ts':'export const first:number=1;\nexport const second:boolean=true;','components/RuntimeFailure.jsx':runtime,'components/HydrationMismatch.jsx':mismatch,'pages/pages.jsx':`import Counter from'../components/Counter';import HydrationMismatch from'../components/HydrationMismatch';import RuntimeFailure from'../components/RuntimeFailure';export default function Page(){return <><Counter/><HydrationMismatch/><RuntimeFailure/></>}`}});
    const editTypes=async source=>{
      const previous=await page.evaluate(()=>window.__PRNEXT_DEV__.sequence);
      await fixture.write('check.ts',source);
      // Check the committed generation, not a transient TypeScript notification
      // that can arrive before HMR and hide loss of unrelated diagnostics.
      await expect.poll(()=>page.evaluate(previous=>{const state=window.__PRNEXT_DEV__;return state.confirmed&&state.sequence>previous;},previous),{timeout:25000}).toBe(true);
    };
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});await page.goto(fixture.url+'/docs/pages?token=mixed-query-secret#mixed-fragment-secret');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);await connectAI(page);const origin=await page.evaluate(()=>performance.timeOrigin),host=page.locator('prnext-dev-tools'),trigger=host.locator('.trigger');await expect(trigger).toHaveAttribute('data-issue-severity','error');await page.getByTestId('counter').click();
    const dialog=page.getByRole('alertdialog',{name:'PRNext development error'}),list=dialog.getByRole('group',{name:'Errors',exact:true}),rows=list.getByRole('button'),hydration=list.locator('[data-kind="hydration"]'),critical=list.locator('[data-kind="runtime"]');await editTypes(`export const first:number='invalid-first';\nexport const second:boolean=true;`);await expect(rows).toHaveCount(2,{timeout:25000});await expect(list.locator('[data-kind="typescript"]')).toHaveCount(1);await expect(hydration).toHaveCount(1);await expect(trigger).toHaveAttribute('data-issue-severity','error');await dialog.getByRole('button',{name:'Dismiss',exact:true}).click();
    await page.getByTestId('runtime-failure').click();await expect(rows).toHaveCount(3);await expect(critical).toHaveAttribute('aria-pressed','true');await expect(trigger).toHaveAttribute('data-issue-severity','critical');await expect(dialog.locator('#error-details')).toBeHidden();await expect(hydration.locator('.error-row-message')).toBeHidden();await hydration.click();await expect(dialog.locator('#error-details')).toBeVisible();await expect(hydration).toHaveAttribute('aria-expanded','true');await dialog.locator('#error-title').click();await expect(dialog.locator('#error-details')).toBeHidden();await expect(hydration).toBeFocused();await page.keyboard.press('Enter');await expect(dialog.locator('#error-details')).toBeVisible();await expect(dialog.locator('#error-title')).toHaveText('Hydration mismatch');await expect(hydration).toHaveAttribute('aria-pressed','true');const hydrationId=await hydration.getAttribute('data-issue-id');
    await editTypes(`export const first:number='invalid-first';\nexport const second:boolean=42;`);await expect(rows).toHaveCount(4,{timeout:25000});await expect(hydration).toHaveAttribute('data-issue-id',hydrationId);await expect(hydration).toHaveAttribute('aria-pressed','true');await expect(dialog.locator('#error-title')).toHaveText('Hydration mismatch');await expect(trigger).toHaveAttribute('data-issue-severity','critical');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('4');
    const firstType=list.locator('[data-kind="typescript"]').filter({hasText:/check\.ts\(1,/}),secondType=list.locator('[data-kind="typescript"]').filter({hasText:/check\.ts\(2,/});await expect(firstType).toHaveCount(1);await expect(secondType).toHaveCount(1);await secondType.focus();await page.keyboard.press('Enter');await expect(secondType).toHaveAttribute('aria-pressed','true');await expect(dialog.locator('#error-title')).toHaveText('TypeScript');await expect(dialog.locator('#message')).toContainText("Type 'number' is not assignable to type 'boolean'.");expect(await dialog.locator('#message').textContent()).not.toContain("Type 'string' is not assignable to type 'number'.");await expect(trigger).toHaveAttribute('data-issue-severity','critical');const selectedTypeId=await secondType.getAttribute('data-issue-id');
    await dialog.locator('#copy-for-ai').click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText().then(text=>text.replace(/\r\n/g,'\n')))).toContain('mixed runtime failure: preserve this complete message');let copied=await page.evaluate(()=>navigator.clipboard.readText().then(text=>text.replace(/\r\n/g,'\n')));expect(copied.startsWith('Fix all errors below.')).toBe(true);expect(copied).toMatch(/Hydration failed|server rendered text/);expect(copied).toContain("Type 'string' is not assignable to type 'number'.");expect(copied).toContain("Type 'number' is not assignable to type 'boolean'.");expect(copied).not.toContain('mixed-query-secret');expect(copied).not.toContain('mixed-fragment-secret');expect(copied).not.toContain('Bearer ');expect(copied.length).toBeLessThanOrEqual(512*1024);await expect(dialog.locator('#error-copy-status')).toHaveText('Copied for AI.');
    await editTypes('export const first:number=1;\nexport const second:boolean=42;');await expect(rows).toHaveCount(3,{timeout:25000});await expect(secondType).toHaveAttribute('data-issue-id',selectedTypeId);await expect(secondType).toHaveAttribute('aria-pressed','true');await expect(dialog.locator('#error-title')).toHaveText('TypeScript');await expect(trigger).toHaveAttribute('data-issue-severity','critical');await expect(firstType).toHaveCount(0);await dialog.locator('#copy-for-ai').click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText().then(text=>text.replace(/\r\n/g,'\n')))).not.toContain("Type 'string' is not assignable to type 'number'.");
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(trigger).toHaveAttribute('data-issue-severity','critical');await trigger.click();await host.getByRole('button',{name:/View issues/}).click();await expect(critical).toHaveCount(1);await expect(critical).toHaveAttribute('aria-pressed','true');await expect(dialog.locator('#source-location')).toContainText('components/RuntimeFailure.jsx:4:',{timeout:15000});await expect(dialog.locator('#source-frame')).toContainText('preserve this complete message');await dialog.getByRole('button',{name:'Send to AI',exact:true}).click();await expect(dialog).toHaveCount(0);const panel=host.getByRole('dialog',{name:'Development inspector'});await expect(panel.getByRole('textbox',{name:'Instruction for your assistant'})).toBeFocused();const sent=await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context);expect(sent.kind).toBe('error');expect(sent.error.message).toBe('mixed runtime failure: preserve this complete message');expect(sent.mappedSource.file).toBe('components/RuntimeFailure.jsx');expect(sent.mappedSource.line).toBe(4);await panel.getByRole('button',{name:'Close inspector'}).click();
    await fixture.write('check.ts','export const first:number=1;\nexport const second:boolean=true;');await fixture.write('components/HydrationMismatch.jsx',`'use client';export default function HydrationMismatch(){return <p data-testid="hydration-value">Rendered in browser</p>}`);await expect(trigger).toHaveAttribute('data-issue-severity','none',{timeout:25000});await expect(page.getByTestId('counter')).toHaveText('Original 1');expect(await page.evaluate(()=>performance.timeOrigin)).toBe(origin);
  });

  test('unifies server and browser logs and records successful/failed requests without secrets', async ({ page }) => {
    fixture = await devFixture({ files: { 'pages/pages.jsx': `import Counter from'../components/Counter';export function getServerSideProps(){console.log('server-inspector-message');console.warn('server-inspector-warning');return{props:{}}}export default function Page(){return <><h1>Inspector</h1><Counter/></>}` } });
    await page.goto(fixture.url + '/docs/pages');
    await page.evaluate(async () => {
      console.info('browser-inspector-message');
      await fetch('/docs/pages?token=hidden-request-secret', { headers: { 'X-Private-Test': 'do-not-capture' } });
      await fetch('/docs/missing-resource?password=hidden-failure-secret');
      await fetch('http://127.0.0.1:1/fail?token=hidden-network-secret').catch(() => {});
    });
    const { host, panel } = await inspect(page);
    const filter = panel.getByRole('searchbox', { name: 'Filter requests' });
    await filter.fill('missing-resource'); await expect(panel.locator('.wb-request')).toHaveCount(1);
    await expect(panel.locator('.wb-request')).toContainText('404');
    await panel.locator('.wb-request summary').click(); await expect(panel).toContainText('Headers, request bodies and URL query values are not recorded.');
    await filter.fill('127.0.0.1:1'); await expect(panel.locator('.wb-request')).toContainText('Network error');
    const diagnostic = await page.evaluate(() => window.__PRNEXT_DEV__.tools.snapshot());
    expect(JSON.stringify(diagnostic.localRequests)).not.toContain('hidden-');
    expect(JSON.stringify(diagnostic.localRequests)).not.toContain('do-not-capture');
    await panel.getByRole('button', { name: 'Close inspector' }).click();
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await host.getByRole('button', { name: 'Client console', exact: true }).click();
    const consolePanel = host.getByRole('dialog', { name: 'Client console' });
    await expect(consolePanel).toContainText('browser-inspector-message');
    await consolePanel.getByRole('combobox', { name: 'Console source' }).selectOption('server');
    await expect(consolePanel).toContainText('server-inspector-message', { timeout: 10000 });
    const observed=await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.call('dev_snapshot'));
    expect(observed.serverLogs.find(entry=>entry.text.includes('server-inspector-message')).level).toBe('info');
    expect(observed.serverLogs.find(entry=>entry.text.includes('server-inspector-warning')).level).toBe('warn');
    expect(observed.requests.some(request=>request.source==='server'&&request.kind==='http')).toBe(true);
    await expect(consolePanel).not.toContainText('browser-inspector-message');
    await consolePanel.getByRole('combobox', { name: 'Console source' }).selectOption('browser');
    await expect(consolePanel).toContainText('browser-inspector-message');
    await expect(consolePanel).not.toContainText('server-inspector-message');
  });

  test('shows measured performance, searches parameterized routes and invalidates one route', async ({ page }) => {
    fixture = await devFixture({ files: { 'pages/products/[id].jsx': `export function getServerSideProps({params}){return{props:{id:params.id}}}export default function Product({id}){return <h1>Product {id}</h1>}` } });
    await page.goto(fixture.url + '/docs/pages');
    await page.evaluate(async()=>{await window.__PRNEXT_DEV__.ensureRoute('/docs/products/gold');await fetch('/docs/products/gold');});
    const { panel } = await inspect(page, 'Performance');
    await expect(panel.locator('.wb-metric').nth(0).locator('strong')).not.toHaveText('Not measured');
    await expect(panel.locator('.wb-metric').nth(1).locator('strong')).not.toHaveText('Not measured');
    await expect(panel).toContainText('Build timeline'); await expect(panel.locator('.wb-phase')).not.toHaveCount(0);
    await panel.getByRole('button', { name: 'Routes & cache', exact: true }).click();
    await panel.getByRole('searchbox', { name: 'Find a route' }).fill('products');
    const route = panel.locator('.wb-route'); await expect(route).toHaveCount(1); await route.locator('summary').click();
    await route.getByRole('button', { name: 'Clear route cache' }).click(); await expect(panel.getByRole('status')).toContainText('Enter id.');
    await route.getByRole('textbox', { name: 'id', exact: true }).fill('gold');
    const initial = await page.evaluate(async () => (await window.__PRNEXT_DEV__.tools.refresh()).sequence);
    const response = page.waitForResponse(response => response.url().endsWith('/v1/tools/dev_cache_invalidate'));
    await route.getByRole('button', { name: 'Clear route cache' }).click();
    const result=await(await response).json();expect(result.path).toBe('/docs/products/gold');
    await expect(panel.getByRole('status')).toContainText(result.invalidated?'Development cache invalidated for this route.':result.reason, { timeout: 30000 });
    expect(await page.evaluate(async () => (await window.__PRNEXT_DEV__.tools.refresh()).sequence)).toBe(initial);
    await route.getByRole('button', { name: 'Open route' }).click(); await expect(page).toHaveURL(fixture.url + '/docs/products/gold');
    await expect(page.getByRole('heading', { name: 'Product gold' })).toBeVisible();
  });

  test('captures a selected element with original source and a real bounded PNG, then queues AI context', async ({ page, context }) => {
    fixture = await devFixture(); await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.url });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width:320,height:720});
    await page.goto(fixture.url + '/docs/pages');
    const host = page.locator('prnext-dev-tools');
    await expect(page.getByTestId('counter')).toHaveAttribute('data-prnext-source', /components\/Counter.jsx:1:/);
    await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.refresh());let releaseSnapshot;const snapshotGate=new Promise(resolve=>{releaseSnapshot=resolve;}),holdSnapshot=async route=>{await snapshotGate;await route.continue();};await page.route('**/v1/tools/dev_snapshot',holdSnapshot);
    try{await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();await startPicker(page);}finally{releaseSnapshot();await page.unroute('**/v1/tools/dev_snapshot',holdSnapshot);}
    await page.getByTestId('counter').click();
    const panel = host.getByRole('dialog', { name: 'Development inspector' }); await expect(panel).toBeVisible();
    await expect(page.locator('prnext-dev-picker')).toHaveCount(0);await expect(panel.locator('.wb-ai-workspace')).toBeHidden();await expect(panel.getByRole('textbox',{name:'Instruction for your assistant'})).toBeHidden();await expect(panel.getByRole('button',{name:'Send context to AI'})).toBeHidden();await expect(panel.getByRole('button',{name:'Verify page'})).toBeHidden();
    await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.mappedSource?.file)).toBe('components/Counter.jsx');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.screenshot?.mimeType)).toBe('image/png');await page.evaluate(()=>{window.__localSelection=window.__PRNEXT_DEV__.tools.snapshot().context;});
    const assistant=await connectAI(page);await expect(panel.locator('details.wb-ai-setup')).toHaveJSProperty('open',false);expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context===window.__localSelection)).toBe(true);
    await expect(panel.getByRole('navigation',{name:'Development panels'})).toBeHidden();await expect(panel.getByRole('button',{name:'Refresh',exact:true})).toBeHidden();await expect(panel.getByRole('heading',{name:'Assistant connected',exact:true})).toBeHidden();await expect(panel.getByRole('button',{name:'Close inspector'})).toBeVisible();
    await expect(page.getByTestId('counter')).toHaveText('Original 0');
    await expect(panel).toContainText('components/Counter.jsx:1:', { timeout: 15000 });
    const screenshot = panel.getByRole('img', { name: 'Captured selected element' }); await expect(screenshot).toBeVisible({ timeout: 20000 });
    expect(await screenshot.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(panel.getByRole('link', { name: 'Open in editor' })).toHaveAttribute('href', /^vscode:\/\/file\//);
    const instruction=panel.locator('textarea[aria-label="Instruction for your assistant"]');await instruction.fill('Make this button compact.');
    await panel.getByRole('button', { name: 'Send context to AI' }).click();
    await expect(panel.getByRole('status')).toContainText('Context is available to your assistant');
    const data = await page.evaluate(async () => window.__PRNEXT_DEV__.tools.call('dev_snapshot'));
    const queued = data.ai.contexts.at(-1); expect(queued.prompt).toBe('Make this button compact.');
    expect(queued.context.source).toMatch(/components\/Counter.jsx:1:/); expect(queued.context.screenshot.mimeType).toBe('image/png');
    expect(Buffer.from(queued.context.screenshot.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(data.ai.connected).toBe(true);
    await panel.getByRole('button',{name:'Verify page'}).click();await expect(panel.getByRole('status')).toContainText('Verified:',{timeout:30000});
    const draft='Keep this draft through a real assistant reconnect.';await instruction.fill(draft);await assistant.close();
    await expect.poll(async()=>page.evaluate(async()=>(await window.__PRNEXT_DEV__.tools.refresh()).ai?.connected)).toBe(false);await expect(panel.locator('.wb-ai-workspace')).toBeHidden();await expect(instruction).toBeHidden();await expect(instruction).toHaveValue(draft);await expect(panel.locator('details.wb-ai-setup')).toHaveJSProperty('open',true);await expect(panel.getByRole('button',{name:'Copy Host command'})).toBeFocused();
    const rejected=await page.evaluate(async()=>{const tools=window.__PRNEXT_DEV__.tools;let rejected=false;try{await tools.call('dev_ai_context',{kind:'element',context:tools.snapshot().context,prompt:'A disconnected queue request must fail.'});}catch{rejected=true;}return{rejected,count:(await tools.call('dev_snapshot')).ai.contexts.length};});expect(rejected.rejected).toBe(true);expect(rejected.count).toBe(data.ai.contexts.length);
    const reconnectedAssistant=await connectAI(page);await expect(panel.locator('details.wb-ai-setup')).toHaveJSProperty('open',false);await expect(instruction).toBeVisible();await expect(instruction).toHaveValue(draft);await expect(instruction).toBeFocused();await expect(panel.getByRole('button',{name:'Send context to AI'})).toBeEnabled();const queuedReply=page.waitForResponse(response=>response.url().endsWith('/v1/tools/dev_ai_context')&&response.request().postDataJSON()?.prompt===draft);await panel.getByRole('button',{name:'Send context to AI'}).click();expect((await(await queuedReply).json()).queued).toBe(true);
    const reconnected=await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.call('dev_snapshot'));expect(reconnected.ai.contexts.at(-1).prompt).toBe(draft);
    await panel.getByRole('button',{name:'Close inspector'}).click();await host.locator('.trigger').click();await startPicker(page);await reconnectedAssistant.close();await expect.poll(async()=>page.evaluate(async()=>(await window.__PRNEXT_DEV__.tools.refresh()).ai.connected)).toBe(false);await expect(page.locator('prnext-dev-picker')).toBeVisible();await expect(panel).toBeHidden();await page.getByTestId('counter').click();await expect(panel).toBeVisible();await expect(panel.locator('.wb-ai-workspace')).toBeHidden();await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.screenshot?.mimeType)).toBe('image/png');await connectAI(page);await expect(instruction).toBeVisible();await expect(panel.getByRole('img',{name:'Captured selected element'})).toBeVisible();await expect(page.getByTestId('counter')).toHaveText('Original 0');expect(errors).toEqual([]);
  });

  test('AI setup offers real client configurations without pretending an assistant connected', async ({ page,context }) => {
    fixture = await devFixture();await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url}); await page.goto(fixture.url + '/docs/app');
    const {panel}=await inspect(page,'AI connection');await expect(page.locator('prnext-dev-picker')).toHaveCount(0);await expect(panel.locator('.wb-ai-workspace')).toBeHidden();await expect(panel.getByRole('navigation',{name:'Development panels'})).toBeHidden();await expect(panel.getByRole('button',{name:'Close inspector'})).toBeVisible();
    await expect(panel).toContainText('prnext dev --host-ai');
    await panel.getByRole('button',{name:'Copy Host command'}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('prnext dev --host-ai');
    const config = await page.evaluate(async () => window.__PRNEXT_DEV__.tools.call('dev_connection'));
    expect(config.connected).toBe(false);
    for(const [label,caption,viewBox] of [['Codex','Codex · TOML','0 0 24 24'],['Cursor','Cursor · JSON','0 0 512 512'],['Claude','Claude Desktop · JSON','0 0 248 248'],['Other MCP','Other MCP · JSON',null]]){
      const client=panel.getByRole('button',{name:label,exact:true});await expect(client).toBeVisible();await client.click();await expect(client).toHaveAttribute('aria-pressed','true');
      if(viewBox){const logo=client.locator('.wb-ai-client-logo svg');await expect(logo).toHaveAttribute('viewBox',viewBox);await expect(logo.locator('path').first()).toHaveAttribute('d',/.+/);}
      await expect(panel.getByText('Local MCP configuration',{exact:true})).toBeVisible();await expect(panel.locator('.wb-mcp-format')).toHaveText(caption);
      const copy=panel.getByRole('button',{name:'Copy MCP configuration'});await expect(copy).toBeVisible();await copy.click();
      const copied=await page.evaluate(()=>navigator.clipboard.readText());
      const code=panel.locator('.wb-mcp-snippet > pre.wb-mcp-code');await expect(panel.locator('.wb-mcp-snippet > pre + button')).toHaveAttribute('aria-label','Copy MCP configuration');expect(copied.replace(/\r\n/g,'\n')).toBe(await code.textContent());
      const metrics=await code.evaluate(node=>{const style=getComputedStyle(node);return{height:node.getBoundingClientRect().height,lineHeight:style.lineHeight,fontSize:style.fontSize,scroll:node.scrollHeight>node.clientHeight,clamp:style.webkitLineClamp};});expect(metrics.height).toBeCloseTo(83,1);expect(metrics.lineHeight).toBe('18px');expect(metrics.fontSize).toBe('10px');expect(metrics.scroll).toBe(true);expect(metrics.clamp).toBe('none');await code.evaluate(node=>{node.scrollTop=node.scrollHeight;});expect(await code.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
      const codeBounds=await code.boundingBox(),copyBounds=await copy.boundingBox();expect(copyBounds.x).toBeGreaterThanOrEqual(codeBounds.x+codeBounds.width-.5);
      if(label==='Codex'){expect(copied).toContain('[mcp_servers.prnext-dev]');expect(copied).toContain('command = '+JSON.stringify(config.mcp.command));expect(copied).toContain('args = [');}
      else expect(JSON.parse(copied).mcpServers['prnext-dev']).toEqual(label==='Cursor'?{type:'stdio',...config.mcp}:config.mcp);
      const info=panel.getByRole('button',{name:'MCP setup help'});if(await info.getAttribute('aria-expanded')!=='true')await info.click();await expect(info).toHaveAttribute('aria-expanded','true');
      const [guide,href]=label==='Codex'?['~/.codex/config.toml','https://learn.chatgpt.com/docs/extend/mcp?surface=cli']:label==='Cursor'?['.cursor/mcp.json','https://cursor.com/docs/mcp']:label==='Claude'?['claude_desktop_config.json','https://modelcontextprotocol.io/docs/develop/connect-local-servers']:['stdio','https://modelcontextprotocol.io/docs/develop/connect-local-servers'];await expect(panel.locator('.wb-mcp-help')).toContainText(guide);await expect(panel.locator('.wb-mcp-help a')).toHaveAttribute('href',href);await info.click();
      await expect(panel).not.toContainText('Assistant connected');expect(await page.evaluate(async()=>(await window.__PRNEXT_DEV__.tools.call('dev_connection')).connected)).toBe(false);
      await expect(page.locator('prnext-dev-picker')).toHaveCount(0);await expect(panel.getByRole('button',{name:'Send context to AI'})).toBeHidden();await expect(panel.locator('.wb-ai-workspace')).toBeHidden();
    }
    await expect(panel.getByRole('button', { name: 'Verify page' })).toBeHidden();
    await expect(panel).not.toContainText('Assistant connected');
  });

  test('MCP configuration and help animate both ways, survive interruption and respect reduced motion',async({page})=>{
    fixture=await devFixture();await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(fixture.url+'/docs/pages');const{panel}=await inspect(page,'AI connection');
    const details=panel.locator('details.wb-local-setup'),summary=details.locator('summary'),reveal=details.locator('.wb-mcp-reveal'),info=panel.getByRole('button',{name:'MCP setup help'}),help=panel.locator('.wb-mcp-help-reveal'),link=help.locator('a');
    const settle=locator=>locator.evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
    const animate=(control,selector)=>control.evaluate((node,selector)=>{node.click();const reveal=node.getRootNode().querySelector(selector),height=reveal.getBoundingClientRect().height;return{height,full:reveal.firstElementChild.getBoundingClientRect().height,running:reveal.getAnimations().some(animation=>animation.transitionProperty==='height'&&animation.playState==='running')};},selector);
    const focusClosedLink=()=>link.evaluate(node=>{node.focus();return node.getRootNode().activeElement===node;});
    const codex=panel.getByRole('button',{name:'Codex',exact:true});await codex.focus();const opening=await animate(codex,'.wb-mcp-reveal');expect(opening.running).toBe(true);expect(opening.height).toBeLessThan(opening.full);await settle(reveal);expect((await reveal.boundingBox()).height).toBeGreaterThan(80);
    const closing=await animate(summary,'.wb-mcp-reveal');expect(closing.running).toBe(true);await expect(details).toHaveJSProperty('open',true);await expect(summary).toHaveAttribute('aria-expanded','false');await expect(reveal).toHaveAttribute('aria-hidden','true');
    await panel.getByRole('button',{name:'Cursor',exact:true}).click();await settle(reveal);await expect(details).toHaveJSProperty('open',true);await expect(summary).toHaveAttribute('aria-expanded','true');await expect(panel.locator('.wb-mcp-code')).toContainText('"type": "stdio"');
    await info.focus();expect(await focusClosedLink()).toBe(false);await expect(info).toBeFocused();await page.keyboard.press('Enter');await expect(info).toHaveAttribute('aria-expanded','true');expect(await help.evaluate(node=>node.getAnimations().some(animation=>animation.transitionProperty==='height'))).toBe(true);await settle(help);await page.keyboard.press('Tab');await expect(link).toBeFocused();
    await info.focus();const helpClosing=await animate(info,'.wb-mcp-help-reveal');expect(helpClosing.running).toBe(true);await expect(help).toHaveAttribute('aria-hidden','true');expect(await focusClosedLink()).toBe(false);await settle(help);expect((await help.boundingBox()).height).toBe(0);
    await info.evaluate(node=>{node.click();node.click();node.click();});await settle(help);await expect(info).toHaveAttribute('aria-expanded','true');await expect(help).toHaveAttribute('aria-hidden','false');expect((await help.boundingBox()).height).toBeGreaterThan(20);
    await link.focus();await summary.evaluate(node=>node.click());await expect(summary).toBeFocused();await settle(reveal);await expect(details).toHaveJSProperty('open',false);await page.keyboard.press('Tab');expect(await focusClosedLink()).toBe(false);await expect(link).not.toBeFocused();
    await page.emulateMedia({reducedMotion:'reduce'});await panel.getByRole('button',{name:'Claude',exact:true}).click();await expect(details).toHaveJSProperty('open',true);expect(await reveal.evaluate(node=>node.getAnimations().some(animation=>animation.transitionProperty==='height'))).toBe(false);if(await info.getAttribute('aria-expanded')==='true')await info.click();await info.click();expect(await help.evaluate(node=>node.getAnimations().some(animation=>animation.transitionProperty==='height'))).toBe(false);await expect(link).toHaveAttribute('href','https://modelcontextprotocol.io/docs/develop/connect-local-servers');await summary.click();await expect(details).toHaveJSProperty('open',false);await page.keyboard.press('Escape');await expect(panel).toBeHidden();
  });

  for(const width of [390,320])test.describe(`MCP configuration at ${width}px`,()=>{
    test.use({hasTouch:true,isMobile:true});
    test('keeps complete code scrollable, contextual help usable and copy outside the scroll area',async({page,context})=>{
      fixture=await devFixture();await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.url});await page.setViewportSize({width,height:width===390?844:720});await page.goto(fixture.url+'/docs/pages');const{host,panel}=await inspect(page,'AI connection');await panel.getByRole('button',{name:'Cursor',exact:true}).tap();
      // PageDown scrolls the focused region on every supported desktop OS;
      // Control+End is a Windows/Linux document shortcut, not the macOS one.
      const code=panel.getByRole('region',{name:'MCP configuration'}),copy=panel.getByRole('button',{name:'Copy MCP configuration'}),info=panel.getByRole('button',{name:'MCP setup help'});await expect(code).toHaveAttribute('tabindex','0');await code.focus();await page.keyboard.press('PageDown');await expect.poll(()=>code.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);expect((await code.boundingBox()).height).toBeCloseTo(83,1);await copy.tap();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText().then(value=>value.replace(/\r\n/g,'\n')))).toBe(await code.textContent());
      await info.tap();await expect(info).toHaveAttribute('aria-expanded','true');await expect(panel.locator('.wb-mcp-help')).toContainText('.cursor/mcp.json');await expect(panel.locator('.wb-mcp-help a')).toHaveAttribute('href','https://cursor.com/docs/mcp');for(const control of[copy,info]){const bounds=await control.boundingBox();expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.height).toBeGreaterThanOrEqual(44);}
      const bounds=await panel.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth&&node.querySelector('.wb-tools-content').scrollWidth<=node.querySelector('.wb-tools-content').clientWidth)).toBe(true);await info.tap();await expect(info).toHaveAttribute('aria-expanded','false');expect(await panel.locator('.wb-mcp-help a').evaluate(node=>{node.focus();return node.getRootNode().activeElement===node;})).toBe(false);await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(host.locator('.trigger')).toBeFocused();expect(await page.evaluate(async()=>(await window.__PRNEXT_DEV__.tools.call('dev_connection')).connected)).toBe(false);
    });
  });

  test('AI status and relay errors stay current while the selected instruction is focused',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');const host=page.locator('prnext-dev-tools');
    await connectAI(page);
    await host.locator('.trigger').click();await startPicker(page);await page.getByTestId('counter').click();
    const panel=host.getByRole('dialog',{name:'Development inspector'});await expect(panel.getByRole('button',{name:'Send context to AI'})).toBeEnabled({timeout:20000});
    let mode='connected';await page.route('**/v1/**',async route=>{
      if(mode==='disconnected'){await route.abort('failed');return;}
      if(!route.request().url().endsWith('/v1/tools/dev_snapshot')){await route.continue();return;}
      const response=await route.fetch(),result=await response.json();result.ai={...(result.ai||{}),connected:true,client:'Test assistant',hostRelay:{enabled:true,linked:true,...(mode==='relay-error'?{error:'Relay became unavailable while typing.'}:{})}};
      await route.fulfill({response,json:result});
    });
    const instruction=panel.locator('textarea[aria-label="Instruction for your assistant"]');await instruction.fill('Keep this instruction while diagnostics update.');
    await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.refresh());await expect(panel.locator('.wb-ai-status-label')).toHaveText('Connected');await expect(panel.locator('.wb-ai-status')).toHaveAttribute('data-connected','true');
    mode='relay-error';await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.refresh());await expect(panel.getByText('Relay became unavailable while typing.',{exact:true})).toBeVisible();await expect(instruction).toBeFocused();await expect(instruction).toHaveValue('Keep this instruction while diagnostics update.');
    mode='disconnected';await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.refresh());await expect(panel.locator('.wb-ai-status-label')).toHaveText('Reconnecting');await expect(panel.locator('.wb-ai-status')).toHaveAttribute('data-connected','false');
    await expect(panel).not.toContainText('Assistant connected');await expect(instruction).toBeHidden();await expect(instruction).toHaveValue('Keep this instruction while diagnostics update.');await expect(panel.getByRole('button',{name:'Copy Host command'})).toBeFocused();
    mode='connected';await page.evaluate(async()=>window.__PRNEXT_DEV__.tools.refresh());await expect(instruction).toBeVisible();await expect(instruction).toBeFocused();await expect(instruction).toHaveValue('Keep this instruction while diagnostics update.');
  });

  test('picker keyboard cancellation and mobile inspector preserve restrained borders and navigation', async ({ page }) => {
    fixture = await devFixture(); await page.setViewportSize({ width: 320, height: 640 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(fixture.url + '/docs/pages');
    const { host, panel } = await inspect(page, 'Routes & cache');
    const bounds = await panel.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click(); await startPicker(page);
    await page.keyboard.press('Escape'); await expect(page.locator('prnext-dev-picker')).toHaveCount(0);
    expect(await page.locator('body').getAttribute('tabindex')).toBeNull();
    await expect(host.locator('.trigger')).toBeFocused();
    await host.locator('.trigger').click(); await host.getByRole('button', { name: 'Desktop', exact: true }).click();
    const preview = host.getByRole('dialog', { name: 'Device preview' }); await expect(preview).toBeVisible();
    expect(await preview.evaluate(node => getComputedStyle(node).borderWidth)).toBe('0px');
    await preview.getByRole('button', { name: 'Device frame' }).click();
    expect(await host.locator('.wb-frame-wrap').evaluate(node => getComputedStyle(node).boxShadow)).toBe('none');
  });

  test('keyboard selection works and a completed capture never reopens a closed inspector', async ({ page }) => {
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');
    await page.route('**/v1/tools/dev_source',async route=>{await new Promise(resolve=>setTimeout(resolve,500));await route.continue();});
    const host=page.locator('prnext-dev-tools');await host.getByRole('button',{name:/Open PRNext developer tools/}).click();
    await startPicker(page);
    await page.keyboard.press('Tab');await expect(page.getByTestId('counter')).toBeFocused();
    const source=page.waitForResponse(response=>response.url().endsWith('/v1/tools/dev_source'));
    await page.keyboard.press('Enter');const panel=host.getByRole('dialog',{name:'Development inspector'});await expect(panel).toBeVisible();
    await panel.getByRole('button',{name:'Close inspector'}).click();await source;
    await expect.poll(()=>page.evaluate(()=>Boolean(window.__PRNEXT_DEV__.tools.snapshot().context?.mappedSource))).toBe(true);
    await expect(panel).toBeHidden();await expect(page.getByTestId('counter')).toHaveText('Original 0');expect(await page.locator('body').getAttribute('tabindex')).toBeNull();
  });

  test('picker excludes developer HUD descendants across a shadow boundary',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');const host=page.locator('prnext-dev-tools');
    await host.locator('.trigger').click();await startPicker(page);
    await expect(page.locator('prnext-dev-picker')).toBeVisible();await host.locator('.trigger img').click();
    await expect(page.locator('prnext-dev-picker')).toBeVisible();await expect(host.getByRole('dialog',{name:'Development inspector'})).toBeHidden();
    expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context)).toBeUndefined();
    await page.keyboard.press('Escape');await expect(page.locator('prnext-dev-picker')).toHaveCount(0);expect(await page.locator('body').getAttribute('tabindex')).toBeNull();
  });

  test('an older asynchronous capture cannot replace a newer selection or its instruction',async({page})=>{
    fixture=await devFixture();await page.goto(fixture.url+'/docs/pages');
    await connectAI(page);
    let release;const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/v1/tools/dev_source',async route=>{if(route.request().postDataJSON()?.source?.startsWith('components/Counter.jsx:'))await gate;else await new Promise(resolve=>setTimeout(resolve,1000));await route.continue();});
    const oldResponse=page.waitForResponse(response=>response.url().endsWith('/v1/tools/dev_source')&&response.request().postDataJSON()?.source?.startsWith('components/Counter.jsx:'),{timeout:60000});
    const host=page.locator('prnext-dev-tools');
    try{
      await host.locator('.trigger').click();await startPicker(page);await page.getByTestId('counter').click();
      const panel=host.getByRole('dialog',{name:'Development inspector'});await expect(panel).toBeVisible();await panel.getByRole('button',{name:'Close inspector'}).click();
      await host.locator('.trigger').click();await startPicker(page);await page.getByRole('heading',{name:'Pages refresh'}).click();
      await expect(panel).toBeVisible();const instruction=panel.getByRole('textbox',{name:'Instruction for your assistant'});await instruction.fill('Keep this heading selected.');
      await expect(panel.getByRole('button',{name:'Send context to AI'})).toBeDisabled();await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.mappedSource?.file)).toBe('pages/pages.jsx');
      await expect(panel.getByRole('button',{name:'Send context to AI'})).toBeEnabled();await expect(instruction).toHaveValue('Keep this heading selected.');release();await(await oldResponse).finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.mappedSource?.file)).toBe('pages/pages.jsx');
      await expect(instruction).toHaveValue('Keep this heading selected.');expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.selector)).toBe('h1');
    }finally{release();}
  });

  test('picker motion retargets to the latest element without delaying scroll, reduced motion or clicks',async({page})=>{
    fixture=await devFixture({files:{'pages/pages.jsx':`export default function Page(){return <main style={{minHeight:2200}}><button id="motion-a" style={{position:'absolute',left:120,top:180,width:140,height:52}}>First target</button><button id="motion-b" style={{position:'absolute',left:650,top:360,width:180,height:80}}>Second target</button></main>}`}});
    await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(fixture.url+'/docs/pages');
    const errors=[];page.on('pageerror',error=>errors.push(error.message));const host=page.locator('prnext-dev-tools');await host.locator('.trigger').click();await startPicker(page);
    const picker=page.locator('prnext-dev-picker');
    const retarget=id=>page.evaluate(async id=>{
      const element=document.getElementById(id),root=document.querySelector('prnext-dev-picker').shadowRoot,expected=element.getBoundingClientRect(),dimensions=root.querySelector('.picker-dimensions'),label=Math.round(expected.width)+' \u00d7 '+Math.round(expected.height);
      const applied=new Promise(resolve=>{if(dimensions.textContent===label)return resolve();const observer=new MutationObserver(()=>{if(dimensions.textContent===label){observer.disconnect();resolve();}});observer.observe(dimensions,{childList:true,characterData:true,subtree:true});});
      element.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,composed:true,clientX:expected.x+expected.width/2,clientY:expected.y+expected.height/2}));await applied;
      const target=root.querySelector('.target'),rect=target.getBoundingClientRect();
      return{actual:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},expected:{x:expected.x,y:expected.y,width:expected.width,height:expected.height},transitions:target.getAnimations().filter(animation=>typeof animation.transitionProperty==='string').map(animation=>animation.transitionProperty)};
    },id);
    const maxError=sample=>Math.max(...Object.keys(sample.actual).map(key=>Math.abs(sample.actual[key]-sample.expected[key])));
    expect(maxError(await retarget('motion-a'))).toBeLessThan(0.6);
    const moving=await retarget('motion-b');expect(moving.transitions.length).toBeGreaterThan(0);
    await page.evaluate(()=>{for(const id of ['motion-a','motion-b','motion-a'])document.getElementById(id).dispatchEvent(new PointerEvent('pointermove',{bubbles:true,composed:true}));});await retarget('motion-a');
    await expect.poll(async()=>{const actual=await picker.locator('.target').boundingBox(),expected=await page.locator('#motion-a').boundingBox();return maxError({actual,expected});}).toBeLessThan(0.6);
    const scrolled=await page.evaluate(async()=>{
      window.scrollTo(0,80);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const target=document.querySelector('prnext-dev-picker').shadowRoot.querySelector('.target'),rect=target.getBoundingClientRect(),expected=document.getElementById('motion-a').getBoundingClientRect();return{actual:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},expected:{x:expected.x,y:expected.y,width:expected.width,height:expected.height}};
    });expect(maxError(scrolled)).toBeLessThan(0.6);
    await page.emulateMedia({reducedMotion:'reduce'});const reduced=await retarget('motion-b');expect(maxError(reduced)).toBeLessThan(0.6);expect(reduced.transitions).toEqual([]);
    await page.emulateMedia({reducedMotion:'no-preference'});expect((await retarget('motion-a')).transitions.length).toBeGreaterThan(0);
    const clicked=await page.locator('#motion-b').boundingBox();await page.mouse.click(clicked.x+clicked.width/2,clicked.y+clicked.height/2);
    await expect(picker).toHaveCount(0);await expect(host.getByRole('dialog',{name:'Development inspector'})).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.selector)).toBe('#motion-b');expect(errors).toEqual([]);
  });

  test('picker ignores fast crossings but follows slow intent, stops and microjitter without stale candidates',async({page})=>{
    fixture=await devFixture({files:{'pages/pages.jsx':`export default function Page(){return <main style={{minHeight:2200}}><button id="intent-a" style={{position:'absolute',left:120,top:180,width:140,height:52}}>First target<span id="intent-tiny" style={{position:'absolute',left:30,top:10,width:16,height:12,display:'block'}}>+</span></button><button id="intent-b" style={{position:'absolute',left:650,top:360,width:180,height:80}}>Second target</button><button id="intent-c" style={{position:'absolute',left:960,top:280,width:100,height:48}}>Third target</button></main>}`}});
    await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'reduce'});await page.clock.install();await page.goto(fixture.url+'/docs/pages');
    const host=page.locator('prnext-dev-tools');await host.locator('.trigger').click();await startPicker(page);await page.clock.pauseAt(await page.evaluate(()=>Date.now()+1000));
    const picker=page.locator('prnext-dev-picker'),outline=picker.locator('.target'),dimensions=picker.locator('.picker-dimensions');
    const point=(id,offset=10)=>page.evaluate(({id,offset})=>{const node=document.getElementById(id),rect=node.getBoundingClientRect();node.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,composed:true,clientX:rect.x+offset,clientY:rect.y+10}));},{id,offset});
    const exact=async id=>{const actual=await outline.boundingBox(),expected=await page.locator('#'+id).boundingBox();expect(Math.max(...['x','y','width','height'].map(key=>Math.abs(actual[key]-expected[key])))).toBeLessThan(0.6);};
    try{
      await page.locator('#intent-a').evaluate(node=>node.focus());await expect(outline).toBeVisible();await exact('intent-a');await point('intent-a');await page.clock.runFor(16);
      await page.evaluate(()=>{const node=document.querySelector('prnext-dev-picker').shadowRoot.querySelector('.picker-dimensions');window.__pickerDimensions=[];new MutationObserver(()=>window.__pickerDimensions.push(node.textContent)).observe(node,{childList:true,subtree:true,characterData:true});});
      for(const id of ['intent-b','intent-c']){await point(id);for(let step=1;step<=5;step++){await page.clock.runFor(16);await point(id,10+step*15);await expect(dimensions).toHaveText('140 \u00d7 52');await exact('intent-a');}}
      await page.clock.runFor(49);await expect(dimensions).toHaveText('140 \u00d7 52');await page.clock.runFor(17);await expect(dimensions).toHaveText('100 \u00d7 48');await exact('intent-c');expect(await page.evaluate(()=>window.__pickerDimensions)).not.toContain('180 \u00d7 80');
      await point('intent-b');for(let step=1;step<=7;step++){await page.clock.runFor(20);await point('intent-b',10+step*2);}await expect(dimensions).toHaveText('180 \u00d7 80');await exact('intent-b');
      await point('intent-a');for(let step=1;step<=8;step++){await page.clock.runFor(10);await point('intent-a',10+step*.05);}await expect(dimensions).toHaveText('140 \u00d7 52');await exact('intent-a');
      await point('intent-tiny',1);await page.clock.runFor(60);await expect(dimensions).toHaveText('140 \u00d7 52');await point('intent-a');await page.clock.runFor(140);await exact('intent-a');expect(await page.evaluate(()=>window.__pickerDimensions)).not.toContain('16 \u00d7 12');
      await point('intent-b');await page.clock.runFor(20);await page.locator('#intent-c').evaluate(node=>node.focus());await expect(dimensions).toHaveText('100 \u00d7 48');await exact('intent-c');await page.locator('#intent-a').evaluate(node=>node.focus());await page.clock.runFor(160);await exact('intent-a');
      for(const cancellation of ['hud','leave','blur']){
        await point('intent-b');await page.clock.runFor(20);await page.evaluate(kind=>{if(kind==='hud')document.querySelector('prnext-dev-tools').shadowRoot.querySelector('.trigger').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,composed:true}));else if(kind==='leave')document.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:null}));else window.dispatchEvent(new Event('blur'));},cancellation);await page.clock.runFor(160);await exact('intent-a');
      }
      await point('intent-b');await page.clock.runFor(20);await page.evaluate(()=>{window.scrollTo(0,80);window.dispatchEvent(new Event('scroll'));});await page.clock.runFor(16);await exact('intent-a');await page.clock.runFor(160);await exact('intent-a');
      await point('intent-b');await page.clock.runFor(20);await picker.getByRole('button',{name:'Cancel',exact:true}).evaluate(node=>node.click());await page.clock.runFor(200);await expect(picker).toHaveCount(0);expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context)).toBeUndefined();
    }finally{await page.clock.resume();}
  });

  for(const width of [1440,390,320])test.describe(`picker at ${width}px`,()=>{
  test.use({hasTouch:width<500,isMobile:width<500});
  test('labels stay readable at viewport edges and Cancel stays usable',async({page})=>{
    const height=width===1440?1000:width===390?844:640;
    fixture=await devFixture({files:{'pages/pages.jsx':`import Counter from'../components/Counter';export default function Page(){return <><h1>Picker edges</h1><Counter/><button data-testid="edge-top" style={{position:'fixed',top:0,right:0,width:48,height:32}}>Top</button><button data-testid="edge-bottom" style={{position:'fixed',bottom:0,left:0,width:48,height:32}}>Base</button></>}`}});
    await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:'reduce'});await page.goto(fixture.url+'/docs/pages');
    await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');
    const host=page.locator('prnext-dev-tools');await host.locator('.trigger').click();await startPicker(page);
    const picker=page.locator('prnext-dev-picker'),tag=picker.locator('.picker-tag'),hint=picker.locator('.hint');
    for(const id of ['edge-top','edge-bottom']){
      const target=page.getByTestId(id),bounds=await target.boundingBox();await target.hover();await expect(tag).toBeVisible();await expect(picker.locator('.picker-source-name')).toHaveText('pages.jsx');await expect(picker.locator('.picker-source-line')).toHaveText(':1');
      await expect(picker.locator('.picker-file-icon')).toHaveAttribute('data-language','javascript');
      await expect(picker.locator('.picker-file-icon')).toHaveText('JS');await expect(picker.locator('.picker-file-icon')).toBeVisible();
      await expect(picker.locator('.picker-dimensions')).toHaveText(`${Math.round(bounds.width)} × ${Math.round(bounds.height)}`);
      await expect.poll(async()=>{const actual=await picker.locator('.target').boundingBox();return actual&&Math.max(...['x','y','width','height'].map(key=>Math.abs(actual[key]-bounds[key])));}).toBeLessThan(0.6);
      const dimensionBox=await picker.locator('.picker-dimensions').boundingBox(),sourceBox=await picker.locator('.picker-source').boundingBox();expect(dimensionBox.y+dimensionBox.height).toBeLessThanOrEqual(sourceBox.y+1);await expect(picker.locator('.picker-tag-top > *')).toHaveCount(1);
      const sourceParts=await picker.locator('.picker-source').evaluate(node=>Array.from(node.children).filter(child=>!child.hidden).map(child=>{const rect=child.getBoundingClientRect();return{top:rect.top,bottom:rect.bottom};}));expect(sourceParts.every(rect=>rect.top<sourceBox.y+sourceBox.height&&rect.bottom>sourceBox.y)).toBe(true);
      const outline=await picker.locator('.target').evaluate(node=>{const style=getComputedStyle(node);return{dashed:style.outlineStyle==='dashed'||style.borderTopStyle==='dashed',background:style.backgroundColor};});expect(outline.dashed).toBe(true);expect(outline.background).toBe('rgba(0, 0, 0, 0)');
      await expect(picker.locator('.corner')).toHaveCount(8);expect((await picker.locator('.corner').evaluateAll(nodes=>nodes.map(node=>node.dataset.corner))).sort()).toEqual(['b','bl','br','l','r','t','tl','tr']);
      const label=await tag.boundingBox(),capsule=await hint.boundingBox();expect(label.x).toBeGreaterThanOrEqual(7.5);expect(label.y).toBeGreaterThanOrEqual(7.5);expect(label.x+label.width).toBeLessThanOrEqual(width-7.5);expect(label.y+label.height).toBeLessThanOrEqual(height-7.5);
      expect(label.x>=capsule.x+capsule.width||label.x+label.width<=capsule.x||label.y>=capsule.y+capsule.height||label.y+label.height<=capsule.y).toBe(true);
      expect(await tag.evaluate(node=>getComputedStyle(node).transitionDuration.split(',').every(value=>parseFloat(value)===0))).toBe(true);
    }
    const cancel=picker.getByRole('button',{name:'Cancel',exact:true});await expect(cancel).toBeVisible();if(width<500){expect((await cancel.boundingBox()).height).toBeGreaterThanOrEqual(44);await expect(picker.locator('.picker-enter')).toBeHidden();}
    await cancel.click();await expect(picker).toHaveCount(0);await expect(host.locator('.trigger')).toBeFocused();
    await expect(page.getByTestId('counter')).toHaveText('Original 1');expect(await page.locator('body').getAttribute('tabindex')).toBeNull();expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context)).toBeUndefined();
    await host.locator('.trigger').click();await startPicker(page);
    await picker.getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Enter');await expect(picker).toHaveCount(0);await expect(host.locator('.trigger')).toBeFocused();expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context)).toBeUndefined();
  });
  });

  test('picker file labels reflect JSX and TSX sources and keep inherited locations explicit',async({page})=>{
    const typed='VeryLongTypeScriptComponentNameForPicker';
    fixture=await devFixture({files:{[`components/${typed}.tsx`]:`export default function TypeScriptButton(){return <button data-testid="typescript-target">TypeScript</button>}`,'pages/pages.jsx':`import Counter from'../components/Counter';import TypeScriptButton from'../components/${typed}';export default function Page(){return <><h1>File locations</h1><Counter/><TypeScriptButton/></>}`}});
    await page.goto(fixture.url+'/docs/pages');await page.evaluate(()=>{const span=document.createElement('span');span.id='runtime-child';span.textContent=' Runtime child';document.querySelector('[data-testid="counter"]').append(span);});
    const host=page.locator('prnext-dev-tools');await host.locator('.trigger').click();await startPicker(page);const picker=page.locator('prnext-dev-picker');
    await page.getByTestId('typescript-target').hover();await expect(picker.locator('.picker-file-icon')).toHaveAttribute('data-language','typescript');await expect(picker.locator('.picker-source-name')).toHaveText(typed+'.tsx');await expect(picker.locator('.picker-source-line')).toHaveText(':1');await expect(picker.locator('.picker-source-line')).toBeVisible();await expect(picker.locator('.picker-file-icon')).toHaveText('TS');await expect(picker.locator('.picker-file-icon')).toBeVisible();await expect(picker.locator('.picker-source-parent')).toBeHidden();const labelBounds=await picker.locator('.picker-tag').boundingBox(),lineBounds=await picker.locator('.picker-source-line').boundingBox();expect(lineBounds.x+lineBounds.width).toBeLessThanOrEqual(labelBounds.x+labelBounds.width);
    await page.locator('#runtime-child').hover();await expect(picker.locator('.picker-file-icon')).toHaveAttribute('data-language','javascript');await expect(picker.locator('.picker-source-name')).toHaveText('Counter.jsx');await expect(picker.locator('.picker-source-line')).toHaveText(':1');await expect(picker.locator('.picker-file-icon')).toHaveText('JS');await expect(picker.locator('.picker-source-parent')).toHaveText('Parent');await expect(picker.locator('.picker-source-parent')).toBeVisible();
    await page.locator('#runtime-child').click();await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.sourceRelation)).toBe('ancestor');expect(await page.evaluate(()=>window.__PRNEXT_DEV__.tools.snapshot().context?.source)).toMatch(/^components\/Counter.jsx:1:/);
  });
});
