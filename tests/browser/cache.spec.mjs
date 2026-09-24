import { test, expect } from '@playwright/test';
import { cacheFixture } from '../cache-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await cacheFixture(); server = await startServer(fixture.root, ['--workers', '2']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

test('cached Server Components refresh after updateTag while preserving the interactive layout', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await expect(page.getByTestId('cached-value')).toHaveText('0');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update cached value', exact: true }).click();
  await expect(page.getByTestId('cached-value')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  const count = await page.getByTestId('cached-count').textContent();
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByTestId('cached-value')).toHaveText('1');
  await expect(page.getByTestId('cached-count')).toHaveText(count);
  expect(errors).toEqual([]);
});

test('native forms invalidate cached data when JavaScript is disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(server.url);
    const previous = Number(await page.getByTestId('cached-value').textContent());
    await page.getByRole('button', { name: 'Update cached value', exact: true }).click();
    await expect(page.getByTestId('cached-value')).toHaveText(String(previous + 1));
  } finally { await context.close(); }
});
