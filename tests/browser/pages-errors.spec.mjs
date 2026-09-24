import { test, expect } from '@playwright/test';
import { pagesErrorsFixture } from '../pages-errors-fixture.mjs';
import { startServer } from '../support.mjs';

const props = page => page.getByTestId('error-props').textContent().then(JSON.parse);
const router = page => page.getByTestId('error-router').textContent().then(JSON.parse);
function observe(page) {
  const documents = [], errors = [];
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  return { documents, errors };
}
async function ready(page, origin, pathname = '') {
  await page.goto(origin + '/docs' + pathname);
  await page.waitForFunction(() => Boolean(window.__errorsRouter));
}

for (const staticErrors of [true, false]) test.describe(staticErrors ? 'static Pages errors' : 'custom dynamic _error', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await pagesErrorsFixture({ staticErrors }); server = await startServer(fixture.root, ['--workers', '1']); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  test('SSR errors hydrate the selected error component, assets and original visible URL', async ({ page }) => {
    const seen = observe(page);
    const response = await page.goto(server.url + '/docs/unknown?from=first');
    expect(response.status()).toBe(404);
    await page.waitForFunction(() => Boolean(window.__errorsRouter));
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toBeVisible();
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toHaveCSS('color', staticErrors ? 'rgb(29, 79, 131)' : 'rgb(97, 53, 139)');
    expect((await router(page)).asPath).toBe('/unknown?from=first');
    expect((await router(page)).pathname).toBe(staticErrors ? '/404' : '/_error');
    if (!staticErrors) expect((await props(page)).seen.server).toBe(true);
    await page.getByTestId('app-count').click();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await page.getByTestId('home').click();
    await expect(page.getByRole('heading', { name: 'Error fixture home', exact: true })).toBeVisible();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  });

  test('notFound transitions load custom props while preserving _app and the failed route snapshot', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url);
    await page.getByTestId('app-count').click();
    await page.getByTestId('missing-link').click();
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toBeVisible();
    await expect(page).toHaveURL(server.url + '/docs/outcome/missing?from=link');
    expect(await router(page)).toEqual({ pathname: '/outcome/[mode]', asPath: '/outcome/missing?from=link', query: { from: 'link', mode: 'missing' }, basePath: '/docs' });
    if (staticErrors) expect((await props(page)).label).toBe('static-404');
    else {
      const value = await props(page);
      expect(value.statusCode).toBe(404);
      expect(value.seen).toMatchObject({ server: false, hadError: false, pathname: '/_error', asPath: '/docs/outcome/missing?from=link', query: { from: 'link', mode: 'missing' } });
    }
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await page.getByTestId('home').click();
    await expect(page.getByRole('heading', { name: 'Error fixture home', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Error fixture home');
    await page.goBack();
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toBeVisible();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  });

  test('rewritten and fallback notFound responses recover without a reload loop', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url);
    await page.getByTestId('app-count').click();
    await page.getByTestId('alias-link').click();
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toBeVisible();
    await expect(page).toHaveURL(server.url + '/docs/alias-missing?from=link');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await page.getByTestId('fallback-link').click();
    await expect(page).toHaveURL(server.url + '/docs/static/absent');
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toBeVisible();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(seen.documents).toHaveLength(1);
    await page.goto(server.url + '/docs/fallback/browser-missing');
    await expect(page.getByTestId(staticErrors ? 'custom-404' : 'custom-error')).toBeVisible();
    await expect(page.getByTestId('missing-fallback')).toHaveCount(0);
    await page.getByTestId('app-count').click();
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(seen.documents).toHaveLength(2);
    expect(seen.errors).toEqual([]);
  });

  test('a server data exception loads the server error document without exposing its private message', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url);
    await page.getByTestId('app-count').click();
    await page.getByTestId('data-link').click();
    await expect(page.getByTestId(staticErrors ? 'custom-500' : 'custom-error')).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__errorsRouter));
    await expect(page).toHaveURL(server.url + '/docs/outcome/data?from=link');
    expect((await router(page)).pathname).toBe(staticErrors ? '/500' : '/_error');
    await expect(page.getByTestId('app-count')).toHaveText('App 0');
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_SERVER_DATA_ERROR');
    await page.getByTestId('home').click();
    await expect(page.getByRole('heading', { name: 'Error fixture home', exact: true })).toBeVisible();
    expect(seen.documents).toHaveLength(2);
    expect(seen.errors).toEqual([]);
  });

  test('a React rendering error loads _error, remounts _app and remains recoverable', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url, '/late');
    await page.getByTestId('app-count').click();
    await page.getByTestId('crash-client').click();
    await expect(page.getByTestId('custom-error')).toHaveText('Custom error client');
    const value = await props(page);
    expect(value.statusCode).toBeUndefined();
    expect(value.seen).toMatchObject({ server: false, hadError: true, pathname: '/late', asPath: '/late', query: {} });
    await expect(page.getByTestId('app-count')).toHaveText('App 0');
    await page.getByTestId('home').click();
    await expect(page.getByRole('heading', { name: 'Error fixture home', exact: true })).toBeVisible();
    await page.getByTestId('app-count').click();
    await page.getByTestId('render-link').click();
    await expect(page.getByTestId('custom-error')).toHaveText('Custom error client');
    await expect(page).toHaveURL(server.url + '/docs/outcome/render?from=link');
    await expect(page.getByTestId('app-count')).toHaveText('App 0');
    expect((await router(page)).pathname).toBe('/outcome/[mode]');
    expect(seen.documents).toHaveLength(1);
  });
});

test('mixed App global not-found hydrates the App layout and preserves the public missing URL', async ({ page }) => {
  const fixture = await pagesErrorsFixture({ mixed: true }); let server;
  try {
    server = await startServer(fixture.root, ['--workers', '1']);
    const seen = observe(page);
    const response = await page.goto(server.url + '/docs/unknown?from=app');
    expect(response.status()).toBe(404);
    await expect(page.getByTestId('app-global-missing')).toBeVisible();
    await expect(page.getByTestId('app-pathname')).toHaveText('/unknown');
    await page.getByTestId('app-layout-count').click();
    await expect(page.getByTestId('app-layout-count')).toHaveText('Layout 1');
    await page.getByRole('link', { name: 'Application', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Healthy application page', exact: true })).toBeVisible();
    await expect(page.getByTestId('app-layout-count')).toHaveText('Layout 1');
    await page.getByRole('link', { name: 'App missing', exact: true }).click();
    await expect(page.getByTestId('app-global-missing')).toBeVisible();
    await expect(page.getByTestId('app-pathname')).toHaveText('/application-missing');
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});

test('a broken client _error has a terminal fallback instead of retrying or reloading forever', async ({ page }) => {
  const fixture = await pagesErrorsFixture({ staticErrors: false, brokenError: true }); let server;
  try {
    server = await startServer(fixture.root, ['--workers', '1']);
    const seen = observe(page);
    await ready(page, server.url, '/late');
    await page.getByTestId('crash-client').click();
    await expect(page.getByRole('heading')).toContainText(/client-side exception|Application error|500/);
    expect(seen.documents).toHaveLength(1);
  } finally { await server?.close(); await fixture.remove(); }
});
