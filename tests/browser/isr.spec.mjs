import { test, expect } from '@playwright/test';
import { isrFixture } from '../isr-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await isrFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

test('fallback hydration fills props without reloading or losing interactive app state', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const release = fixture.hold('fallback/browser');
  fixture.values.set('fallback/browser', { value: 41 });
  try {
    await page.goto(server.url + '/fallback/browser?from=client-query');
    await expect(page.getByTestId('fallback')).toBeVisible();
    await page.getByRole('button', { name: 'Persistent count: 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Persistent count: 1', exact: true })).toBeVisible();
    await page.evaluate(() => { window.__isrDocument = 'same-document'; });
  } finally { release(); }
  await expect(page.getByTestId('fallback')).toHaveCount(0);
  await expect(page.getByTestId('value')).toHaveText('41');
  await expect(page.getByTestId('id')).toHaveText('browser');
  await expect(page.getByTestId('query')).toHaveText('client-query');
  await expect(page.getByRole('button', { name: 'Persistent count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__isrDocument)).toBe('same-document');
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('value')).toHaveText('41');
  expect(fixture.counts.get('fallback/browser')).toBe(1);
});

test('cached HTML hydrates URL query parameters without contaminating the stored page', async ({ page }) => {
  await page.goto(server.url + '/blocking/query?from=one');
  await expect(page.getByTestId('query')).toHaveText('one');
  await expect(page.getByTestId('id')).toHaveText('query');
  await page.goto(server.url + '/blocking/query?from=two');
  await expect(page.getByTestId('query')).toHaveText('two');
  expect(fixture.counts.get('blocking/query')).toBe(1);
});

test('fallback data redirects and notFound outcomes leave no endless loading shell', async ({ page }) => {
  fixture.values.set('fallback/browser-redirect', { mode: 'redirect' });
  await page.goto(server.url + '/fallback/browser-redirect');
  await expect(page.getByRole('heading', { name: 'Redirect target' })).toBeVisible();
  fixture.values.set('fallback/browser-missing', { mode: 'notFound' });
  await page.goto(server.url + '/fallback/browser-missing');
  await expect(page.getByTestId('fallback')).toHaveCount(0);
  await expect(page.locator('body')).toContainText(/404|Not Found/i);
  expect(fixture.counts.get('fallback/browser-missing')).toBe(1);
});

test('a prerendered ISR page renders without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(server.url + '/seed');
    await expect(page.getByTestId('reason')).toHaveText('build');
    await expect(page.getByRole('heading', { name: 'Generated page' })).toBeVisible();
  } finally { await context.close(); }
});

test('an obsolete build data URL exits fallback without reloading or disabling the app', async ({ page }) => {
  const release = fixture.hold('fallback/stale-build');
  const documents = [];
  const dataRequests = [];
  page.on('request', request => {
    if (request.resourceType() === 'document') documents.push(request.url());
    if (request.url().includes('/_rustyx/data/')) dataRequests.push(request.url());
  });
  await page.route(server.url + '/fallback/stale-build', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(window\.__RUSTYX_DATA__=JSON\.parse\(.+?\);)(?=<\/script>)/s,
      bootstrap => `${bootstrap}window.__RUSTYX_DATA__.buildId="obsolete-build";`);
    expect(body).toContain('window.__RUSTYX_DATA__.buildId="obsolete-build";');
    await route.fulfill({ response, body });
  });
  try {
    await page.goto(server.url + '/fallback/stale-build');
    await expect(page.getByRole('heading', { name: '404', exact: true })).toBeVisible();
    await expect(page.getByTestId('fallback')).toHaveCount(0);
    await page.getByRole('button', { name: 'Persistent count: 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Persistent count: 1', exact: true })).toBeVisible();
    expect(documents).toHaveLength(1);
    expect(dataRequests).toEqual([server.url + '/_rustyx/data/obsolete-build/fallback/stale-build.json']);
  } finally { release(); }
});
