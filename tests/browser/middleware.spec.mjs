import { test, expect } from '@playwright/test';
import { middlewareFixture } from '../middleware-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await middlewareFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });
const value = async (page, id) => JSON.parse(await page.getByTestId(id).textContent());
function errorsOf(page) { const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); return errors; }

test('middleware rewrites retain the visible URL, destination data and shared layout during App navigation', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(server.url + '/');
  await page.getByTestId('count').click();
  await page.evaluate(() => { window.__middlewareDocument = 'same'; });
  await page.getByTestId('app-link').click();
  await expect(page).toHaveURL(server.url + '/mw/app?visible=visitor');
  await expect(page.getByTestId('pathname')).toHaveText('/mw/app');
  await expect(page.getByTestId('query')).toHaveText('visible=visitor');
  await expect(page.getByTestId('server-state')).toContainText('fresh');
  expect(await value(page, 'server-state')).toEqual({ query: { dest: 'middleware' }, header: 'middleware', cookie: 'fresh' });
  await expect(page.getByTestId('count')).toHaveText('count 1');
  expect(await page.evaluate(() => window.__middlewareDocument)).toBe('same');
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Middleware fixture' })).toBeVisible();
  await expect(page.getByTestId('count')).toHaveText('count 1');
  expect(errors).toEqual([]);
});

test('cached middleware rewrites hydrate and navigate without sharing visitor URLs', async ({ page }) => {
  const errors = errorsOf(page);
  const response = await page.goto(server.url + '/mw/static?visible=initial');
  expect(response.headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page.getByTestId('pathname')).toHaveText('/mw/static');
  await expect(page.getByTestId('query')).toHaveText('visible=initial');
  await page.getByTestId('count').click();
  await page.getByTestId('app-link').click();
  await expect(page.getByTestId('server-state')).toBeVisible();
  await page.getByTestId('static-link').click();
  await expect(page.getByTestId('static-title')).toBeVisible();
  await expect(page.getByTestId('pathname')).toHaveText('/mw/static');
  await expect(page.getByTestId('query')).toHaveText('visible=cached');
  await expect(page.getByTestId('count')).toHaveText('count 1');
  expect(errors).toEqual([]);
});

test('middleware HTTP redirects commit their final App URL without replacing the shared layout', async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(server.url + '/');
  await page.getByTestId('count').click();
  await page.evaluate(() => { window.__middlewareDocument = 'same'; });
  await page.getByTestId('redirect-link').click();
  await expect(page).toHaveURL(server.url + '/static?redirect=middleware');
  await expect(page.getByTestId('pathname')).toHaveText('/static');
  await expect(page.getByTestId('query')).toHaveText('redirect=middleware');
  await expect(page.getByTestId('count')).toHaveText('count 1');
  expect(await page.evaluate(() => window.__middlewareDocument)).toBe('same');
  expect(errors).toEqual([]);
});

for (const javaScriptEnabled of [true, false]) test(`middleware rewrites forward Server Actions with JavaScript ${javaScriptEnabled ? 'enabled' : 'disabled'}`, async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage(), errors = errorsOf(page);
  try {
    const url = server.url + '/mw/action?visible=form';
    await page.goto(url);
    await expect(page.getByTestId('action-count')).toHaveText('0');
    if (javaScriptEnabled) await page.getByTestId('count').click();
    await page.getByRole('button', { name: 'Increment middleware action', exact: true }).click();
    await expect(page.getByTestId('action-count')).toHaveText('1');
    await expect(page).toHaveURL(url);
    expect(await value(page, 'action-query')).toEqual({ dest: 'middleware' });
    if (javaScriptEnabled) { await expect(page.getByTestId('pathname')).toHaveText('/mw/action'); await expect(page.getByTestId('count')).toHaveText('count 1'); }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
