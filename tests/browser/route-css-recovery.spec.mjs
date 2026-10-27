import { test, expect } from '@playwright/test';
import { globalErrorFixture } from '../global-error-fixture.mjs';
import { startServer } from '../support.mjs';
import { routeCssFixture } from '../route-css-fixture.mjs';

test.describe('loaded App CSS recovery', () => {
  let fixture, server, normalCss;
  test.beforeAll(async () => {
    fixture = await globalErrorFixture();
    await fixture.write('app/page.jsx', `import './home.css';export default function Page(){return <h1 data-testid="healthy-heading">Healthy home</h1>}`);
    await fixture.write('app/home.css', '[data-testid="healthy-heading"]{color:rgb(31,89,147)}');
    const manifest = await fixture.build();
    normalCss = manifest.routes.find(route => route.pattern === '/' && route.router === 'app').css;
    server = await startServer(fixture.root, ['--workers', '1']);
  });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  for (const persisted of [false, true]) test(`local global-error reset restores ready CSS without a second download${persisted ? ' after persisted pagehide/pageshow' : ''}`, async ({ page }, testInfo) => {
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url + '/docs');
    await page.waitForFunction(() => Boolean(window.__globalRouter));
    const rootRequests = fixture.counts.get('root');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 35, 46)');
    await expect(page.getByTestId('healthy-heading')).toHaveCSS('color', 'rgb(31, 89, 147)');
    await page.getByTestId('crash-root').click();
    await expect(page.getByTestId('global-heading')).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Routing disables the HTTP cache. Any unnecessary re-insertion of a ready
    // link becomes a delayed second fetch, instead of being hidden by warm I/O.
    await page.route('**/*.css', async route => {
      if (normalCss.some(href => new URL(href, server.url).href === route.request().url())) {
        requests.push(route.request().url());
        await new Promise(resolve => setTimeout(resolve, 900));
      }
      await route.continue();
    });
    if (persisted) await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await page.evaluate(() => {
      window.__recoveryFrames = [];
      const end = performance.now() + 1200;
      function frame() {
        const heading = document.querySelector('[data-testid="healthy-heading"]');
        if (heading) window.__recoveryFrames.push({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(heading).color });
        if (performance.now() < end) requestAnimationFrame(frame);
        else window.__recoveryDone = true;
      }
      requestAnimationFrame(frame);
    });
    await page.getByTestId('global-reset').click();
    await expect(page.getByTestId('healthy-heading')).toHaveText('Healthy home');
    await page.waitForFunction(() => window.__recoveryDone);
    const frames = await page.evaluate(() => window.__recoveryFrames);
    await testInfo.attach('recovery-styled-frames', { body: JSON.stringify({ persisted, normalCss, requests, frames }), contentType: 'application/json' });
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame).toEqual({ background: 'rgb(24, 35, 46)', color: 'rgb(31, 89, 147)' });
    expect(requests, 'loaded layout/page CSS must stay in the document throughout local reset').toEqual([]);
    expect(fixture.counts.get('root')).toBe(rootRequests);
    expect(errors).toEqual([]);
  });
});

