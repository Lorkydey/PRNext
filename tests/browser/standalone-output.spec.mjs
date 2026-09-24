import { test, expect } from '@playwright/test';
import { standaloneOutputFixture, startStandalone } from '../standalone-output-fixture.mjs';

test('portable standalone hydrates Pages and App after source removal', async ({ page }) => {
  const fixture = await standaloneOutputFixture();
  let server;
  try {
    server = await startStandalone(fixture.root);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url + '/docs');
    await page.getByRole('button', { name: 'npm production count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'npm production count 1', exact: true })).toBeVisible();
    await expect(page.getByRole('heading')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await page.getByRole('link', { name: 'SSR', exact: true }).click();
    await expect(page).toHaveURL(server.url + '/docs/server');
    await page.getByRole('button', { name: 'count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'count 1', exact: true })).toBeVisible();
    await page.goto(server.url + '/docs/application');
    await expect(page.getByRole('heading')).toHaveText('Portable App npm-adjacent');
    await page.getByRole('button', { name: 'App count 0' }).click();
    await expect(page.getByRole('button', { name: 'App count 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Run action' }).click();
    await expect(page.locator('output')).toHaveText('action-adjacent');
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
