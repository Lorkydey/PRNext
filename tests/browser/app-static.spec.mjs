import { test, expect } from '@playwright/test';
import { appStaticFixture } from '../app-static-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await appStaticFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

test('cached HTML hydrates its actual query and cached Flight navigation preserves the layout', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const initial = await page.goto(server.url + '/?from=initial');
  expect(initial.headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page.getByTestId('client-query')).toHaveText('initial');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.evaluate(() => { window.__staticDocument = 'same'; });
  const response = page.waitForResponse(response => response.url().includes('/catalog/built') && response.request().headers().rsc === '1');
  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  expect((await response).headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page.getByRole('heading', { name: 'catalog/built', exact: true })).toBeVisible();
  await expect(page.getByTestId('client-path')).toHaveText('/catalog/built');
  await expect(page.getByTestId('client-query')).toHaveText('navigation');
  await expect(page).toHaveTitle('Product built | Static fixture');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__staticDocument)).toBe('same');
  await page.goBack();
  await expect(page.getByTestId('client-query')).toHaveText('initial');
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Server Actions invalidate cached HTML and update Flight without remounting the layout', async ({ page }) => {
  await page.goto(server.url);
  const previous = Number(await page.getByTestId('value').textContent());
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.getByRole('button', { name: 'Update static home', exact: true }).click();
  await expect(page.getByTestId('value')).toHaveText(String(previous + 1));
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('value')).toHaveText(String(previous + 1));
});

test('force-static leaves request-derived search parameters empty in the browser', async ({ page, context }) => {
  await context.addCookies([{ name: 'marker', value: 'secret', url: server.url }]);
  await page.goto(server.url + '/force-static?from=secret');
  await expect(page.getByTestId('forced')).toHaveText('{"header":null,"cookie":null,"query":null}');
  await expect(page.getByTestId('client-query')).toHaveText('none');
  await page.getByRole('link', { name: 'Plain', exact: true }).click();
  await expect(page.getByTestId('client-query')).toHaveText('plain');
});

test('cached server forms work without JavaScript and refresh the published page', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(server.url);
    const previous = Number(await page.getByTestId('value').textContent());
    await page.getByRole('button', { name: 'Update static home', exact: true }).click();
    await expect(page.getByTestId('value')).toHaveText(String(previous + 1));
  } finally { await context.close(); }
});

test('a freshly generated dynamic parameter produces hydratable cached HTML', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/catalog/browser-new?from=runtime');
  await expect(page.getByRole('heading', { name: 'catalog/browser-new', exact: true })).toBeVisible();
  await expect(page.getByTestId('client-query')).toHaveText('runtime');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  const response = await page.reload();
  expect(response.headers()['x-nextjs-cache']).toBe('HIT');
  expect(fixture.counts.get('catalog/browser-new')).toBe(1);
  expect(errors).toEqual([]);
});

test('cached redirect Flight navigates without a document reload or losing layout state', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__redirectDocument = 'same-document'; });
  const flight = page.waitForResponse(response => response.url() === server.url + '/redirect' && response.request().headers().rsc === '1');
  await page.getByRole('link', { name: 'Cached redirect', exact: true }).click();
  const response = await flight;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/x-component');
  expect(response.headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page).toHaveURL(server.url + '/plain');
  await expect(page.getByRole('heading', { name: 'Plain static', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__redirectDocument)).toBe('same-document');
  expect(errors).toEqual([]);
});

test('direct Client page searchParams hydrate and follow cached navigation and back history', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const initial = await page.goto(server.url + '/client-search?from=initial&tag=first&tag=second');
  expect(initial.headers()['x-nextjs-cache']).toBe('HIT');
  expect(await initial.text()).toContain('<p data-testid="page-query">none</p>');
  await expect(page.getByTestId('page-query')).toHaveText('initial');
  await expect(page.getByTestId('page-repeated')).toHaveText('["first","second"]');
  await expect(page.getByTestId('page-params')).toHaveText('{}');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__clientPageDocument = 'same-document'; });
  await page.getByRole('link', { name: 'Client page', exact: true }).click();
  await expect(page.getByTestId('page-query')).toHaveText('navigation');
  await expect(page.getByTestId('page-repeated')).toHaveText('["one","two"]');
  await page.goBack();
  await expect(page.getByTestId('page-query')).toHaveText('initial');
  await page.getByRole('link', { name: 'Plain', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Plain static', exact: true })).toBeVisible();
  const navigation = page.waitForResponse(response => response.url().includes('/client-search?from=navigation') && response.request().headers().rsc === '1');
  await page.getByRole('link', { name: 'Client page', exact: true }).click();
  expect((await navigation).headers()['x-nextjs-cache']).toBe('HIT');
  await expect(page.getByTestId('page-query')).toHaveText('navigation');
  await expect(page.getByTestId('page-repeated')).toHaveText('["one","two"]');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Plain static', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('page-query')).toHaveText('initial');
  await expect(page.getByTestId('page-repeated')).toHaveText('["first","second"]');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__clientPageDocument)).toBe('same-document');
  expect(errors).toEqual([]);
});

test('direct force-static Client pages stay empty and nested Client query props retain their values', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/client-force?from=secret&tag=hidden');
  await expect(page.getByTestId('page-query')).toHaveText('none');
  await expect(page.getByTestId('page-repeated')).toHaveText('[]');
  await page.getByRole('link', { name: 'Client page', exact: true }).click();
  await expect(page.getByTestId('page-query')).toHaveText('navigation');
  await page.getByRole('link', { name: 'Forced client page', exact: true }).click();
  await expect(page.getByTestId('page-query')).toHaveText('none');
  await page.getByRole('link', { name: 'Custom client props', exact: true }).click();
  await expect(page.getByTestId('custom-query')).toHaveText('component-owned');
  await expect(page.getByTestId('custom-params')).toHaveText('custom-id');
  expect(errors).toEqual([]);
});
