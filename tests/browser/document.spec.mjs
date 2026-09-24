import { test, expect } from '@playwright/test';
import { documentFixture } from '../document-fixture.mjs';
import { startServer } from '../support.mjs';

for (const variant of ['class', 'function']) test.describe('custom ' + variant + ' Document', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await documentFixture({ variant }); server = await startServer(fixture.root, ['--workers', '1']); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  test('hydrates Main and preserves the server-only document through Pages navigation', async ({ page }) => {
    const errors = [], documents = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /hydration|hydrating|server rendered/i.test(message.text())) errors.push(message.text()); });
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(server.url + '/docs');
    await page.waitForFunction(() => Boolean(window.__documentRouter));
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('html')).toHaveAttribute('data-document', variant);
    await expect(page.locator('#document-outside')).toBeVisible();
    await expect(page.locator('#document-footer')).toBeVisible();
    await page.locator('#document-outside').click();
    await page.getByTestId('app-count').click();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await page.getByTestId('page-count').click();
    await expect(page.getByTestId('page-count')).toHaveText('Page 1');
    await expect(page.getByTestId('page-heading')).toHaveCSS('color', 'rgb(12, 67, 123)');
    const documentCount = await page.locator('body').getAttribute('data-document-count');
    const calls = fixture.counts.get('/document');
    await page.evaluate(() => { window.__outsideNode = document.getElementById('document-outside'); });
    await page.getByTestId('server-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Server browser');
    await expect(page).toHaveTitle('Document Server browser');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(await page.locator('body').getAttribute('data-document-count')).toBe(documentCount);
    expect(fixture.counts.get('/document')).toBe(calls);
    expect(await page.evaluate(() => window.__outsideNode === document.getElementById('document-outside'))).toBe(true);
    await page.getByTestId('static-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Static seed');
    await expect(page.locator('meta[name="document-fixed"]')).toHaveAttribute('content', 'preserved');
    if (variant === 'class') await expect(page.locator('#document-collected')).toHaveCount(1);
    await page.getByTestId('missing-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Custom 404');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await page.getByTestId('home-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Home');
    expect(documents).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('direct SSR and custom 404 documents hydrate their own page', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const [pathname, status, label] of [['/server/direct?from=browser', 200, 'Server direct'], ['/unknown', 404, 'Custom 404']]) {
      const response = await page.goto(server.url + '/docs' + pathname);
      expect(response.status()).toBe(status);
      await page.waitForFunction(() => Boolean(window.__documentRouter));
      await expect(page.getByTestId('page-heading')).toHaveText(label);
      await page.getByTestId('page-count').click();
      await expect(page.getByTestId('page-count')).toHaveText('Page 1');
      await expect(page.locator('#document-footer')).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });

  if (variant === 'class') test('Document nonces allow hydration and navigation under a script CSP', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /content security policy|refused to|hydration/i.test(message.text())) errors.push(message.text()); });
    const response = await page.goto(server.url + '/docs/server/csp');
    expect(response.headers()['content-security-policy']).toContain("'nonce-doc-nonce'");
    await page.waitForFunction(() => Boolean(window.__documentRouter));
    await page.getByTestId('app-count').click();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await page.getByTestId('static-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Static seed');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(errors).toEqual([]);
  });

  if (variant === 'class') test('page viewport overrides reset on navigation without changing the Document head', async ({ page }) => {
    await page.goto(server.url + '/docs/viewport');
    await page.waitForFunction(() => Boolean(window.__documentRouter));
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveCount(1);
    await expect(viewport).toHaveAttribute('content', 'width=900');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Page override');
    await page.getByTestId('home-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Home');
    await expect(viewport).toHaveCount(1);
    await expect(viewport).toHaveAttribute('content', 'width=device-width');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'App default');
    await expect(page.locator('meta[name="document-fixed"]')).toHaveAttribute('content', 'preserved');
  });
});
