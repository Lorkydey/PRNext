import path from 'node:path';
import { test, expect } from '@playwright/test';
import { pagesNavigationFixture } from '../pages-navigation-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await pagesNavigationFixture(); server = await startServer(fixture.root, ['--workers', '2']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

async function ready(page, pathname = '/') {
  await page.goto(server.url + pathname);
  await page.waitForFunction(() => Boolean(window.__pagesRouter));
}
async function router(page) { return JSON.parse(await page.getByTestId('router').textContent()); }
async function props(page) { return JSON.parse(await page.getByTestId('server-props').textContent()); }
function failures(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  return errors;
}

test('Pages links preserve the document and _app state while loading page CSS, metadata and server props', async ({ page }) => {
  const errors = failures(page), documents = [];
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  await ready(page);
  await page.evaluate(() => { window.__samePagesDocument = true; window.__routeEvents.length = 0; });
  await page.getByTestId('app-count').click();
  await page.getByTestId('nav-other').click();
  await expect(page.getByTestId('other-heading')).toBeVisible();
  await expect(page.getByTestId('other-heading')).toHaveCSS('color', 'rgb(73, 19, 137)');
  await expect(page).toHaveTitle('Other page');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Other navigation page');
  await expect(page.getByTestId('app-count')).toHaveText('App count 1');
  expect(await page.evaluate(() => window.__routeEvents.map(event => event[0]))).toEqual(['routeChangeStart', 'beforeHistoryChange', 'routeChangeComplete']);
  await page.getByTestId('nav-server').click();
  await expect(page.getByRole('heading', { name: 'Server one', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Server one');
  await expect(page.locator('meta[name="description"]')).toHaveCount(0);
  expect((await props(page)).query.from).toBe('link');
  await expect(page.getByTestId('app-count')).toHaveText('App count 1');
  expect(await page.evaluate(() => [window.__samePagesDocument, window.__appMounts])).toEqual([true, 1]);
  expect(documents).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('URL objects update dynamic params and data while preserving the same page component state', async ({ page }) => {
  const errors = failures(page);
  await ready(page, '/server/object-one');
  await page.getByTestId('page-count').click();
  await expect(page.getByTestId('page-count')).toHaveText('Page count 1');
  expect(await page.evaluate(() => window.__pagesRouter.push({ pathname: '/server/[slug]', query: { slug: 'object-two', tag: ['a', 'b'] } }))).toBe(true);
  await expect(page.getByRole('heading', { name: 'Server object-two', exact: true })).toBeVisible();
  await expect(page.getByTestId('page-count')).toHaveText('Page count 1');
  expect((await router(page)).query).toEqual({ slug: 'object-two', tag: ['a', 'b'] });
  expect((await props(page)).query).toEqual({ slug: 'object-two', tag: ['a', 'b'] });
  expect(await page.evaluate(() => window.__pagesRouter.pathname)).toBe('/server/[slug]');
  expect(errors).toEqual([]);
});

test('href and as keep route parameters and data query separate from the displayed search', async ({ page }) => {
  const errors = failures(page);
  await ready(page);
  await page.evaluate(() => window.__pagesRouter.push('/server/[slug]', '/server/legacy?from=as'));
  await expect(page).toHaveURL(server.url + '/server/legacy?from=as');
  await expect(page.getByRole('heading', { name: 'Server legacy', exact: true })).toBeVisible();
  expect((await router(page)).query).toEqual({ slug: 'legacy' });
  expect((await props(page)).query).toEqual({ slug: 'legacy' });
  await page.evaluate(() => window.__pagesRouter.push({ pathname: '/server/[slug]', query: { slug: 'decorated', hidden: 'href' } }, '/server/decorated?visible=as'));
  await expect(page).toHaveURL(server.url + '/server/decorated?visible=as');
  expect((await router(page)).query).toEqual({ slug: 'decorated', hidden: 'href' });
  expect((await props(page)).query).toEqual({ slug: 'decorated', hidden: 'href' });
  expect(await page.evaluate(() => window.__pagesRouter.query)).toEqual({ slug: 'decorated', hidden: 'href' });
  expect(errors).toEqual([]);
});

test('shallow navigation changes router state without rerunning GSSP and does not cross page boundaries', async ({ page }) => {
  await ready(page, '/server/shallow?from=initial');
  const original = await props(page);
  await page.evaluate(() => { window.__routeEvents.length = 0; });
  expect(await page.evaluate(() => window.__pagesRouter.push('/server/shallow?from=changed', undefined, { shallow: true }))).toBe(true);
  expect((await router(page)).query.from).toBe('changed');
  expect(await props(page)).toEqual(original);
  expect(fixture.counts.get('server-shallow')).toBe(1);
  expect(await page.evaluate(() => window.__routeEvents)).toEqual([
    ['routeChangeStart', '/server/shallow?from=changed', { shallow: true }],
    ['beforeHistoryChange', '/server/shallow?from=changed', { shallow: true }],
    ['routeChangeComplete', '/server/shallow?from=changed', { shallow: true }],
  ]);
  await page.evaluate(() => window.__pagesRouter.push('/other', undefined, { shallow: true }));
  await expect(page.getByTestId('other-heading')).toBeVisible();
});

test('hash changes skip page data, report hash events and respect scroll:false', async ({ page }) => {
  await ready(page);
  const data = [];
  page.on('request', request => { if (request.url().includes('/_prnext/data/')) data.push(request.url()); });
  await page.evaluate(() => { window.__routeEvents.length = 0; });
  await page.evaluate(() => window.__pagesRouter.push('/#bottom'));
  await expect(page).toHaveURL(server.url + '/#bottom');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  expect(await page.evaluate(() => window.__routeEvents.map(event => event[0]))).toEqual(['hashChangeStart', 'hashChangeComplete']);
  const position = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.__pagesRouter.push('/#top', undefined, { scroll: false }));
  expect(await page.evaluate(() => window.scrollY)).toBe(position);
  expect(data).toEqual([]);
});

test('history back/forward and replace preserve _app, and beforePopState can decline a transition', async ({ page }) => {
  await ready(page);
  await page.getByTestId('app-count').click();
  await page.evaluate(() => window.__pagesRouter.push('/other'));
  await page.evaluate(() => window.__pagesRouter.replace('/server/history'));
  await expect(page.getByRole('heading', { name: 'Server history', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(server.url + '/');
  await expect(page.getByRole('heading', { name: 'Navigation home', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Server history', exact: true })).toBeVisible();
  await expect(page.getByTestId('app-count')).toHaveText('App count 1');
  await page.evaluate(() => window.__pagesRouter.beforePopState(state => { window.__declinedPop = state; return false; }));
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.__declinedPop?.as)).toBe('/');
  await expect(page.getByRole('heading', { name: 'Server history', exact: true })).toBeVisible();
  await page.evaluate(() => window.__pagesRouter.beforePopState(() => true));
});

test('superseded navigation is cancelled and cannot replace a newer page', async ({ page }) => {
  const errors = failures(page);
  await ready(page);
  const release = fixture.hold('server-slow');
  try {
    await page.evaluate(() => { window.__slowOutcome = window.__pagesRouter.push('/server/slow'); });
    await expect.poll(() => fixture.counts.get('server-slow') || 0).toBe(1);
    expect(await page.evaluate(() => window.__pagesRouter.push('/server/fast'))).toBe(true);
    await expect(page.getByRole('heading', { name: 'Server fast', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__slowOutcome)).toBe(false);
    release();
    expect(await page.evaluate(() => window.__routeEvents.some(event => event[0] === 'routeChangeError' && event[1]?.cancelled && event[2] === '/server/slow'))).toBe(true);
    await expect(page.getByRole('heading', { name: 'Server fast', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { release(); }
});

test('a blocked route module cannot prevent cancelling its navigation', async ({ page }) => {
  await ready(page);
  const route = fixture.manifest.routes.find(route => route.pattern === '/other');
  let release, seen = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(server.url + route.client, async request => { seen++; await gate; await request.continue(); });
  try {
    await page.evaluate(() => { void window.__pagesRouter.push('/other').then(value => { window.__blockedCodeResult = value; }); });
    await expect.poll(() => seen).toBe(1);
    expect(await page.evaluate(() => window.__pagesRouter.push('/server/after-blocked-code'))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__blockedCodeResult)).toBe(false);
    await expect(page.getByRole('heading', { name: 'Server after-blocked-code', exact: true })).toBeVisible();
  } finally { release(); }
});

test('rewrites and middleware retain the visible URL and correct server and router query', async ({ page, context }) => {
  const errors = failures(page);
  await context.addCookies([{ name: 'person', value: 'Ada', url: server.url }]);
  await ready(page);
  await page.evaluate(() => { window.__rewriteDocument = true; });
  await page.getByTestId('nav-alias').click();
  await expect(page.getByRole('heading', { name: 'Server book', exact: true })).toBeVisible();
  await expect(page).toHaveURL(server.url + '/alias/book?collision=visible&tag=a&tag=b');
  const rewritten = await router(page);
  expect(rewritten.pathname).toBe('/server/[slug]');
  expect(rewritten.query).toMatchObject({ slug: 'book', collision: 'target', injected: 'rewrite', tag: ['a', 'b'] });
  expect((await props(page)).query).toEqual(rewritten.query);
  await page.getByTestId('nav-middleware').click();
  await expect.poll(async () => (await props(page)).person).toBe('Ada');
  await expect.poll(async () => (await props(page)).query.injected).toBe('middleware');
  await expect(page).toHaveURL(server.url + '/via/book?from=middleware');
  expect((await router(page)).query).toMatchObject({ slug: 'book', from: 'middleware', injected: 'middleware' });
  expect(await page.evaluate(() => window.__rewriteDocument)).toBe(true);
  expect(errors).toEqual([]);
});

test('client navigation waits for new fallback data while leaving the old app interactive', async ({ page }) => {
  const errors = failures(page);
  await ready(page);
  const release = fixture.hold('static-browser-new');
  try {
    await page.evaluate(() => { window.__pendingStatic = window.__pagesRouter.push('/isr/browser-new?from=navigation'); });
    await expect.poll(() => fixture.counts.get('static-browser-new') || 0).toBe(1);
    await expect(page.getByRole('heading', { name: 'Navigation home', exact: true })).toBeVisible();
    await page.getByTestId('app-count').click();
    release();
    expect(await page.evaluate(() => window.__pendingStatic)).toBe(true);
    await expect(page.getByRole('heading', { name: 'Static browser-new', exact: true })).toBeVisible();
    await expect(page.getByTestId('static-fallback')).toHaveCount(0);
    await expect(page.getByTestId('app-count')).toHaveText('App count 1');
    expect((await router(page)).query.from).toBe('navigation');
    expect(errors).toEqual([]);
  } finally { release(); }
});

test('Pages redirects navigate within the app and notFound keeps the custom App mounted', async ({ page }) => {
  await ready(page);
  await page.getByTestId('app-count').click();
  await page.evaluate(() => { window.__outcomeDocument = true; });
  await page.evaluate(() => window.__pagesRouter.push('/outcome/redirect'));
  await expect(page).toHaveURL(server.url + '/server/redirected?from=data');
  await expect(page.getByRole('heading', { name: 'Server redirected', exact: true })).toBeVisible();
  await page.evaluate(() => window.__pagesRouter.push('/outcome/missing'));
  await expect(page.getByRole('heading', { name: '404', exact: true })).toBeVisible();
  await expect(page.getByTestId('app-count')).toHaveText('App count 1');
  expect(await page.evaluate(() => window.__outcomeDocument)).toBe(true);
  await page.getByTestId('nav-home').click();
  await expect(page.getByRole('heading', { name: 'Navigation home', exact: true })).toBeVisible();
});

test('prefetch loads static data but does not run getServerSideProps ahead of navigation', async ({ page }) => {
  await ready(page, '/prefetch');
  await expect.poll(() => fixture.counts.get('static-viewport') || 0).toBe(1);
  await page.evaluate(() => window.__pagesRouter.prefetch('/server/prefetched'));
  expect(fixture.counts.get('server-prefetched') || 0).toBe(0);
  await page.getByTestId('prefetch-server').click();
  await expect(page.getByRole('heading', { name: 'Server prefetched', exact: true })).toBeVisible();
  expect(fixture.counts.get('server-prefetched')).toBe(1);
});

test('prefetch does not retain private middleware rewrite data after the visitor cookie changes', async ({ page, context }) => {
  await context.addCookies([{ name: 'person', value: 'AdaPrefetch', url: server.url }]);
  await ready(page);
  await page.evaluate(() => window.__pagesRouter.prefetch('/isr/personal'));
  expect(fixture.counts.get('static-AdaPrefetch')).toBe(1);
  await context.addCookies([{ name: 'person', value: 'GracePrefetch', url: server.url }]);
  await page.evaluate(() => window.__pagesRouter.push('/isr/personal'));
  await expect(page.getByRole('heading', { name: 'Static GracePrefetch', exact: true })).toBeVisible();
  await expect(page).toHaveURL(server.url + '/isr/personal');
  expect(fixture.counts.get('static-GracePrefetch')).toBe(1);
});

test('cancelled link navigation stays put, and switching between Pages and App replaces the document', async ({ page }) => {
  await ready(page);
  await page.getByTestId('nav-cancelled').click();
  await expect(page).toHaveURL(server.url + '/');
  await page.evaluate(() => { window.__pagesOnly = true; });
  await page.getByTestId('nav-app').click();
  await expect(page.getByRole('heading', { name: 'Application side', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__pagesOnly)).toBeUndefined();
  await page.getByTestId('app-to-pages').click();
  await expect(page.getByRole('heading', { name: 'Navigation home', exact: true })).toBeVisible();
  await expect(page.getByTestId('app-count')).toHaveText('App count 0');
});

test('pure Pages navigation needs neither JSON requests nor a Node worker when no server routing is configured', async ({ page }) => {
  const pure = await pagesNavigationFixture({ withRouting: false });
  let native;
  try {
    native = await startServer(pure.root, ['--node', path.join(pure.root, 'missing-node')]);
    const dataRequests = [], documents = [], errors = failures(page);
    page.on('request', request => {
      if (request.url().includes('/_prnext/data/')) dataRequests.push(request.url());
      if (request.resourceType() === 'document') documents.push(request.url());
    });
    await page.goto(native.url);
    await page.waitForFunction(() => Boolean(window.__pagesRouter));
    await page.getByTestId('app-count').click();
    await page.getByTestId('nav-other').click();
    await expect(page.getByTestId('other-heading')).toHaveCSS('color', 'rgb(73, 19, 137)');
    await page.evaluate(() => window.__pagesRouter.push('/catch/one/%C3%A9?tag=a&tag=b'));
    await expect(page.getByTestId('catch-parts')).toHaveText('["one","é"]');
    expect((await router(page)).query).toEqual({ parts: ['one', 'é'], tag: ['a', 'b'] });
    await expect(page.getByTestId('app-count')).toHaveText('App count 1');
    expect(documents).toHaveLength(1);
    expect(dataRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await native?.close(); await pure.remove(); }
});
