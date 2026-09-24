import { test, expect } from '@playwright/test';
import { cacheComponentsFixture } from '../cache-components-fixture.mjs';
import { startServer } from '../support.mjs';

test('cached React trees hydrate client references, preserve opaque children and refresh after invalidation', async ({ page, context }) => {
  const fixture = await cacheComponentsFixture();
  let server;
  try {
    await fixture.build(); server = await startServer(fixture.root);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addCookies([{ name: 'tenant', value: 'a', url: server.url }, { name: 'private', value: 'one', url: server.url }]);
    await page.goto(server.url);
    await expect(page.getByTestId('private')).toHaveText('one');
    const initial = await page.getByTestId('cached').textContent();
    await page.getByRole('button', { name: 'Count 0' }).click();
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    await context.addCookies([{ name: 'private', value: 'two', url: server.url }]);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('private')).toHaveText('two');
    await expect(page.getByTestId('cached')).toHaveText(initial);
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    await page.request.post(server.url + '/clear');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('cached')).not.toHaveText(initial);
    await expect(page.getByRole('button', { name: 'Count 1' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
