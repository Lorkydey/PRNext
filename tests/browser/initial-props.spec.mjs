import { test, expect } from '@playwright/test';
import { initialPropsFixture } from '../initial-props-fixture.mjs';
import { startServer } from '../support.mjs';

const pageProps = page => page.getByTestId('page-props').textContent().then(JSON.parse);
const appProps = page => page.getByTestId('app-props').textContent().then(JSON.parse);
async function ready(page, url) { await page.goto(url); await page.waitForFunction(() => Boolean(window.__initialRouter)); }
function observe(page) {
  const errors = [], documents = [], data = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); if (request.url().includes('/_rustyx/data/')) data.push(request.url()); });
  return { errors, documents, data };
}

for (const customApp of [false, true]) test.describe(customApp ? 'custom App initial props' : 'Page initial props', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await initialPropsFixture({ customApp }); server = await startServer(fixture.root, ['--workers', '1']); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  test('hydrates server props once and loads subsequent Page hooks in the browser', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url + '/docs/legacy/initial?from=hydration');
    expect((await pageProps(page)).pageSource).toBe('server');
    expect(fixture.counts.get('page:initial:client')).toBeUndefined();
    if (customApp) expect((await appProps(page)).appSource).toBe('server');
    await page.getByTestId('app-count').click();
    await page.getByTestId('legacy-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Legacy client');
    const props = await pageProps(page);
    expect(props.pageSource).toBe('client');
    expect(props.seen).toMatchObject({ pathname: '/legacy/[slug]', query: { slug: 'client', from: 'link' }, server: false, visitor: null });
    expect(props.seen.asPath).toBe('/docs/legacy/client?from=link');
    expect(props.seen.url).toBeUndefined();
    expect(props.seen.status).toBeUndefined();
    expect(fixture.counts.get('page:client:server')).toBeUndefined();
    if (customApp) expect((await appProps(page)).appSource).toBe('client');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    await expect(page.getByTestId('page-heading')).toHaveCSS('color', 'rgb(43, 76, 109)');
    expect(seen.documents).toHaveLength(1);
    expect(seen.data).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('GSP and GSSP navigations consume server App props without client hooks', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    const before = fixture.counts.get('app:/server/[slug]:client');
    await page.getByTestId('app-count').click();
    await page.getByTestId('server-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Server data');
    expect((await pageProps(page)).dataSource).toBe('gssp');
    if (customApp) expect((await appProps(page)).appSource).toBe('server');
    expect(fixture.counts.get('app:/server/[slug]:client')).toBe(before);
    const staticBefore = fixture.counts.get('app:/static/[slug]:client');
    await page.getByTestId('static-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Static seed');
    expect((await pageProps(page)).dataSource).toBe('gsp');
    if (customApp) expect((await appProps(page)).appSource).toBe('server');
    expect(fixture.counts.get('app:/static/[slug]:client')).toBe(staticBefore);
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  });

  test('prefetch, shallow updates and hash changes do not run initial-props hooks', async ({ page }) => {
    await ready(page, server.url + '/docs/legacy/shallow?from=initial');
    const original = await pageProps(page);
    const appBefore = fixture.counts.get('app:/legacy/[slug]:client');
    await page.evaluate(() => window.__initialRouter.prefetch('/legacy/prefetched'));
    expect(fixture.counts.get('page:prefetched:client')).toBeUndefined();
    expect(fixture.counts.get('page:prefetched:server')).toBeUndefined();
    await page.evaluate(() => window.__initialRouter.push('/legacy/shallow?from=changed', undefined, { shallow: true }));
    expect(await pageProps(page)).toEqual(original);
    await page.evaluate(() => window.__initialRouter.push('/legacy/shallow?from=changed#hash'));
    expect(await pageProps(page)).toEqual(original);
    expect(fixture.counts.get('page:shallow:client')).toBeUndefined();
    expect(fixture.counts.get('app:/legacy/[slug]:client')).toBe(appBefore);
  });

  test('a superseded slow hook cannot replace a newer completed navigation', async ({ page }) => {
    await ready(page, server.url + '/docs');
    const release = fixture.hold('page:slow:client');
    try {
      await page.evaluate(() => { window.__slowInitialNavigation = window.__initialRouter.push('/legacy/slow'); });
      await expect.poll(() => fixture.counts.get('page:slow:client')).toBe(1);
      await page.evaluate(() => window.__initialRouter.push('/legacy/fast'));
      await expect(page.getByTestId('page-heading')).toHaveText('Legacy fast');
      release();
      expect(await page.evaluate(() => window.__slowInitialNavigation)).toBe(false);
      await expect(page.getByTestId('page-heading')).toHaveText('Legacy fast');
      expect((await pageProps(page)).seen.query.slug).toBe('fast');
    } finally { release(); }
  });

  test('hook failures preserve App state while React rendering failures remount it', async ({ page }) => {
    const seen = observe(page);
    await ready(page, server.url + '/docs/legacy/error-origin?from=initial');
    await page.getByTestId('app-count').click();
    const errorsBefore = fixture.counts.get('error:client') || 0;
    await page.getByTestId('failure-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Custom error');
    await expect(page).toHaveURL(server.url + '/docs/legacy/failure');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect((await pageProps(page)).seen).toMatchObject({ hadError: true, server: false, pathname: '/legacy/[slug]', asPath: '/legacy/error-origin?from=initial', query: { slug: 'error-origin', from: 'initial' } });
    expect(fixture.counts.get('error:client')).toBe(errorsBefore + 2);
    if (customApp) expect((await appProps(page)).appSource).toBe('client');
    await page.getByTestId('home-link').click();
    await expect(page.getByTestId('page-heading')).toHaveText('Home');
    await page.evaluate(() => window.__initialRouter.push('/legacy/render?renderFailure=1'));
    await expect(page.getByTestId('page-heading')).toHaveText('Custom error');
    await expect(page.getByTestId('app-count')).toHaveText('App 0');
    expect(fixture.counts.get('error:client')).toBe(errorsBefore + 3);
    expect(seen.documents).toHaveLength(1);
  });
});