test('prepared main-page CSS precedes a retained parallel sheet without reloading the shared cascade', async ({ page }, testInfo) => {
  const fixture = await routeCssFixture({ parallel: true });
  let server;
  try {
    await fixture.write('app/@detail/a/detail.css', '.detail-tone{color:rgb(30,140,90)}.main-tone{color:rgb(50,100,150)}');
    const manifest = await fixture.build();
    server = await startServer(fixture.root, ['--workers', '1']);
    const a = manifest.routes.find(route => route.pattern === '/a'), b = manifest.routes.find(route => route.pattern === '/b');
    const requests = [];
    page.on('request', request => { if (request.resourceType() === 'stylesheet') requests.push(request.url()); });
    await page.goto(server.url + '/docs/a');
    await expect(page.locator('.main-tone')).toHaveCSS('color', 'rgb(50, 100, 150)');
    await expect(page.getByTestId('lazy')).toHaveCSS('color', 'rgb(98, 76, 54)');
    const initial = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.href));
    await page.route('**/*.css', async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.evaluate(() => {
      window.__cascadeFrames = []; window.__cascadeSampling = true;
      function frame() {
        if (!window.__cascadeSampling) return;
        const heading = document.querySelector('.main-tone');
        if (heading) window.__cascadeFrames.push({ text: heading.textContent, color: getComputedStyle(heading).color });
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    await page.getByRole('link', { name: 'B', exact: true }).click();
    await expect(page.locator('.main-tone')).toHaveText('Page B');
    await expect(page.getByTestId('detail')).toHaveText('Detail A');
    await page.waitForTimeout(800);
    const frames = await page.evaluate(() => { window.__cascadeSampling = false; return window.__cascadeFrames; });
    await testInfo.attach('retained-cascade-styled-frames', { body: JSON.stringify({ initial, requests, a: a.css, b: b.css, frames }), contentType: 'application/json' });
    expect(frames.length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame.color).toBe('rgb(50, 100, 150)');
    const final = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.href));
    const shared = initial.filter(href => final.includes(href));
    expect(shared.length).toBeGreaterThan(1);
    for (const href of shared) expect(requests.filter(url => url === href), 'retained layout and slot sheets stay loaded in place').toHaveLength(1);
  } finally { await server?.close(); await fixture.remove(); }
});

test('ready CSS handed to a suspended React transition survives persisted lifecycle cancellation without reloading', async ({ page }, testInfo) => {
  const fixture = await routeCssFixture();
  let server;
  try {
    await fixture.write('app/b/page.jsx', `import './page.css';import Gate from './gate';export const dynamic='force-dynamic';export default function Page(){return <main data-page="b"><Gate/></main>}`);
    await fixture.write('app/b/gate.jsx', `'use client';let pending;export default function Gate(){if(typeof window!=='undefined'&&!window.__releaseB){window.__bSuspended=true;pending ||= new Promise(resolve=>{window.__openB=()=>{window.__releaseB=true;resolve()}});throw pending}return <h1 className="main-tone">Page B</h1>}`);
    const manifest = await fixture.build();
    const a = manifest.routes.find(route => route.pattern === '/a'), b = manifest.routes.find(route => route.pattern === '/b');
    const target = b.css.find(href => !a.css.includes(href));
    server = await startServer(fixture.root, ['--workers', '1']);
    const requests = [];
    page.on('request', request => { if (new URL(request.url()).pathname === new URL(target, server.url).pathname) requests.push(request.url()); });
    await page.goto(server.url + '/docs/a');
    await expect(page.getByTestId('lazy')).toHaveCSS('color', 'rgb(98, 76, 54)');
    await page.getByRole('link', { name: 'B', exact: true }).click();
    await page.waitForFunction(() => window.__bSuspended === true);
    await expect(page).toHaveURL(server.url + '/docs/b');
    await expect(page.locator('.main-tone')).toHaveText('Page A');
    await page.route('**/*.css', async route => {
      await new Promise(resolve => setTimeout(resolve, 900));
      await route.continue();
    });
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      window.__transitionFrames = [];
      const end = performance.now() + 1200;
      function frame() {
        const main = document.querySelector('main[data-page]'), heading = main?.querySelector('h1');
        if (heading) window.__transitionFrames.push({ page: main.dataset.page, color: getComputedStyle(heading).color });
        if (performance.now() < end) requestAnimationFrame(frame);
        else window.__transitionDone = true;
      }
      requestAnimationFrame(frame);
      window.__openB();
    });
    await expect(page.locator('.main-tone')).toHaveText('Page B');
    await page.waitForFunction(() => window.__transitionDone);
    const frames = await page.evaluate(() => window.__transitionFrames);
    await testInfo.attach('suspended-transition-styled-frames', { body: JSON.stringify({ target, requests, frames }), contentType: 'application/json' });
    expect(frames.filter(frame => frame.page === 'b').length).toBeGreaterThan(2);
    for (const frame of frames) expect(frame.color).toBe(frame.page === 'a' ? 'rgb(170, 20, 30)' : 'rgb(20, 40, 170)');
    expect(requests, 'the ready CSS handed to React must not download a second time').toHaveLength(1);
  } finally { await server?.close(); await fixture.remove(); }
});
