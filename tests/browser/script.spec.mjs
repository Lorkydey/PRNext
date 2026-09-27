import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { scriptFixture } from '../script-fixture.mjs';
import { startServer } from '../support.mjs';

function observe(page) {
  const errors = [], documents = [], workers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  page.on('worker', worker => workers.push(worker.url()));
  return { errors, documents, workers };
}
const events = page => page.evaluate(() => window.__scriptEvents || []);
const countEvent = (values, name) => values.filter(value => value === name).length;
async function ready(page, url) {
  const response = await page.goto(url);
  await page.waitForFunction(() => window.__scriptHydrated && window.__scriptEvents.includes('lazy:ready') && window.__scriptEvents.includes('missing:error:error'));
  return response;
}

test.describe('Script loading', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await scriptFixture(); await fixture.build(); server = await startServer(fixture.root); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });
  test.beforeEach(() => fixture.counts.clear());

  for (const router of ['pages', 'app']) {
    test(`${router}: load callbacks, duplicate sources, inline execution and remount match Next`, async ({ page }) => {
      const seen = observe(page);
      await ready(page, `${server.url}/docs/${router}`);
      const initial = await events(page);
      const before = initial.filter(value => ['inline-first:exec', 'inline-second:exec', 'before-first.js:exec', 'before-second.js:exec'].includes(value));
      expect(before).toEqual(router === 'app'
        ? ['inline-first:exec', 'before-first.js:exec', 'inline-second:exec', 'before-second.js:exec']
        : ['inline-first:exec', 'inline-second:exec', 'before-first.js:exec', 'before-second.js:exec']);
      expect(initial.indexOf('before-second.js:exec')).toBeLessThan(initial.findIndex(value => value.startsWith('hydrate:')));
      expect(initial.indexOf('after.js:exec')).toBeLessThan(initial.indexOf('after:load:load:SCRIPT'));
      expect(initial.indexOf('after:load:load:SCRIPT')).toBeLessThan(initial.indexOf('after:ready'));
      expect(initial).toContain('inline:ready:undefined'); expect(initial).not.toContain('inline:load');
      expect(initial.indexOf('inline:ready:undefined')).toBeLessThan(initial.indexOf('inline:exec'));
      expect(initial).toContain('dup1:load'); expect(initial).toContain('dup1:ready'); expect(initial).toContain('dup2:load'); expect(initial).not.toContain('dup2:ready');
      expect(initial).toContain('lazy:load:complete');
      await expect(page.getByTestId('script-heading')).toHaveCSS('color', 'rgb(12, 34, 56)');
      expect(await page.locator('script#after').evaluate(node => ({ nonce: node.nonce, async: node.async, attribute: node.getAttribute('data-probe'), strategy: node.getAttribute('data-nscript') }))).toEqual({ nonce: 'script-nonce', async: false, attribute: 'forwarded', strategy: 'afterInteractive' });
      for (const name of ['after.js', 'duplicate.js', 'lazy.js', 'missing.js', 'after.css']) expect(fixture.counts.get(name), name).toBe(1);

      await page.getByTestId('toggle-scripts').click();
      await expect(page.getByTestId('toggle-scripts')).toHaveText('Show scripts');
      await page.getByTestId('toggle-scripts').click();
      await expect.poll(async () => countEvent(await events(page), 'after:ready')).toBe(2);
      await expect.poll(async () => (await events(page)).includes('missing:load')).toBe(true);
      const remount = await events(page);
      expect(countEvent(remount, 'after:load:load:SCRIPT')).toBe(1);
      expect(countEvent(remount, 'dup1:ready')).toBe(2); expect(countEvent(remount, 'dup2:ready')).toBe(1);
      expect(remount).toContain('inline:ready:1');
      expect(countEvent(remount, 'inline:exec')).toBe(1);
      expect(countEvent(remount, 'missing:error:error')).toBe(1);
      expect(remount).not.toContain('missing:ready');
      for (const name of ['after.js', 'duplicate.js', 'lazy.js', 'missing.js', 'after.css']) expect(fixture.counts.get(name), name).toBe(1);
      expect(await page.locator(`link[rel="stylesheet"][href="${fixture.originURL}/after.css"]`).count()).toBe(1);
      expect(seen.errors).toEqual([]);
    });

    test(`${router}: beforeInteractive completion precedes hydration even when its source is delayed`, async ({ page }) => {
      const release = fixture.hold('before-first.js');
      const seen = observe(page);
      try {
        await page.goto(`${server.url}/docs/${router}`, { waitUntil: 'commit' });
        await expect.poll(() => fixture.counts.get('before-first.js') || 0).toBe(1);
        expect(await page.evaluate(() => Boolean(window.__scriptHydrated))).toBe(false);
        expect(fixture.counts.get('lazy.js') || 0).toBe(0);
        release();
        await page.waitForFunction(() => window.__scriptHydrated);
        const values = await events(page);
        const hydrated = values.findIndex(value => value.startsWith('hydrate:'));
        expect(values.indexOf('before-first.js:exec')).toBeGreaterThanOrEqual(0);
        expect(values.indexOf('before-second.js:exec')).toBeLessThan(hydrated);
        await page.waitForFunction(() => window.__scriptEvents.includes('lazy:ready') && window.__scriptEvents.includes('missing:error:error'));
        expect(seen.errors).toEqual([]);
      } finally { release(); }
    });

    test(`${router}: lazyOnload waits for window load while afterInteractive runs`, async ({ page }) => {
      const release = fixture.hold('load-gate.png');
      try {
        await page.goto(`${server.url}/docs/${router}-lazy`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__scriptHydrated && window.__scriptEvents.includes('after:ready'));
        expect(fixture.counts.get('load-gate.png')).toBe(1);
        expect(fixture.counts.get('lazy.js') || 0).toBe(0);
        expect(await page.evaluate(() => document.readyState)).not.toBe('complete');
        release();
        await page.waitForFunction(() => window.__scriptEvents.includes('lazy:ready'));
        expect(await events(page)).toContain('lazy:load:complete');
        expect(fixture.counts.get('lazy.js')).toBe(1);
      } finally { release(); }
    });

    test(`${router}: navigation remounts ready callbacks without reloading sources or the document`, async ({ page }) => {
      const seen = observe(page);
      await ready(page, `${server.url}/docs/${router}`);
      await page.evaluate(() => { window.__scriptDocument = 'preserved'; });
      await page.getByTestId('script-next').click();
      await expect(page).toHaveURL(`${server.url}/docs/${router}-other`);
      await expect(page.getByTestId('script-heading')).toHaveText(router === 'app' ? 'Other App scripts' : 'Other Pages scripts');
      await expect.poll(async () => countEvent(await events(page), 'after:ready')).toBe(2);
      expect(await page.evaluate(() => window.__scriptDocument)).toBe('preserved');
      expect(seen.documents).toHaveLength(1);
      for (const name of ['before-first.js', 'before-second.js', 'after.js', 'duplicate.js', 'lazy.js', 'missing.js']) expect(fixture.counts.get(name), name).toBe(1);
      expect(seen.errors).toEqual([]);
    });
  }

  test('an App beforeInteractive network error stops the remaining queue but still hydrates the application', async ({ page }) => {
    const seen = observe(page);
    await ready(page, `${server.url}/docs/before-failure`);
    expect(fixture.counts.get('before-missing.js')).toBe(1);
    expect(await page.evaluate(() => window.__afterFailedBefore)).toBeUndefined();
    await page.getByTestId('script-count').click();
    await expect(page.getByTestId('script-count')).toHaveText('Count 1');
    expect(seen.errors).toEqual([]);
  });
});

