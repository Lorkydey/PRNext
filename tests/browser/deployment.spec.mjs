import { test, expect } from '@playwright/test';
import { deploymentFixture } from '../deployment-fixture.mjs';
import { startServer } from '../support.mjs';

function observe(page) {
  const errors = [], requests = [], documents = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/status of 404/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => {
    requests.push(request);
    if (request.resourceType() === 'document') documents.push(request.url());
  });
  return { errors, requests, documents };
}
async function hydrated(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
}
const state = (page, id) => page.getByTestId(id).textContent().then(JSON.parse);

for (const cdn of [false, true]) {
  test.describe(cdn ? 'basePath with cross-origin CDN' : 'basePath with origin assets', () => {
    let fixture, server;
    test.beforeAll(async () => { fixture = await deploymentFixture({ cdn }); server = await startServer(fixture.root, ['--workers', '2']); });
    test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

    test('Pages hydration and navigation retain the document and internal router paths', async ({ page }) => {
      const seen = observe(page);
      await page.goto(server.url + '/docs/plain');
      await page.waitForFunction(() => Boolean(window.__deploymentRouter));
      await expect(page.getByTestId('styled-title')).toHaveCSS('color', 'rgb(39, 83, 121)');
      await expect(page.getByTestId('imported-picture')).toHaveJSProperty('naturalWidth', 12);
      await expect(page.getByTestId('to-root')).toHaveAttribute('href', '/docs');
      await page.getByTestId('pages-count').click();
      await page.getByTestId('to-legacy').click();
      await expect(page.getByRole('heading', { name: 'Legacy one', exact: true })).toBeVisible();
      await expect(page).toHaveURL(server.url + '/docs/legacy/one?from=link');
      expect(await state(page, 'pages-router')).toEqual({ pathname: '/legacy/[slug]', asPath: '/legacy/one?from=link', basePath: '/docs', query: { from: 'link', slug: 'one' } });
      expect((await state(page, 'legacy-props')).url).toBe('/_rustyx/data/deployment-fixture/legacy/one.json?from=link');
      await page.evaluate(url => window.__deploymentRouter.replace(url), server.url + '/docs/legacy/absolute?from=absolute');
      await expect(page.getByRole('heading', { name: 'Legacy absolute', exact: true })).toBeVisible();
      await expect(page).toHaveURL(server.url + '/docs/legacy/absolute?from=absolute');
      await page.evaluate(() => window.__deploymentRouter.replace('/legacy/absolute?from=shallow#section', undefined, { shallow: true }));
      await expect.poll(async () => (await state(page, 'pages-router')).asPath).toBe('/legacy/absolute?from=shallow#section');
      expect((await state(page, 'legacy-props')).query.from).toBe('absolute');
      await page.goBack();
      await expect(page.getByTestId('styled-title')).toBeVisible();
      await page.getByTestId('to-root').click();
      await expect(page).toHaveURL(server.url + '/docs');
      await expect(page.getByRole('heading', { name: 'Deployment home', exact: true })).toBeVisible();
      await expect(page.getByTestId('pages-count')).toHaveText('Pages 1');
      expect(seen.documents).toHaveLength(1);
      expect(seen.errors).toEqual([]);
      expect(seen.requests.filter(request => request.url().includes('/_rustyx/data/')).every(request => request.url().startsWith(server.url + '/docs/_rustyx/data/'))).toBe(true);
      if (cdn) {
        expect(fixture.assetRequests.some(pathname => /pages-manifest-.*\.json$/.test(pathname))).toBe(true);
        expect(fixture.assetRequests.some(pathname => pathname.endsWith('.css'))).toBe(true);
        expect(fixture.assetRequests.some(pathname => pathname.endsWith('.svg'))).toBe(true);
      }
    });

    test('Pages rewrites, redirects and fallback navigation keep their basePath', async ({ page }) => {
      const seen = observe(page);
      await page.goto(server.url + '/docs');
      await page.waitForFunction(() => Boolean(window.__deploymentRouter));
      await page.getByTestId('pages-count').click();
      for (const [id, source, injected] of [['to-alias', 'alias', 'rule'], ['to-via', 'via', 'middleware']]) {
        await page.getByTestId(id).click();
        await expect(page).toHaveURL(server.url + `/docs/${source}/book?from=${source}`);
        await expect.poll(async () => (await state(page, 'legacy-props')).query.injected).toBe(injected);
        expect((await state(page, 'pages-router')).asPath).toBe(`/${source}/book?from=${source}`);
      }
      await page.evaluate(() => window.__deploymentRouter.push('/cached/browser-generated?from=browser'));
      await expect(page.getByRole('heading', { name: 'Cached browser-generated', exact: true })).toBeVisible();
      await expect(page).toHaveURL(server.url + '/docs/cached/browser-generated?from=browser');
      await page.evaluate(() => window.__deploymentRouter.push('/go/plain'));
      await expect(page.getByTestId('styled-title')).toBeVisible();
      await expect(page).toHaveURL(server.url + '/docs/plain');
      await expect(page.getByTestId('pages-count')).toHaveText('Pages 1');
      expect(seen.documents).toHaveLength(1);
      expect(seen.errors).toEqual([]);
    });

    test('App Flight navigation and lazy modules work with assets at the configured origin', async ({ page }) => {
      const seen = observe(page);
      await page.goto(server.url + '/docs/app');
      await hydrated(page);
      await expect(page.getByTestId('app-path')).toHaveText('/app');
      await page.getByTestId('app-count').click();
      await page.getByTestId('show-widget').click();
      await expect(page.getByTestId('deployed-widget')).toBeVisible();
      await page.getByTestId('deployed-widget').click();
      await expect(page.getByTestId('deployed-widget')).toHaveText('Deployed widget 1');
      await page.getByTestId('app-other').click();
      await expect(page).toHaveURL(server.url + '/docs/app/other?from=link');
      await expect(page.getByTestId('app-path')).toHaveText('/app/other');
      await expect(page.getByTestId('app-search')).toHaveText('from=link');
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Deployed application', exact: true })).toBeVisible();
      await expect(page.getByTestId('app-count')).toHaveText('App 1');
      expect(seen.documents).toHaveLength(1);
      expect(seen.errors).toEqual([]);
      const flight = seen.requests.filter(request => request.headers().rsc === '1');
      expect(flight.length).toBeGreaterThan(0);
      expect(flight.every(request => request.url().startsWith(server.url + '/docs/'))).toBe(true);
      if (cdn) expect(seen.requests.some(request => request.resourceType() === 'script' && request.url().startsWith(fixture.assetPrefix))).toBe(true);
    });

    test('Server Actions post to the application origin and refresh cookies without remounting', async ({ page }) => {
      const seen = observe(page);
      await page.goto(server.url + '/docs/app');
      await hydrated(page);
      await page.getByTestId('app-count').click();
      await page.getByTestId('increment-action').click();
      await expect(page.getByTestId('action-count')).toHaveText('1');
      await expect(page.getByTestId('app-count')).toHaveText('App 1');
      await page.getByTestId('redirect-action').click();
      await expect(page).toHaveURL(server.url + '/docs/app/other?from=action');
      await expect(page.getByRole('heading', { name: 'Application other', exact: true })).toBeVisible();
      await expect(page.getByTestId('app-count')).toHaveText('App 1');
      const actions = seen.requests.filter(request => request.headers()['next-action']);
      expect(actions).toHaveLength(2);
      expect(actions.every(request => request.url() === server.url + '/docs/app')).toBe(true);
      expect(seen.documents).toHaveLength(1);
      expect(seen.errors).toEqual([]);
    });

    test('switching between routers preserves the public deployment path', async ({ page }) => {
      const seen = observe(page);
      await page.goto(server.url + '/docs/plain');
      await page.waitForFunction(() => Boolean(window.__deploymentRouter));
      await page.getByTestId('to-app').click();
      await expect(page.getByRole('heading', { name: 'Deployed application', exact: true })).toBeVisible();
      await hydrated(page);
      await page.getByTestId('app-pages').click();
      await expect(page.getByTestId('styled-title')).toBeVisible();
      await expect(page).toHaveURL(server.url + '/docs/plain');
      expect(seen.documents).toHaveLength(3);
      expect(seen.errors).toEqual([]);
    });

    test('progressive forms run without JavaScript and accept an explicit public redirect', async ({ browser }) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.goto(server.url + '/docs/app');
        await page.getByTestId('increment-action').click();
        await expect(page.getByTestId('action-count')).toHaveText('1');
        await expect(page).toHaveURL(server.url + '/docs/app');
        const redirected = page.waitForResponse(response => response.request().method() === 'POST');
        await page.getByTestId('public-redirect-action').click();
        expect((await redirected).status()).toBe(303);
        await expect(page).toHaveURL(server.url + '/docs/app/other?from=public-action');
        await expect(page.getByRole('heading', { name: 'Application other', exact: true })).toBeVisible();
      } finally { await context.close(); }
    });
  });
}
