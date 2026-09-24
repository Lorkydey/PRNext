import { test, expect } from '@playwright/test';
import { edgePagesFixture } from '../edge-pages-fixture.mjs';
import { startServer } from '../support.mjs';

for (const webpack of [false, true]) test(`Edge VM pages preserve styles, hydration and layout state (${webpack ? 'webpack' : 'esbuild'})`, async ({ page, context }) => {
  const fixture = await edgePagesFixture({ webpack }); let server;
  const errors = [], documents = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  try {
    await fixture.build(); server = await startServer(fixture.root);
    await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
    await context.addCookies([{ name: 'visitor', value: 'browser', url: server.url }]);
    const response = await page.goto(`${server.url}/docs/edge/one`);
    expect(response.status()).toBe(200);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(240, 245, 250)');
    await expect(page.getByRole('heading', { name: 'Edge one' })).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.getByTestId('edge-context')).toHaveText('edge-runtime:undefined:browser:browser:32:true');
    await expect(page.getByTestId('page')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'layout 0', exact: true }).click();
    await page.getByRole('button', { name: 'page 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'edge two', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edge two' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edge two' })).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
    await expect(page.getByTestId('page')).toContainText('2026:two:web:web-form:255:error');
    await expect(page).toHaveTitle('Edge two browser');
    await page.getByRole('button', { name: 'refresh page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'node page', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Node page function' })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(240, 245, 250)');
    await expect(page.getByTestId('node')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'node 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'node 1', exact: true })).toBeVisible();
    expect(documents).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
