import { test, expect } from '@playwright/test';
import { routingFixture } from '../app-routing-fixture.mjs';
import { startServer } from '../support.mjs';

test.describe('Configuration aliases preserve restored App branches', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await routingFixture({ configurationAliases: true }); await fixture.build(); server = await startServer(fixture.root); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  for (const alias of ['config-before', 'config-after', 'config-fallback', 'config-restricted']) test(`${alias} retains state and isolated credentials through refresh and actions`, async ({ page, context }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs/${alias}`);
    await expect(page.getByTestId('source-context')).toHaveText('configuration-user:none:source');
    await page.getByRole('button', { name: 'source count 0' }).click();
    await context.clearCookies();
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('destination-context')).toHaveText('destination-user:current:none');
    for (const button of ['refresh route', 'mutate route']) {
      await context.clearCookies();
      const updated = page.waitForResponse(response => button === 'mutate route'
        ? response.request().headers()['next-action'] : response.request().headers()['x-rustyx-router-state']?.includes('refresh'));
      await page.getByRole('button', { name: button, exact: true }).click();
      expect((await updated).status()).toBe(200);
      await expect(page.getByTestId('source-context')).toHaveText('configuration-user:none:source');
      await expect(page.getByTestId('destination-context')).toHaveText('destination-user:current:none');
      await expect(page.getByRole('button', { name: 'source count 1' })).toBeVisible();
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Metadata configuration-user');
      await expect(page.getByRole('dialog')).toBeVisible();
    }
    expect(documents).toHaveLength(1);
  });

  test('a changed rewrite target discards the inaccessible background and loads the canonical destination', async ({ page, context }) => {
    await page.goto(`${server.url}/docs/config-switch`);
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await context.addCookies([{ name: 'version', value: 'next', url: server.url }]);
    await page.getByRole('button', { name: 'refresh route', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Canonical photo one' })).toBeVisible();
    await expect(page.getByTestId('source-context')).toHaveCount(0);
    await page.goto(`${server.url}/docs/config-switch`);
    await expect(page.getByRole('heading', { name: 'Login required' })).toBeVisible();
  });
});

test('configuration redirects recheck cookies changed by actions without middleware', async ({ page, context }) => {
  const fixture = await routingFixture({ configurationAliases: true, noMiddleware: true });
  let server;
  try {
    await fixture.build(); server = await startServer(fixture.root);
    await context.addCookies([{ name: 'auth', value: 'yes', url: server.url }]);
    await page.goto(`${server.url}/docs/config-gated`);
    await expect(page.getByRole('heading', { name: /Protected admin/ })).toBeVisible();
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'logout route', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Canonical photo one' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Protected admin/ })).toHaveCount(0);
    await page.goto(`${server.url}/docs/config-gated`);
    await expect(page.getByRole('heading', { name: 'Login required' })).toBeVisible();
    await expect(page).toHaveURL(`${server.url}/docs/login`);
  } finally { await server?.close(); await fixture.remove(); }
});
