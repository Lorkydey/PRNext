import { test, expect } from '@playwright/test';
import { ordinaryPrefetchFixture } from '../ordinary-prefetch-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await ordinaryPrefetchFixture(); await fixture.build(); server = await startServer(fixture.root); });
test.afterAll(async () => { try { await server?.close(); } finally { await fixture?.remove(); } });

async function network(page, values = {}) {
  await page.addInitScript(values => {
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
      if (url.pathname === '/target/private' && rsc) pending.then(async response => {
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
  }, values);
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
