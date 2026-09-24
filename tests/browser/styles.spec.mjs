import { test, expect } from '@playwright/test';
import { stylesFixture } from '../styles-fixture.mjs';
import { startServer } from '../support.mjs';

test.describe('PostCSS, Tailwind and Sass', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await stylesFixture(); await fixture.build(); server = await startServer(fixture.root); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });
  for (const router of ['pages', 'app']) test(`${router} styles survive hydration and navigation, including Sass partial image URLs`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(`${server.url}/docs/${router}`);
    expect(response.status()).toBe(200);
    const styled = page.getByTestId('styled');
    await expect(styled).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(styled).toHaveCSS('padding', '16px');
    await expect(styled).toHaveCSS('font-weight', '700');
    await expect(styled).toHaveCSS('letter-spacing', '1px');
    await expect(styled).toHaveCSS('text-decoration-line', 'underline');
    await expect(styled).toHaveCSS('user-select', 'none');
    await expect(page.locator('main')).toHaveCSS('border-top-color', 'rgb(12, 34, 56)');
    await expect(page.getByTestId('exported')).toHaveCSS('color', 'rgb(12, 34, 56)');
    const background = await styled.evaluate(node => getComputedStyle(node).backgroundImage);
    expect(background).toMatch(/\/resources\/_rustyx\/assets\/dot-[\w-]+\.svg/);
    const asset = await page.request.get(background.slice(5, -2));
    expect(asset.status()).toBe(200);
    expect(await asset.text()).toContain('<svg');
    await page.getByTestId('count').click();
    await expect(page.getByTestId('count')).toHaveText('Count 1');
    const classes = await styled.getAttribute('class');
    await page.evaluate(() => { window.__stylesDocument = true; });
    await page.getByTestId('next').click();
    await expect(page).toHaveURL(`${server.url}/docs/${router}/other`);
    await expect(styled).toHaveAttribute('class', classes);
    await expect(styled).toHaveCSS('padding', '16px');
    expect(await page.evaluate(() => window.__stylesDocument)).toBe(true);
    expect(errors).toEqual([]);
  });
});
