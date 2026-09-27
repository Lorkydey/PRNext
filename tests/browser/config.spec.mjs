import { test, expect } from '@playwright/test';
import { configFixture } from '../config-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await configFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });
const value = async (page, id) => JSON.parse(await page.getByTestId(id).textContent());
function errorsOf(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

test('rewritten App navigation retains its visible URL, destination query and shared layout', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(server.url + '/');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__configDocument = 'same'; });
  await page.getByRole('link', { name: 'App alias', exact: true }).click();
  await expect(page.getByTestId('nav-path')).toHaveText('/app-alias/book');
  await expect(page).toHaveURL(server.url + '/app-alias/book?from=navigation&collision=visible');
  expect(await value(page, 'nav-query')).toEqual({ from: 'navigation', collision: 'visible' });
  expect(await value(page, 'app-server-data')).toEqual({ params: { slug: 'book' },
    query: { from: 'navigation', collision: 'dest', injected: 'dest' } });
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__configDocument)).toBe('same');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Config fixture home' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('cached direct Client pages restore rewrite props after hydration while hooks retain the browser query', async ({ page }) => {
  const errors = errorsOf(page);
  const response = await page.goto(server.url + '/client-alias/book?from=initial&collision=visible&tag=one&tag=two');
  expect(response.headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page.getByTestId('client-page-query')).toContainText('injected');
  expect(await value(page, 'client-page-query')).toEqual({ from: 'initial', collision: 'dest', tag: ['one', 'two'], injected: 'dest' });
  expect(await value(page, 'client-page-params')).toEqual({ slug: 'book' });
  expect(await value(page, 'nav-query')).toEqual({ from: 'initial', collision: 'visible', tag: 'two' });
  await expect(page.getByTestId('nav-path')).toHaveText('/client-alias/book');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  const flight = page.waitForResponse(response => response.url().includes('/client-alias/book?from=client') && response.request().headers().rsc === '1');
  await page.getByRole('link', { name: 'Client alias', exact: true }).click();
  const flightResponse = await flight;
  expect(flightResponse.headers()['x-nextjs-cache']).toBe('HIT');
  expect(flightResponse.headers()['x-prnext-rewrite']).toBeTruthy();
  await expect(page.getByTestId('client-page-query')).toContainText('client');
  expect(await value(page, 'client-page-query')).toEqual({ from: 'client', collision: 'dest', injected: 'dest' });
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Config fixture home' })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('client-page-query')).toContainText('initial');
  expect(errors).toEqual([]);
});

test('cached App aliases hydrate their visible pathname without recalculating the shared page', async ({ page }) => {
  const errors = errorsOf(page);
  const initialCount = fixture.counts.get('app:built');
  const response = await page.goto(server.url + '/cached-alias/built?from=initial');
  expect(response.headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page.getByTestId('nav-path')).toHaveText('/cached-alias/built');
  expect(await value(page, 'nav-query')).toEqual({ from: 'initial' });
  expect(await value(page, 'nav-params')).toEqual({ slug: 'built' });
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('link', { name: 'Cached alias', exact: true }).click();
  await expect(page.getByTestId('nav-path')).toHaveText('/cached-alias/built');
  expect(await value(page, 'nav-query')).toEqual({ from: 'cached' });
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(fixture.counts.get('app:built')).toBe(initialCount);
  expect(errors).toEqual([]);
});

test('rewritten Pages fallback data preserves injected queries and the interactive App wrapper', async ({ page }) => {
  const errors = errorsOf(page);
  const release = fixture.hold('pages:browser-fallback');
  try {
    await page.goto(server.url + '/fallback-alias/browser-fallback?from=original');
    await expect(page.getByTestId('fallback-loading')).toBeVisible();
    await page.getByRole('button', { name: 'Pages count: 0', exact: true }).click();
    release();
    await expect(page.getByTestId('fallback-data')).toBeVisible();
    const data = await value(page, 'fallback-data');
    expect(data.router).toEqual({ pathname: '/fallback/[slug]', asPath: '/fallback-alias/browser-fallback?from=original',
      query: { from: 'original', injected: 'dest', slug: 'browser-fallback' }, isFallback: false });
    await expect(page.getByRole('button', { name: 'Pages count: 1', exact: true })).toBeVisible();
    const response = await page.goto(server.url + '/fallback-alias/browser-fallback?from=another');
    expect(response.headers()['x-nextjs-cache']).toBe('HIT');
    await expect(page.getByTestId('fallback-data')).toContainText('another');
    expect((await value(page, 'fallback-data')).router.query).toEqual({ from: 'another', injected: 'dest', slug: 'browser-fallback' });
    expect(fixture.counts.get('pages:browser-fallback')).toBe(1);
    expect(errors).toEqual([]);
  } finally { release(); }
});

test('rewrite metadata cannot turn a route parameter into executable HTML', async ({ page }) => {
  const errors = errorsOf(page);
  const slug = '<img src=x onerror=window.__rewriteScriptRan=1>';
  await page.goto(server.url + '/client-alias/' + encodeURIComponent(slug));
  await expect(page.getByTestId('client-page-query')).toContainText('injected');
  expect(await value(page, 'client-page-params')).toEqual({ slug });
  expect(await page.evaluate(() => window.__rewriteScriptRan)).toBeUndefined();
  expect(errors).toEqual([]);
});

for (const javaScriptEnabled of [true, false]) {
  test(`rewritten Server Actions preserve visible URLs and destination query with JavaScript ${javaScriptEnabled ? 'enabled' : 'disabled'}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const errors = errorsOf(page);
    try {
      const url = server.url + '/action-alias?from=visible';
      await page.goto(url);
      await expect(page.getByTestId('action-count')).toHaveText('0');
      if (javaScriptEnabled) {
        await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
        await page.evaluate(() => { window.__rewriteActionDocument = 'same'; });
      }
      await page.getByRole('button', { name: 'Increment rewritten action', exact: true }).click();
      await expect(page.getByTestId('action-count')).toHaveText('1');
      await expect(page).toHaveURL(url);
      expect(await value(page, 'action-query')).toEqual({ from: 'visible', injected: 'dest' });
      await expect(page.getByTestId('nav-path')).toHaveText('/action-alias');
      expect(await value(page, 'nav-query')).toEqual({ from: 'visible' });
      if (javaScriptEnabled) {
        await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.__rewriteActionDocument)).toBe('same');
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