test('config rewrites run hooks in the browser and matched middleware preserves the server pass', async ({ page }) => {
  const fixture = await initialPropsFixture({ withRouting: true }); let server;
  try {
    server = await startServer(fixture.root, ['--workers', '1']);
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    await page.getByTestId('app-count').click();
    for (const [link, injected, from] of [['alias-link', 'rule', 'alias'], ['proxy-link', 'proxy', 'proxy']]) {
      await page.getByTestId(link).click();
      await expect(page).toHaveURL(server.url + '/docs/' + (link === 'alias-link' ? 'alias' : 'via') + '/rewritten?from=' + from);
      await expect(page.getByTestId('page-heading')).toHaveText('Legacy rewritten');
      expect((await pageProps(page)).pageSource).toBe('client');
      expect((await pageProps(page)).seen.query).toEqual({ slug: 'rewritten', from, injected });
      await expect(page.getByTestId('app-count')).toHaveText('App 1');
      expect(fixture.counts.get('page:rewritten:server') || 0).toBe(link === 'alias-link' ? 0 : 1);
    }
    expect(fixture.counts.get('page:rewritten:server')).toBe(1);
    expect(fixture.counts.get('page:rewritten:client')).toBe(2);
    await page.evaluate(() => window.__initialRouter.push('/legacy/passed?from=next'));
    await expect(page.getByTestId('page-heading')).toHaveText('Legacy passed');
    expect(fixture.counts.get('page:passed:server')).toBe(1);
    expect(fixture.counts.get('page:passed:client')).toBe(1);
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});

test('explicit server responses behind middleware keep legacy navigation and rewrite context', async ({ page }) => {
  const fixture = await initialPropsFixture({ withRouting: true }); let server;
  try {
    server = await startServer(fixture.root, ['--workers', '1']);
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    await page.getByTestId('app-count').click();
    const cases = [
      ['/legacy/ended?status=200&from=next', 'next'],
      ['/via/ended?status=202&from=rewrite', 'rewrite'],
      ['/via/ended?status=200&from=json&body=json', 'json'],
      ['/via/ended?status=204&from=empty', 'empty'],
      ['/via/ended?status=204&from=discard&keep=visitor', 'discard'],
    ];
    for (let index = 0; index < cases.length; index++) {
      const [href, from] = cases[index];
      expect(await page.evaluate(href => window.__initialRouter.push(href), href)).toBe(true);
      await expect(page).toHaveURL(server.url + '/docs' + href);
      await expect(page.getByTestId('page-heading')).toHaveText('Legacy ended');
      expect((await pageProps(page)).pageSource).toBe('client');
      expect((await pageProps(page)).seen.query).toMatchObject({ slug: 'ended', from });
      if (from !== 'next') expect((await pageProps(page)).seen.query.injected).toBe('proxy');
      if (from === 'discard') expect((await pageProps(page)).seen.query).toMatchObject({ status: '200', dest: 'server', keep: 'visitor' });
      await expect(page.getByTestId('app-count')).toHaveText('App 1');
      expect(fixture.counts.get('page:ended:server')).toBe(index + 1);
      expect(fixture.counts.get('page:ended:client')).toBe(index + 1);
      expect(await page.evaluate(() => document.cookie)).toContain('legacy=ended');
    }
    expect(seen.documents).toHaveLength(1);
    expect(seen.errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});

test('middleware legacy redirects follow the server response while preserving Next route resolution', async ({ page }) => {
  const fixture = await initialPropsFixture({ withRouting: true }); let server;
  try {
    server = await startServer(fixture.root, ['--workers', '1']);
    const seen = observe(page);
    await ready(page, server.url + '/docs');
    await page.getByTestId('app-count').click();
    expect(await page.evaluate(() => window.__initialRouter.push('/legacy/redirected?from=next'))).toBe(true);
    await expect(page).toHaveURL(server.url + '/docs/legacy/redirected?from=next');
    await expect(page.getByTestId('page-heading')).toHaveText('Legacy redirected');
    expect((await pageProps(page)).pageSource).toBe('client');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(fixture.counts.get('page:redirected:server')).toBe(1);
    expect(fixture.counts.get('page:redirected:client')).toBe(1);
    expect(fixture.counts.get('page:redirect-target:server')).toBe(1);
    expect(fixture.counts.get('page:redirect-target:client')).toBeUndefined();
    expect(seen.documents).toHaveLength(1);
    expect(await page.evaluate(() => document.cookie)).toContain('legacy=redirected');

    // A final middleware redirect is a router control, unlike the hook's HTTP
    // redirect followed above. It selects a new route without replacing App.
    expect(await page.evaluate(() => window.__initialRouter.push('/legacy/redirected?viaMiddleware=1'))).toBe(true);
    await expect(page).toHaveURL(server.url + '/docs/legacy/final-control?from=middleware');
    await expect(page.getByTestId('page-heading')).toHaveText('Legacy final-control');
    expect((await pageProps(page)).pageSource).toBe('client');
    await expect(page.getByTestId('app-count')).toHaveText('App 1');
    expect(fixture.counts.get('page:redirected:server')).toBe(2);
    expect(fixture.counts.get('page:redirected:client')).toBe(1);
    expect(fixture.counts.get('page:final-control:client')).toBe(1);
    expect(fixture.counts.get('page:final-control:server')).toBeUndefined();
    expect(seen.documents).toHaveLength(1);

    // The fetch-follow response no longer carries the intermediate rewrite.
    // Next cannot resolve this alias, then visits it as a document and follows
    // the application's HTTP redirect a second time.
    await page.evaluate(() => { void window.__initialRouter.push('/via/redirected?from=alias'); });
    await expect(page).toHaveURL(server.url + '/docs/legacy/redirect-target?from=hook');
    await expect(page.getByTestId('page-heading')).toHaveText('Legacy redirect-target');
    await page.waitForFunction(() => Boolean(window.__initialRouter));
    expect((await pageProps(page)).pageSource).toBe('server');
    await expect(page.getByTestId('app-count')).toHaveText('App 0');
    expect(fixture.counts.get('page:redirected:server')).toBe(4);
    expect(fixture.counts.get('page:redirected:client')).toBe(1);
    expect(fixture.counts.get('page:redirect-target:server')).toBe(3);
    expect(fixture.counts.get('page:redirect-target:client')).toBeUndefined();
    expect(seen.documents.slice(1)).toEqual([
      server.url + '/docs/via/redirected?from=alias',
      server.url + '/docs/legacy/redirect-target?from=hook',
    ]);
    expect(seen.errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
