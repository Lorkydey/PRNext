import { test, expect } from '@playwright/test';
import { dynamicFixture } from '../dynamic-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await dynamicFixture(); server = await startServer(fixture.root, ['--workers', '1']); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

function errors(page) {
  const values = [];
  page.on('pageerror', error => values.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) values.push(message.text()); });
  return values;
}

async function hydrated(page, testId) {
  await page.waitForFunction(id => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    return element && Object.keys(element).some(key => key.startsWith('__reactProps$'));
  }, testId);
}

async function interceptChunks(page, marker) {
  const chunks = await fixture.chunks(marker);
  expect(chunks.length).toBeGreaterThan(0);
  const seen = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = async route => { seen.push(new URL(route.request().url()).pathname); await gate; await route.continue(); };
  for (const chunk of chunks) await page.route(server.url + chunk, handler);
  return { seen, release, chunks };
}

test('Pages waits for SSR dynamic chunks before hydrating the existing DOM', async ({ page }) => {
  const failures = errors(page);
  const pending = await interceptChunks(page, 'PAGES_DYNAMIC_INITIAL');
  try {
    await page.goto(server.url + '/dynamic-pages?name=browser', { waitUntil: 'commit' });
    await expect(page.getByTestId('pages-initial-count')).toHaveText('PAGES_DYNAMIC_INITIAL browser 0');
    await expect.poll(() => pending.seen.length).toBeGreaterThan(0);
    await page.evaluate(() => { window.__originalDynamicButton = document.querySelector('[data-testid="pages-initial-count"]'); });
    pending.release();
    await hydrated(page, 'pages-initial-count');
    await page.getByTestId('pages-initial-count').click();
    await expect(page.getByTestId('pages-initial-count')).toHaveText('PAGES_DYNAMIC_INITIAL browser 1');
    expect(await page.evaluate(() => window.__originalDynamicButton === document.querySelector('[data-testid="pages-initial-count"]'))).toBe(true);
    await expect(page.getByTestId('pages-browser-count')).toContainText('BROWSER_DYNAMIC_ONLY');
    expect(failures).toEqual([]);
  } finally { pending.release(); }
});

test('Pages conditional named components load their separate chunk only after interaction and apply CSS', async ({ page }) => {
  const failures = errors(page);
  const pending = await interceptChunks(page, 'PAGES_DYNAMIC_CONDITIONAL');
  try {
    await page.goto(server.url + '/dynamic-pages?name=conditional');
    await hydrated(page, 'pages-initial-count');
    await page.getByTestId('pages-initial-count').click();
    await expect(page.getByTestId('pages-initial-count')).toContainText('conditional 1');
    expect(pending.seen).toEqual([]);
    expect(await page.evaluate(() => window.__pagesConditional)).toBeUndefined();
    await page.getByTestId('show-pages').click();
    await expect.poll(() => pending.seen.length).toBeGreaterThan(0);
    await expect(page.getByTestId('pages-conditional-loading')).toBeVisible();
    pending.release();
    await expect(page.getByTestId('pages-conditional-count')).toHaveText('PAGES_DYNAMIC_CONDITIONAL conditional 0');
    await expect(page.getByTestId('pages-conditional-count')).toHaveCSS('color', 'rgb(13, 47, 91)');
    await page.getByTestId('pages-conditional-count').click();
    await expect(page.getByTestId('pages-conditional-count')).toContainText('conditional 1');
    expect(await page.evaluate(() => window.__pagesConditional)).toBe(1);
    expect(failures).toEqual([]);
  } finally { pending.release(); }
});

test('nested static Pages components hydrate without replacing their server content', async ({ page }) => {
  const failures = errors(page);
  await page.goto(server.url + '/dynamic-nested');
  await hydrated(page, 'pages-initial-count');
  await page.getByTestId('pages-initial-count').click();
  await expect(page.getByTestId('pages-initial-count')).toHaveText('PAGES_DYNAMIC_INITIAL nested 1');
  await expect(page.getByTestId('nested-dynamic')).toBeVisible();
  expect(failures).toEqual([]);
});