test('Pages worker strategy runs the installed Partytown library in a real Worker', async ({ page }) => {
  const require = createRequire(import.meta.url);
  const workerPackage = path.dirname(require.resolve('@builder.io/partytown/package.json'));
  const fixture = await scriptFixture({ workerPackage });
  let server;
  try {
    const manifest = await fixture.build();
    expect(manifest.scriptWorkers).toBeTruthy();
    server = await startServer(fixture.root);
    const seen = observe(page);
    const response = await ready(page, `${server.url}/docs/pages`);
    const html = await response.text();
    const descriptors = JSON.parse(html.match(/<script\b[^>]*\bid="__PRNEXT_SCRIPT_LOADER__"[^>]*>([^<]*)<\/script>/)?.[1] || '[]');
    expect(descriptors).toContainEqual({ id: 'worker', strategy: 'worker', src: `${fixture.originURL}/worker.js` });
    await expect(page.locator('html')).toHaveAttribute('data-worker-result', '42', { timeout: 15000 });
    expect(seen.workers.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__workerPrivate)).toBeUndefined();
    expect(fixture.counts.get('worker.js')).toBe(1);
    expect(seen.errors).toEqual([]);
    await expect(page.locator('script#worker')).toHaveAttribute('type', 'text/partytown-x');
  } finally { await server?.close(); await fixture.remove(); }
});

test('App CSP nonce protects the beforeInteractive queue, hydration bootstrap and progressive Flight scripts', async ({ page }) => {
  const fixture = await scriptFixture({ csp: true });
  let server;
  try {
    await fixture.build(); server = await startServer(fixture.root);
    const seen = observe(page);
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
    });
    const response = await page.goto(`${server.url}/docs/app-csp`);
    expect(response.headers()['content-security-policy']).toContain("script-src 'nonce-script-nonce' 'strict-dynamic'");
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.some(tag => tag[2].includes('__PRNEXT_SCRIPTS__'))).toBe(true);
    expect(scripts.some(tag => /\btype="module"/.test(tag[1]))).toBe(true);
    expect(scripts.some(tag => tag[2].includes('__PRNEXT_FLIGHT_STREAM__'))).toBe(true);
    for (const tag of scripts) expect(tag[1]).toContain('nonce="script-nonce"');
    await page.waitForFunction(() => window.__cspHydrated && window.__cspReady);
    expect(await page.evaluate(() => window.__cspInline)).toBe(1);
    expect(await page.evaluate(() => window.__scriptRuns)).toMatchObject({ 'before-first.js': 1, 'before-second.js': 1, 'csp-after.js': 1 });
    await page.getByTestId('csp-count').click();
    await expect(page.getByTestId('csp-count')).toHaveText('Count 1');
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
    expect(seen.errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
