import { test, expect } from '@playwright/test';
import { counterSource, devFixture } from '../dev-fixture.mjs';

test.describe('React Fast Refresh', () => {
  test.setTimeout(60_000);
  let fixture;
  test.beforeEach(async () => { fixture = await devFixture(); });
  test.afterEach(async () => { await fixture?.close(); });

  for (const router of ['pages', 'app']) test(`${router} keeps hook state and document while replacing components, styles and server data`, async ({ page }) => {
    const errors = [], documents = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console',message=>{if(/hydration|hydrated|didn't match|did not match/i.test(message.text())&&['error','warning'].includes(message.type()))errors.push(message.text());});
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${fixture.url}/docs/${router}`);
    const counter = page.getByTestId('counter');
    await expect(counter).toHaveAttribute('data-prnext-source',/^components\/Counter.jsx:\d+:\d+$/);
    await counter.click(); await counter.click();
    await expect(counter).toHaveText('Original 2');
    await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);
    await page.evaluate(() => { window.__devDocument = 'preserved'; });
    await fixture.write('components/Counter.jsx', counterSource('Updated'));
    await expect(counter, fixture.output()).toHaveText('Updated 2', { timeout: 20_000 });
    await fixture.write('components/counter.module.css', '.counter{color:rgb(98,76,54)}');
    await expect(counter).toHaveCSS('color', 'rgb(98, 76, 54)', { timeout: 20_000 });
    await expect(counter).toHaveText('Updated 2');
    const source = router === 'pages' ? 'pages/pages.jsx' : 'app/app/page.jsx';
    await fixture.write(source, (await fixture.read(source)).replace('server-one', 'server-two'));
    await expect(page.getByTestId('server')).toContainText('server-two', { timeout: 20_000 });
    await expect(counter).toHaveText('Updated 2');
    expect(await page.evaluate(() => window.__devDocument)).toBe('preserved');
    expect(documents).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  for(const router of ['pages','app'])test(`${router} re-evaluates exact reverted source repeatedly without losing state`,async({page})=>{
    const documents=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
    await page.goto(`${fixture.url}/docs/${router}`);const counter=page.getByTestId('counter');await counter.click();await expect(counter).toHaveText('Original 1');
    await page.evaluate(()=>{window.__revertDocument='same';window.__refreshes=[];addEventListener('prnext:refresh',event=>window.__refreshes.push(event.detail));});
    for(const label of ['Changed','Original','Changed','Original']){await fixture.write('components/Counter.jsx',counterSource(label));await expect(counter,fixture.output()).toHaveText(`${label} 1`,{timeout:20_000});}
    expect(await page.evaluate(()=>window.__revertDocument)).toBe('same');expect(documents).toHaveLength(1);
    await expect.poll(()=>page.evaluate(()=>window.__refreshes.length)).toBeGreaterThanOrEqual(4);
    await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.confirmed)).toBe(true);
    const refreshes=await page.evaluate(()=>window.__refreshes);expect(refreshes.every(item=>Number.isFinite(item.durationMs)&&item.durationMs>=0)).toBe(true);
  });

  test('runtime errors map original source and send complete context to the AI tools',async({page})=>{
    await page.goto(`${fixture.url}/docs/app`);await fixture.write('components/Counter.jsx',counterSource('Broken',{eventError:true}));await expect(page.getByTestId('counter')).toHaveText('Broken 0',{timeout:20_000});
    await page.evaluate(()=>addEventListener('prnext:devtools:ai',event=>{window.__aiError=event.detail;},{once:true}));await page.getByTestId('counter').click();
    const overlay=page.locator('#__prnext_dev_error__');await overlay.locator('.error-row[aria-pressed=true]').click();await expect(overlay.locator('#source-location')).toContainText('components/Counter.jsx:',{timeout:10_000});
    await expect(overlay.locator('#source-frame')).toContainText('event refresh failure');await expect(overlay.getByRole('link',{name:'Open in editor'})).toHaveAttribute('href',/^vscode:\/\/file\//);
    await overlay.getByRole('button',{name:'Send to AI'}).click();await expect(overlay).toHaveCount(0);
    const sent=await page.evaluate(()=>window.__aiError);expect(sent.error.message).toContain('event refresh failure');expect(sent.source.file).toBe('components/Counter.jsx');expect(sent.source.mapped).toBe(true);expect(sent.source.frame).toContain('throw new Error');
  });

  test('a rejected initial App bootstrap recovers on one newer build without a reload loop',async({page})=>{
    const documents=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
    let target,blocked=false;
    const intercept=async route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname;
      if(target===pathname&&!blocked){blocked=true;await route.abort('failed');return;}
      const response=await route.fetch(),source=await response.text();
      const match=/const flightClient = await import\("([^"]+)"\)/.exec(source);
      if(match&&!blocked)target=new URL(match[1],request.url()).pathname;
      await route.fulfill({response,body:source});
    };
    await page.route('**/docs/_prnext/assets/*.js',intercept);
    await page.goto(`${fixture.url}/docs/app`);
    await expect(page.getByRole('alertdialog')).toContainText('Failed to fetch dynamically imported module');
    expect(blocked).toBe(true);expect(await page.evaluate(()=>Boolean(window.__PRNEXT_DEV__.bootstrapFailed))).toBe(true);
    expect(await page.evaluate(()=>window.__PRNEXT_DEV__.confirmed)).toBe(false);expect(documents).toHaveLength(1);
    await page.unroute('**/docs/_prnext/assets/*.js',intercept);
    await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame(),timeout:20_000}),fixture.write('components/Counter.jsx',counterSource('Recovered'))]);
    const counter=page.getByTestId('counter');await expect(counter).toHaveText('Recovered 0',{timeout:20_000});
    await expect(page.getByRole('alertdialog')).toHaveCount(0);await expect(page.locator('#__prnext_reload_reason__')).toContainText('Application startup failed');
    await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__.confirmed)).toBe(true);await counter.click();await expect(counter).toHaveText('Recovered 1');expect(documents).toHaveLength(2);
  });

  test('a syntax error keeps the last application and recovers without losing state', async ({ page }) => {
    await page.goto(`${fixture.url}/docs/pages`);
    await page.getByTestId('counter').click();
    await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await fixture.write('components/Counter.jsx', `export default function Counter(){ return <broken`);
    await expect(page.getByRole('alertdialog')).toContainText('Counter.jsx', { timeout: 20_000 });
    await fixture.write('components/Counter.jsx', counterSource('Recovered'));
    await expect(page.getByTestId('counter')).toHaveText('Recovered 1', { timeout: 20_000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('runtime event and render errors have an overlay that recovers on a corrected edit', async ({ page }) => {
    await page.goto(`${fixture.url}/docs/app`);
    await page.getByTestId('counter').click();
    await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await fixture.write('components/Counter.jsx', counterSource('Event', { eventError: true }));
    await expect(page.getByTestId('counter')).toHaveText('Event 1', { timeout: 20_000 });
    await page.getByTestId('counter').click();
    await expect(page.getByRole('alertdialog')).toContainText('event refresh failure');
    await fixture.write('components/Counter.jsx', counterSource('Event fixed'));
    await expect(page.getByTestId('counter')).toHaveText('Event fixed 1', { timeout: 20_000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await fixture.write('components/Counter.jsx', counterSource('Render', { renderError: true }));
    await expect(page.getByRole('alertdialog')).toContainText('render refresh failure', { timeout: 20_000 });
    await fixture.write('components/Counter.jsx', counterSource('Render fixed'));
    await expect(page.getByTestId('counter')).toHaveText(/Render fixed \d+/, { timeout: 20_000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('reactStrictMode controls development effect checks and configuration edits reload safely', async ({ page }) => {
    const original = JSON.parse(await fixture.read('.prnext-dev.json')).buildId;
    const source = counterSource().replace("{useState}", "{useState,useEffect}").replace('const[count,setCount]', 'useEffect(()=>{window.__devMounts=(window.__devMounts||0)+1;return()=>{}},[]);const[count,setCount]');
    await fixture.write('components/Counter.jsx', source);
    await fixture.write('prnext.config.mjs', `export default{basePath:'/docs',reactStrictMode:true}`);
    await expect.poll(async () => {
      const state=JSON.parse(await fixture.read('.prnext-dev.json'));
      const manifest=JSON.parse(await fixture.read('.prnext/manifest.json'));
      // Separate saves can legitimately produce an intermediate component-only
      // build. Wait for the requested configuration and its activated backend.
      return state.state==='ready'&&state.buildId!==original&&state.buildId===manifest.buildId&&manifest.config.reactStrictMode===true;
    }, { timeout: 20_000 }).toBe(true);
    for (const router of ['pages', 'app']) {
      await page.goto(`${fixture.url}/docs/${router}`);
      await expect.poll(() => page.evaluate(() => window.__devMounts)).toBe(2);
    }
    await page.evaluate(() => { window.__beforeConfigReload = true; });
    // Config edits replace the document. Observe that navigation before reading
    // window state, so an expected reload cannot destroy an in-flight evaluate.
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 20_000 }),
      fixture.write('prnext.config.mjs', `export default{basePath:'/docs',reactStrictMode:false}`),
    ]);
    await page.waitForLoadState('load');
    expect(await page.evaluate(() => window.__beforeConfigReload)).toBeUndefined();
    await expect(page.locator('#__prnext_reload_reason__')).toContainText('Project configuration changed');
    await expect.poll(() => page.evaluate(() => window.__devMounts)).toBe(1);
    await page.goto(`${fixture.url}/docs/pages`);
    await expect.poll(() => page.evaluate(() => window.__devMounts)).toBe(1);
  });
});
