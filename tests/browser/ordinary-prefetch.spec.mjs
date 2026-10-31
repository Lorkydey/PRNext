import { test, expect } from '@playwright/test';
import { ordinaryPrefetchFixture } from '../ordinary-prefetch-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server, manifest;
test.beforeAll(async () => { fixture = await ordinaryPrefetchFixture(); manifest = await fixture.build(); server = await startServer(fixture.root); });
test.afterAll(async () => { try { await server?.close(); } finally { await fixture?.remove(); } });

async function network(page, values = {}, capturePath = '/target/private') {
  await page.addInitScript(({values, capturePath}) => {
    const connection = new EventTarget();
    Object.assign(connection, { effectiveType: '4g', downlink: 10, saveData: false, ...values });
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: values.online !== false });
    const fetch = window.fetch;
    window.__ordinaryPrefetchRequests = [];
    window.fetch = function(input, init) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const rsc = new Headers(init?.headers).get('rsc') === '1';
      if (url.pathname.startsWith('/target/') && window.__ordinaryPrefetchRequests.length < 3) window.__ordinaryPrefetchRequests.push({ path: url.pathname, rsc });
      const pending = fetch.call(this, input, init);
      if (url.pathname === capturePath && rsc) pending.then(async response => {
        if (window.__ordinaryPrefetchBody) return;
        const record = { status: response.status, done: false };
        window.__ordinaryPrefetchBody = record;
        let reader;
        let bytes = 0, body = '';
        try {
          reader = response.clone().body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const {value, done} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 64 * 1024) throw new Error('Fixture Flight exceeds 64 KiB');
            body += decoder.decode(value, {stream: true});
          }
          record.body = body + decoder.decode();
        } catch (error) {
          record.error = String(error);
          void reader?.cancel().catch(() => {});
        } finally { reader?.releaseLock(); record.done = true; }
      }, () => {});
      return pending;
    };
  }, {values, capturePath});
  await page.bringToFront();
}

test('explicit Link prefetch works without Cache Components and never authorizes a later private navigation', async ({ page, context }) => {
  await network(page);
  await context.addCookies([{ name: 'visitor', value: 'prefetched-user', url: server.url, httpOnly: true }]);
  const responses = [];
  page.on('response', response => { if (new URL(response.url()).pathname === '/target/private' && response.request().headers().rsc === '1') responses.push(response); });
  await page.goto(server.url);
  await page.waitForFunction(() => window.__ordinaryPrefetchReady === true);
  await expect.poll(() => responses.length).toBe(1);
  const response = responses[0];
  expect(response.status()).toBe(200);
  // Observe the browser's actual response stream. Chromium may discard CDP's
  // copy of a streamed body even while this document is still current.
  await page.waitForFunction(() => window.__ordinaryPrefetchBody?.done === true);
  const prefetched = await page.evaluate(() => window.__ordinaryPrefetchBody);
  expect(prefetched.status).toBe(200);
  expect(prefetched.error).toBeUndefined();
  expect(prefetched.body).toContain('prefetched-user');
  for (const name of ['Default prefetch', 'Disabled prefetch']) {
    await page.getByRole('link', { name, exact: true }).focus();
    await page.getByRole('link', { name, exact: true }).hover();
  }
  expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([{ path: '/target/private', rsc: true }]);
  await context.addCookies([{ name: 'visitor', value: 'current-user', url: server.url, httpOnly: true }]);
  await page.evaluate(() => {
    window.__ordinaryPrefetchDocument = true;
    window.__exposedOldVisitor = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="visitor"]')?.textContent === 'prefetched-user') window.__exposedOldVisitor = true;
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole('link', { name: 'Explicit prefetch', exact: true }).click();
  await expect(page.getByTestId('visitor')).toHaveText('current-user');
  expect(await page.evaluate(() => ({ document: window.__ordinaryPrefetchDocument, oldVisitor: window.__exposedOldVisitor }))).toEqual({ document: true, oldVisitor: false });
  expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([
    { path: '/target/private', rsc: true }, { path: '/target/private', rsc: true },
  ]);
});

test('an SSG prefetch cannot bypass a proxy after its HttpOnly access cookie is revoked', async ({page, context}) => {
  expect(manifest.routes.find(route => route.pattern === '/target/protected')?.ssg).toBe(true);
  expect(manifest.prerendered.some(route => route.path === '/target/protected')).toBe(true);
  await network(page, {}, '/target/protected');
  await context.addCookies([{name: 'ssg-access', value: 'allowed', url: server.url, httpOnly: true}]);
  await page.goto(server.url + '/ssg-protected');
  await page.waitForFunction(() => window.__ordinaryStaticReady === true && window.__ordinaryPrefetchBody?.done === true);
  const warm = await page.evaluate(() => window.__ordinaryPrefetchBody);
  expect(warm.error).toBeUndefined(); expect(warm.status).toBe(200);
  expect(warm.body).toContain('ORDINARY_SSG_PROTECTED_CANARY');
  expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([{path: '/target/protected', rsc: true}]);
  await context.addCookies([{name: 'ssg-access', value: 'revoked', url: server.url, httpOnly: true}]);
  const denied = await context.request.get(server.url + '/target/protected', {maxRedirects: 0});
  expect(denied.status()).toBe(307);
  expect(new URL(denied.headers().location, server.url).pathname).toBe('/denied');
  await page.evaluate(() => {
    window.__ssgPrefetchDocument = true; window.__ssgProtectedExposed = false;
    const contains = value => value?.includes('ORDINARY_SSG_PROTECTED_CANARY');
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => contains(node.textContent)) ||
        record.type === 'characterData' && (contains(record.target.textContent) || contains(record.oldValue)))) window.__ssgProtectedExposed = true;
    }).observe(document, {subtree: true, childList: true, characterData: true, characterDataOldValue: true});
  });
  await page.getByRole('link', {name: 'Open protected', exact: true}).click();
  await expect(page.getByTestId('static-denied')).toHaveText('Access denied');
  await expect(page).toHaveURL(server.url + '/denied');
  await expect(page.getByTestId('static-protected')).toHaveCount(0);
  expect(await page.evaluate(() => ({document: window.__ssgPrefetchDocument, exposed: window.__ssgProtectedExposed}))).toEqual({document: true, exposed: false});
  expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([
    {path: '/target/protected', rsc: true}, {path: '/target/protected', rsc: true},
  ]);
});