test('App dynamic components hydrate, defer conditional chunks and preserve the layout through navigation', async ({ page }) => {
  const failures = errors(page);
  const pending = await interceptChunks(page, 'APP_DYNAMIC_CONDITIONAL');
  try {
    await page.goto(server.url + '/app-dynamic');
    await hydrated(page, 'layout-count');
    await page.getByTestId('layout-count').click();
    await expect(page.getByTestId('layout-count')).toHaveText('layout 1');
    await hydrated(page, 'app-initial-count');
    await page.getByTestId('app-initial-count').click();
    await expect(page.getByTestId('app-initial-count')).toHaveText('APP_DYNAMIC_INITIAL count 1');
    await expect(page.getByTestId('app-browser-count')).toContainText('BROWSER_DYNAMIC_ONLY');
    expect(pending.seen).toEqual([]);
    expect(await page.evaluate(() => window.__appConditional)).toBeUndefined();
    await page.getByTestId('show-app').click();
    await expect(page.getByTestId('app-conditional-loading')).toBeVisible();
    await expect.poll(() => pending.seen.length).toBeGreaterThan(0);
    pending.release();
    await expect(page.getByTestId('app-conditional-count')).toHaveText('APP_DYNAMIC_CONDITIONAL app 0');
    await expect(page.getByTestId('app-conditional-count')).toHaveCSS('color', 'rgb(13, 47, 91)');
    await page.getByTestId('app-conditional-count').click();
    await expect(page.getByTestId('app-conditional-count')).toContainText('app 1');
    await page.evaluate(() => { window.__dynamicDocument = true; });
    await page.getByTestId('to-other').click();
    await expect(page).toHaveURL(server.url + '/app-other');
    await expect(page.getByTestId('layout-count')).toHaveText('layout 1');
    await page.getByTestId('to-dynamic').click();
    await expect(page).toHaveURL(server.url + '/app-dynamic');
    await expect(page.getByTestId('app-initial-count')).toBeVisible();
    expect(await page.evaluate(() => window.__dynamicDocument)).toBe(true);
    expect(await page.evaluate(() => window.__appConditional)).toBe(1);
    expect(failures).toEqual([]);
  } finally { pending.release(); }
});

test('client components reached through dynamic Server Components remain interactive', async ({ page }) => {
  const failures = errors(page);
  await page.goto(server.url + '/server-dynamic');
  await expect(page.getByTestId('server-dynamic-result')).toBeVisible();
  await hydrated(page, 'server-client-count');
  await page.getByTestId('server-client-count').click();
  await expect(page.getByTestId('server-client-count')).toHaveText('server child 1');
  await page.goto(server.url + '/server-client-dynamic');
  await hydrated(page, 'app-initial-count');
  await page.getByTestId('app-initial-count').click();
  await expect(page.getByTestId('app-initial-count')).toContainText('count 1');
  expect(failures).toEqual([]);
});

test('Pages loading components can retry a rejected dynamic loader', async ({ page }) => {
  const failures = errors(page);
  await page.goto(server.url + '/dynamic-retry');
  await hydrated(page, 'start-retry');
  await page.getByTestId('start-retry').click();
  await expect(page.getByTestId('dynamic-retry')).toBeVisible();
  await page.getByTestId('dynamic-retry').click();
  await expect(page.getByTestId('pages-initial-count')).toHaveText('PAGES_DYNAMIC_INITIAL retried 0');
  await page.getByTestId('pages-initial-count').click();
  await expect(page.getByTestId('pages-initial-count')).toContainText('retried 1');
  expect(failures).toEqual([]);
});

test('App dynamic import failures reach the nearest client error boundary', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(server.url + '/dynamic-error');
  await hydrated(page, 'load-broken');
  await page.getByTestId('load-broken').click();
  await expect(page.getByTestId('dynamic-error-boundary')).toContainText('DYNAMIC_CHUNK_IMPORT_FAILURE');
  expect(failures).toEqual([]);
});

test('failed App SSR dynamic loaders recover through the nearest client error boundary', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  for (const mode of ['loading', 'suspense']) {
    const response = await page.goto(server.url + '/dynamic-ssr-error/' + mode);
    expect(response.status()).toBe(200);
    await expect(page.getByTestId('dynamic-ssr-error-boundary')).toContainText('DYNAMIC_SSR_LOAD_FAILURE');
  }
  const fatal = await page.goto(server.url + '/dynamic-ssr-error/unbounded');
  expect(fatal.status()).toBe(500);
  const recovery = await fatal.text();
  expect(recovery).toContain('id="__prnext_error__"');
  expect(recovery).not.toContain('DYNAMIC_SSR_LOAD_FAILURE');
  expect(recovery).not.toContain('data-testid="dynamic-ssr-error-boundary"');
  // The original Flight rerenders the Client Component in the browser. Its
  // failing loader produces a client exception, preserving that public message.
  await expect(page.getByTestId('dynamic-ssr-error-boundary')).toContainText('DYNAMIC_SSR_LOAD_FAILURE');
  expect(failures).toEqual([]);
});

test('dynamic SSR remains visible without JavaScript while browser-only components show their fallback', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(server.url + '/dynamic-pages?name=no-js');
    await expect(page.getByTestId('pages-initial-count')).toHaveText('PAGES_DYNAMIC_INITIAL no-js 0');
    await expect(page.getByTestId('pages-browser-loading')).toBeVisible();
    await expect(page.getByTestId('pages-browser-count')).toHaveCount(0);
    await page.goto(server.url + '/app-dynamic');
    // App streaming can leave server-resolved content in a hidden React segment
    // when scripts are disabled. The client-only fallback itself must be present.
    await expect(page.getByTestId('app-browser-loading')).toBeVisible();
    await expect(page.getByTestId('app-browser-count')).toHaveCount(0);
  } finally { await context.close(); }
});
