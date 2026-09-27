import { test, expect } from '@playwright/test';
import { fontFixture } from '../font-fixture.mjs';
import { startServer } from '../support.mjs';

test.describe('Fonts compiled at build time', () => {
  let fixture, server, manifest;
  test.beforeAll(async () => {
    fixture = await fontFixture();
    ({ manifest } = await fixture.build());
    server = await startServer(fixture.root);
  });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  for (const route of ['pages', 'app']) {
    test(`${route}: font CSS, inline style, variable and preload survive hydration without Google runtime access`, async ({ page }) => {
      const errors = [], google = [], fonts = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) google.push(request.url());
        if (request.resourceType() === 'font') fonts.push(request.url());
      });
      await page.route(/fonts\.(?:googleapis|gstatic)\.com/, route => route.abort());
      const response = await page.goto(`${server.url}/docs/${route}`);
      expect(response.status()).toBe(200);
      await page.getByRole('button', { name: 'count 0' }).click();
      await expect(page.getByRole('button', { name: 'count 1' })).toBeVisible();
      const family = await page.getByTestId('font').evaluate(element => getComputedStyle(element).fontFamily);
      expect(family).toContain('__prnext_local_');
      await expect(page.getByTestId('font-style')).toHaveCSS('font-family', family);
      await expect(page.getByTestId('variable')).toHaveCSS('font-family', family);
      const loaded = await page.evaluate(async () => {
        const element = document.querySelector('[data-testid="font"]');
        const family = getComputedStyle(element).fontFamily.split(',')[0];
        const faces = await document.fonts.load(`16px ${family}`, '\uea60');
        return faces.map(face => face.status);
      });
      expect(loaded.length).toBeGreaterThan(0);
      expect(loaded.every(status => status === 'loaded')).toBe(true);
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.every(url => url.startsWith(`${server.url}/resources/_prnext/assets/font-`))).toBe(true);
      const hints = page.locator('link[rel="preload"][as="font"]');
      await expect(hints).toHaveCount(1);
      await expect(hints.first()).toHaveAttribute('crossorigin', /^(?:anonymous)?$/);
      if (route === 'app') await expect(page.getByTestId('google')).toHaveCSS('font-family', /__prnext_Inter_/);
      expect(google).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('Pages navigation loads the next font CSS without a document reload', async ({ page }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs/other`);
    await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(0);
    await page.getByRole('link', { name: 'pages', exact: true }).click();
    await expect(page).toHaveURL(`${server.url}/docs/pages`);
    await expect(page.getByTestId('font')).toHaveCSS('font-family', /__prnext_local_/);
    await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'count 0' }).click();
    await expect(page.getByRole('button', { name: 'count 1' })).toBeVisible();
    expect(documents).toHaveLength(1);
  });
});