test('an explicitly prefetched public SSG page still navigates in the current document after a fresh GET', async ({page}) => {
  expect(manifest.routes.find(route => route.pattern === '/target/public')?.ssg).toBe(true);
  expect(manifest.prerendered.some(route => route.path === '/target/public')).toBe(true);
  await network(page, {}, '/target/public');
  await page.goto(server.url + '/ssg-public');
  await page.waitForFunction(() => window.__ordinaryStaticReady === true && window.__ordinaryPrefetchBody?.done === true);
  const warm = await page.evaluate(() => window.__ordinaryPrefetchBody);
  expect(warm.error).toBeUndefined(); expect(warm.status).toBe(200);
  expect(warm.body).toContain('Public SSG destination');
  expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([{path: '/target/public', rsc: true}]);
  await page.evaluate(() => {window.__ssgPrefetchDocument = true;});
  await page.getByRole('link', {name: 'Open public', exact: true}).click();
  await expect(page.getByTestId('static-public')).toHaveText('Public SSG destination');
  await expect(page).toHaveURL(server.url + '/target/public');
  expect(await page.evaluate(() => window.__ssgPrefetchDocument)).toBe(true);
  expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([
    {path: '/target/public', rsc: true}, {path: '/target/public', rsc: true},
  ]);
});

for (const [name, values] of [['data saver', { saveData: true }], ['2g', { effectiveType: '2g' }], ['offline policy', { online: false }]]) {
  test(`explicit Link speculation respects ${name} while a real click still navigates`, async ({ page }) => {
    await network(page, values);
    await page.goto(server.url);
    await page.waitForFunction(() => window.__ordinaryPrefetchReady === true);
    const link = page.getByRole('link', { name: 'Explicit prefetch', exact: true });
    await link.focus(); await link.hover();
    expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([]);
    await link.click();
    await expect(page.getByTestId('visitor')).toHaveText('guest');
    expect(await page.evaluate(() => window.__ordinaryPrefetchRequests)).toEqual([{ path: '/target/private', rsc: true }]);
  });
}
