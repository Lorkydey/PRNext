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
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${fixture.url}/docs/${router}`);
    const counter = page.getByTestId('counter');
    await counter.click(); await counter.click();
    await expect(counter).toHaveText('Original 2');
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
    const original = JSON.parse(await fixture.read('.rustyx-dev.json')).buildId;
    const source = counterSource().replace("{useState}", "{useState,useEffect}").replace('const[count,setCount]', 'useEffect(()=>{window.__devMounts=(window.__devMounts||0)+1;return()=>{}},[]);const[count,setCount]');
    await fixture.write('components/Counter.jsx', source);
    await fixture.write('rustyx.config.mjs', `export default{basePath:'/docs',reactStrictMode:true}`);
    await expect.poll(async () => { const state = JSON.parse(await fixture.read('.rustyx-dev.json')); return state.state === 'ready' && state.buildId !== original; }, { timeout: 20_000 }).toBe(true);
    for (const router of ['pages', 'app']) {
      await page.goto(`${fixture.url}/docs/${router}`);
      await expect.poll(() => page.evaluate(() => window.__devMounts)).toBe(2);
    }
    await page.evaluate(() => { window.__beforeConfigReload = true; });
    await fixture.write('rustyx.config.mjs', `export default{basePath:'/docs',reactStrictMode:false}`);
    await expect.poll(() => page.evaluate(() => window.__beforeConfigReload), { timeout: 20_000 }).toBeUndefined();
    await expect.poll(() => page.evaluate(() => window.__devMounts)).toBe(1);
    await page.goto(`${fixture.url}/docs/pages`);
    await expect.poll(() => page.evaluate(() => window.__devMounts)).toBe(1);
  });
});
