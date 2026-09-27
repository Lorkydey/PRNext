import { test, expect } from '@playwright/test';
import { globalErrorFixture } from '../global-error-fixture.mjs';
import { startServer } from '../support.mjs';

const globalError = page => page.getByTestId('global-error').textContent().then(JSON.parse);
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

function observe(page) {
  const documents = [], flights = [], errors = [], messages = [], styles = [];
  page.on('request', request => {
    if (request.resourceType() === 'document') documents.push(request.url());
    if (request.headers().rsc === '1') flights.push(request.url());
    if (request.resourceType() === 'stylesheet') styles.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') messages.push(message.text()); });
  return { documents, flights, errors, messages, styles };
}

async function ready(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__globalRouter));
}

async function expectPublicServerError(page) {
  await expect(page.getByTestId('global-heading')).toHaveText('Global error');
  const error = await globalError(page);
  expect(error.isError).toBe(true);
  expect(error.message).not.toContain('PRIVATE_');
  expect(error.digest).toMatch(/^[a-f0-9]{16}$/);
  expect(error.reset).toBe('function'); expect(error.retry).toBe('function');
  return error;
}

test.describe('custom global App error', () => {
  let fixture, server, normalCss;
  test.beforeAll(async () => {
    fixture = await globalErrorFixture();
    const manifest = await fixture.build();
    normalCss = manifest.routes.find(route => route.pattern === '/' && route.router === 'app').css;
    server = await startServer(fixture.root, ['--workers', '1']);
  });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });
  test.beforeEach(() => {
    Object.assign(fixture.state, { rootFailure: false, pageFailure: false, ssrClientFailure: false });
    fixture.counts.clear();
  });

  test('early root failure sends an empty 500 document then loads global CSS and preserves error privacy', async ({ page }) => {
    const seen = observe(page);
    fixture.state.rootFailure = true;
    const response = await page.goto(server.url + '/docs');
    expect(response.status()).toBe(500);
    const html = await response.text();
    expect(html).toContain('id="__prnext_error__"');
    expect(html).not.toContain('data-testid="global-heading"');
    expect(html).not.toContain('PRIVATE_ROOT_SERVER_ERROR');
    await expectPublicServerError(page);
    await expect(page).toHaveTitle('Global recovery');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('normal-shell')).toHaveCount(0);
    await expect(page.getByTestId('global-heading')).toHaveCSS('color', 'rgb(130, 45, 91)');
    const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.href));
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every(href => href.startsWith(server.url + '/resources/_prnext/assets/'))).toBe(true);
    for (const href of normalCss) expect(seen.styles).not.toContain(new URL(href, server.url).href);
    expect(fixture.counts.get('root')).toBe(1);
    expect(seen.flights).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(seen.messages.join('\n')).not.toContain('PRIVATE_ROOT_SERVER_ERROR');
  });

  test('reset keeps a failed server model without refetch while retry requests one fresh Flight', async ({ page }) => {
    const seen = observe(page);
    fixture.state.rootFailure = true;
    await page.goto(server.url + '/docs');
    const original = await expectPublicServerError(page);
    await page.evaluate(() => { window.__globalDocumentMarker = 'same document'; });
    fixture.state.rootFailure = false;
    await page.getByTestId('global-reset').click();
    await settled(page);
    expect(await globalError(page)).toEqual(original);
    expect(seen.flights).toEqual([]);
    expect(fixture.counts.get('root')).toBe(1);
    await page.getByTestId('global-retry').click();
    await expect(page.getByTestId('healthy-heading')).toHaveText('Healthy home');
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 0');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 35, 46)');
    const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.href));
    expect(styles.length).toBe(new Set(styles).size);
    expect(seen.flights).toEqual([server.url + '/docs']);
    expect(fixture.counts.get('root')).toBe(2);
    expect(seen.documents).toHaveLength(1);
    expect(await page.evaluate(() => window.__globalDocumentMarker)).toBe('same document');
    expect(seen.errors).toEqual([]);
  });

  test('a root client crash preserves its exception and reset remounts locally without network', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    const initialStyles = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.href));
    expect(initialStyles.length).toBe(new Set(initialStyles).size);
    await page.getByTestId('layout-count').click();
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 1');
    await page.evaluate(() => { window.__globalDocumentMarker = 'client reset'; });
    await page.getByTestId('crash-root').click();
    await expect(page.getByTestId('global-heading')).toBeVisible();
    expect(await globalError(page)).toMatchObject({ message: 'CLIENT_ROOT_FAILURE', isError: true });
    expect((await globalError(page)).digest).toBeUndefined();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('global-heading')).toHaveCSS('color', 'rgb(130, 45, 91)');
    await page.getByTestId('global-reset').click();
    await expect(page.getByTestId('healthy-heading')).toHaveText('Healthy home');
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 0');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    const restoredStyles = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.href));
    expect(restoredStyles.length).toBe(new Set(restoredStyles).size);
    for (const href of initialStyles) expect(restoredStyles).toContain(href);
    expect(fixture.counts.get('root')).toBe(1);
    expect(seen.flights).toEqual([]);
    expect(seen.documents).toHaveLength(1);
    expect(await page.evaluate(() => window.__globalDocumentMarker)).toBe('client reset');
    expect(seen.errors).toEqual([]);
  });

  test('a root Client Component that failed SSR preserves its browser exception and can retry server props', async ({ page }) => {
    const seen = observe(page);
    fixture.state.ssrClientFailure = true;
    const response = await page.goto(server.url + '/docs');
    expect(response.status()).toBe(500);
    expect(await response.text()).toContain('id="__prnext_error__"');
    await expect(page.getByTestId('global-heading')).toBeVisible();
    expect(await globalError(page)).toMatchObject({ message: 'CLIENT_SSR_FAILURE', isError: true });
    expect((await globalError(page)).digest).toBeUndefined();
    fixture.state.ssrClientFailure = false;
    await page.getByTestId('global-reset').click();
    await settled(page);
    expect((await globalError(page)).message).toBe('CLIENT_SSR_FAILURE');
    expect(seen.flights).toEqual([]);
    expect(fixture.counts.get('root')).toBe(1);
    await page.getByTestId('global-retry').click();
    await expect(page.getByTestId('healthy-heading')).toHaveText('Healthy home');
    expect(seen.flights).toHaveLength(1);
    expect(fixture.counts.get('root')).toBe(2);
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  });

  test('server page failures use the nearest local boundary and escalate when no boundary exists', async ({ page }) => {
    const seen = observe(page);
    fixture.state.pageFailure = true;
    const response = await page.goto(server.url + '/docs/local');
    expect(response.status()).toBe(500);
    expect(await response.text()).not.toContain('data-testid="local-error"');
    await expect(page.getByTestId('local-error')).toBeVisible();
    await expect(page.getByTestId('normal-shell')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 35, 46)');
    await expect(page.getByTestId('global-heading')).toHaveCount(0);
    await expect(page.getByTestId('local-message')).not.toContainText('PRIVATE_LOCAL_SERVER_ERROR');
    await page.getByTestId('layout-count').click();
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 1');
    fixture.state.pageFailure = false;
    await page.getByTestId('local-reset').click();
    await settled(page);
    await expect(page.getByTestId('local-error')).toBeVisible();
    expect(seen.flights).toEqual([]);
    await page.getByTestId('local-retry').click();
    await expect(page.getByTestId('healthy-heading')).toHaveText('Recovered local page');
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 1');
    fixture.state.pageFailure = true;
    await page.getByTestId('unhandled').click();
    await expectPublicServerError(page);
    await expect(page.getByTestId('normal-shell')).toHaveCount(0);
    expect(fixture.counts.get('local')).toBe(2);
    expect(fixture.counts.get('unhandled')).toBe(1);
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  });

  test('an error after a streamed shell reaches global fallback without replaying the suspended page', async ({ page }) => {
    const seen = observe(page);
    fixture.state.pageFailure = true;
    const release = fixture.hold('late');
    try {
      const response = await page.goto(server.url + '/docs/late', { waitUntil: 'commit' });
      expect(response.status()).toBe(200);
      await expect(page.getByTestId('late-loading')).toBeVisible();
      await page.getByTestId('layout-count').click();
      await expect(page.getByTestId('layout-count')).toHaveText('Layout 1');
      release();
      await expectPublicServerError(page);
      const html = await response.text();
      expect(html).toContain('data-testid="late-loading"');
      expect(html).not.toContain('data-testid="global-heading"');
      expect(html).not.toContain('PRIVATE_LATE_SERVER_ERROR');
      expect(fixture.counts.get('late')).toBe(1);
      expect(fixture.counts.get('root')).toBe(1);
      expect(seen.flights).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally { release(); }
  });

  test('a failing local fallback escalates once to the custom global document', async ({ page }) => {
    const seen = observe(page);
    await page.addInitScript(() => { window.__localBoundaryCrash = true; });
    fixture.state.pageFailure = true;
    await page.goto(server.url + '/docs/local');
    await expect(page.getByTestId('global-heading')).toBeVisible();
    expect(await globalError(page)).toMatchObject({ message: 'CLIENT_LOCAL_BOUNDARY_FAILURE', isError: true });
    expect(fixture.counts.get('local')).toBe(1);
    expect(fixture.counts.get('root')).toBe(1);
    expect(seen.flights).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('a broken global fallback reaches the builtin document without a render or request loop', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    await page.evaluate(() => { window.__globalBoundaryCrash = true; });
    await page.getByTestId('crash-root').click();
    await expect(page.getByRole('heading')).toHaveText('This page couldn’t load');
    await expect(page.locator('html')).toHaveAttribute('id', '__prnext_error__');
    await expect(page.getByTestId('global-heading')).toHaveCount(0);
    await expect(page.getByTestId('normal-shell')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('CLIENT_GLOBAL_BOUNDARY_FAILURE');
    await settled(page);
    expect(seen.messages.length).toBeLessThan(10);
    expect(seen.flights).toEqual([]);
    expect(seen.documents).toHaveLength(1);
    expect(fixture.counts.get('root')).toBe(1);
    expect(seen.errors).toEqual([]);
  });

  test('navigation away from a global error recovers in the same document with a fresh layout state', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    await page.getByTestId('layout-count').click();
    await page.evaluate(() => { window.__globalDocumentMarker = 'navigation'; });
    fixture.state.pageFailure = true;
    await page.getByTestId('unhandled').click();
    await expectPublicServerError(page);
    await expect(page).toHaveURL(server.url + '/docs/unhandled');
    fixture.state.pageFailure = false;
    await page.getByTestId('global-home').click();
    await expect(page).toHaveURL(server.url + '/docs');
    await expect(page.getByTestId('healthy-heading')).toHaveText('Healthy home');
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 0');
    await expect(page).toHaveTitle('Normal document');
    expect(seen.flights).toHaveLength(2);
    expect(seen.documents).toHaveLength(1);
    expect(await page.evaluate(() => window.__globalDocumentMarker)).toBe('navigation');
    expect(seen.errors).toEqual([]);
  });
});

test('an application without global-error uses the builtin document for an early root failure', async ({ page }) => {
  const seen = observe(page);
  const fixture = await globalErrorFixture({ custom: false });
  let server;
  try {
    await fixture.build();
    fixture.state.rootFailure = true;
    server = await startServer(fixture.root, ['--workers', '1']);
    const response = await page.goto(server.url + '/docs');
    expect(response.status()).toBe(500);
    await expect(page.getByRole('heading')).toHaveText('This page couldn’t load');
    await expect(page.locator('body')).toContainText('A server error occurred. Reload to try again.');
    await expect(page.locator('body')).toContainText(/ERROR [a-f0-9]{16}/);
    await expect(page.locator('body')).not.toContainText('PRIVATE_ROOT_SERVER_ERROR');
    await expect(page.locator('html')).toHaveAttribute('id', '__prnext_error__');
    expect(fixture.counts.get('root')).toBe(1);
    expect(seen.flights).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
