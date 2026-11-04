import { test, expect } from '@playwright/test';
import { edgePagesFixture } from '../edge-pages-fixture.mjs';
import { startServer } from '../support.mjs';
import { createServer } from 'node:http';

for (const webpack of [false, true]) test(`Edge VM pages preserve styles, hydration and layout state (${webpack ? 'webpack' : 'esbuild'})`, async ({ page, context }) => {
  const fixture = await edgePagesFixture({ webpack }); let server;
  const errors = [], documents = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  try {
    await fixture.build(); server = await startServer(fixture.root);
    await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
    await context.addCookies([{ name: 'visitor', value: 'browser', url: server.url }]);
    const response = await page.goto(`${server.url}/docs/edge/one`);
    expect(response.status()).toBe(200);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(240, 245, 250)');
    await expect(page.getByRole('heading', { name: 'Edge one' })).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.getByTestId('edge-context')).toHaveText('edge-runtime:undefined:browser:browser:32:true');
    await expect(page.getByTestId('page')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'layout 0', exact: true }).click();
    await page.getByRole('button', { name: 'page 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'edge two', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edge two' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edge two' })).toHaveCSS('color', 'rgb(12, 34, 56)');
    await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
    await expect(page.getByTestId('page').filter({ visible: true })).toContainText('2026:two:web:web-form:255:error');
    await expect(page).toHaveTitle('Edge two browser');
    await page.getByRole('button', { name: 'refresh page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'node page', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Node page function' })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(240, 245, 250)');
    await expect(page.getByTestId('node')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'node 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'node 1', exact: true })).toBeVisible();
    expect(documents).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});

async function controlledPageGate() {
  const pending = new Map(), counts = new Map();
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!['page', 'node'].includes(name)) { response.writeHead(404); response.end(); return; }
    counts.set(name, (counts.get(name) || 0) + 1);
    const responses = pending.get(name) || new Set();
    responses.add(response); pending.set(name, responses);
    response.on('close', () => responses.delete(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const release = name => { for (const response of pending.get(name) || []) response.end('released'); };
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    count: name => counts.get(name) || 0,
    release,
    async close() {
      release('page'); release('node'); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

for (const webpack of [false, true]) test.describe(`streamed Edge navigation (${webpack ? 'webpack' : 'esbuild'})`, () => {
  let fixture, server, gate;
  test.beforeAll(async () => {
    gate = await controlledPageGate();
    fixture = await edgePagesFixture({ webpack, pageGateUrl: gate.url });
    await fixture.build(); server = await startServer(fixture.root);
  });
  test.afterAll(async () => { await gate?.close(); await server?.close(); await fixture?.remove(); });

  async function visit(page, context) {
    await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
    await context.addCookies([{ name: 'visitor', value: 'browser', url: server.url }]);
    await page.goto(`${server.url}/docs/edge/one`);
    await expect(page.getByTestId('page')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'layout 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'page 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
  }
  function observe(page) {
    const errors = [], documents = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    return { errors, documents };
  }
  async function nodeCounter(page) {
    await expect(page.getByRole('heading', { name: 'Node page function', exact: true })).toBeVisible();
    await expect(page.getByTestId('node')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: 'node 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'node 1', exact: true })).toBeVisible();
  }
  async function retainedNode(page, observed) {
    await page.getByRole('link', { name: 'node page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'node 1', exact: true })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(240, 245, 250)');
    expect(observed.documents).toHaveLength(1);
    expect(observed.errors).toEqual([]);
  }

  test('cancelling a streamed refresh restores the last committed Action tree', async ({ page, context }) => {
    const observed = observe(page);
    try {
      await visit(page, context);
      await page.getByRole('button', { name: 'increment action', exact: true }).click();
      await expect(page.getByTestId('edge-action-count')).toHaveText('1');
      await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
      const renders = await page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_RENDERS__);
      const pages = gate.count('page'), nodes = gate.count('node');
      await context.setExtraHTTPHeaders({ 'x-user': 'browser', 'x-prnext-test-hold-page': '1' });
      await page.getByRole('button', { name: 'refresh page', exact: true }).click();
      await expect.poll(() => gate.count('page')).toBe(pages + 1);
      // The root model has reached React, while the server still withholds its
      // lazy page row. A visible old counter alone would not prove this phase.
      await expect.poll(() => page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_RENDERS__)).toBeGreaterThan(renders);
      await page.getByRole('link', { name: 'node page', exact: true }).click();
      await expect.poll(() => gate.count('node')).toBe(nodes + 1);
      // C is also held. The restored document must use the committed Action
      // result, rather than an older snapshot masked by C's eventual response.
      await expect(page.getByTestId('edge-action-count')).toHaveText('1');
      await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'layout 1', exact: true }).click();
      await expect(page.getByRole('button', { name: 'layout 2', exact: true })).toBeVisible();
      await expect(page.getByTestId('edge-action-count')).toHaveText('1');
      await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
      gate.release('node'); await nodeCounter(page); gate.release('page');
      await page.getByRole('link', { name: 'edge one', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edge one', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'layout 2', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
      await expect(page.getByTestId('edge-action-count')).toHaveText('1');
      await retainedNode(page, observed);
    } finally { gate.release('page'); gate.release('node'); await test.info().attach('streamed-navigation-observation', { body: Buffer.from(JSON.stringify(observed)), contentType: 'application/json' }); }
  });

  test('an uncommitted B followed by C keeps history and the committed page state', async ({ page, context }) => {
    const observed = observe(page);
    try {
      await visit(page, context);
      const renders = await page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_RENDERS__);
      const pages = gate.count('page');
      await context.setExtraHTTPHeaders({ 'x-user': 'browser', 'x-prnext-test-hold-page': '1' });
      await page.getByRole('link', { name: 'edge two', exact: true }).click();
      await expect.poll(() => gate.count('page')).toBe(pages + 1);
      await expect.poll(() => page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_RENDERS__)).toBeGreaterThan(renders);
      await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
      await page.getByRole('link', { name: 'node page', exact: true }).click();
      await nodeCounter(page); gate.release('page');
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Edge two', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 0', exact: true })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Edge one', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
      await retainedNode(page, observed);
    } finally { gate.release('page'); gate.release('node'); await test.info().attach('streamed-navigation-observation', { body: Buffer.from(JSON.stringify(observed)), contentType: 'application/json' }); }
  });

  test('a committed loading shell remains safe when its pending page is cancelled', async ({ page, context }) => {
    const observed = observe(page);
    try {
      await visit(page, context);
      const commits = await page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_COMMITS__);
      const pages = gate.count('page');
      await context.setExtraHTTPHeaders({ 'x-user': 'browser', 'x-prnext-test-hold-page': '1' });
      await page.getByRole('link', { name: 'loading page', exact: true }).click();
      await expect.poll(() => gate.count('page')).toBe(pages + 1);
      await expect(page.getByTestId('edge-loading')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_COMMITS__)).toBeGreaterThan(commits);
      await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
      await page.getByRole('link', { name: 'node page', exact: true }).click();
      await nodeCounter(page); gate.release('page');
      await page.getByRole('link', { name: 'loading page', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edge loading', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 0', exact: true })).toBeVisible();
      await retainedNode(page, observed);
    } finally { gate.release('page'); gate.release('node'); await test.info().attach('streamed-navigation-observation', { body: Buffer.from(JSON.stringify(observed)), contentType: 'application/json' }); }
  });

  test('cancelling a committed loading shell restores its complete model before the next response', async ({ page, context }) => {
    const observed = observe(page);
    try {
      await visit(page, context);
      const commits = await page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_COMMITS__);
      const pages = gate.count('page'), nodes = gate.count('node');
      await context.setExtraHTTPHeaders({ 'x-user': 'browser', 'x-prnext-test-hold-page': '1' });
      await page.getByRole('link', { name: 'loading page', exact: true }).click();
      await expect.poll(() => gate.count('page')).toBe(pages + 1);
      await expect(page.getByTestId('edge-loading')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_COMMITS__)).toBeGreaterThan(commits);
      // C is held as well: a fast replacement must not hide rejection of B's
      // lazy row after its loading shell has already committed in React.
      await page.getByRole('link', { name: 'node page', exact: true }).click();
      await expect.poll(() => gate.count('node')).toBe(nodes + 1);
      await expect(page.getByRole('heading', { name: 'Edge one', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'layout 1', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 1', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'layout 1', exact: true }).click();
      await expect(page.getByRole('button', { name: 'layout 2', exact: true })).toBeVisible();
      expect(observed.errors).toEqual([]);
      await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
      gate.release('node'); await nodeCounter(page); gate.release('page');
      await page.getByRole('link', { name: 'loading page', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edge loading', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'layout 2', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'page 0', exact: true })).toBeVisible();
      await retainedNode(page, observed);
    } finally { gate.release('page'); gate.release('node'); await test.info().attach('streamed-navigation-observation', { body: Buffer.from(JSON.stringify(observed)), contentType: 'application/json' }); }
  });

  test('a changed account replaces the whole document before adopting its streamed loading shell', async ({ page, context }) => {
    const observed = observe(page), mutations = []; let exit;
    page.on('request', request => { if (request.method() === 'POST') mutations.push(request.url()); });
    let releaseDocument;
    const documentGate = new Promise(resolve => { releaseDocument = resolve; });
    let documentPending = false;
    await page.route('**/docs/edge/loading', async route => {
      if (route.request().isNavigationRequest()) {
        documentPending = true; await documentGate;
        const headers = {...route.request().headers()}; delete headers['x-prnext-test-hold-page'];
        await route.continue({headers});
      } else await route.continue();
    });
    try {
      await visit(page, context);
      const pages = gate.count('page'), commits = await page.evaluate(() => window.__PRNEXT_EDGE_LAYOUT_COMMITS__);
      await page.evaluate(() => {sessionStorage.removeItem('__prnext_test_document_exit__');window.addEventListener('pagehide', () => {sessionStorage.setItem('__prnext_test_document_exit__',JSON.stringify({commits:window.__PRNEXT_EDGE_LAYOUT_COMMITS__,visibility:document.documentElement.style.visibility,loadingShell:document.querySelector('[data-testid="edge-loading"]')!==null}));});});
      await context.addCookies([{ name: 'visitor', value: 'account-b', url: server.url, httpOnly: true }]);
      await context.setExtraHTTPHeaders({ 'x-user': 'browser', 'x-prnext-test-hold-page': '1' });
      await page.getByRole('link', { name: 'loading page', exact: true }).click();
      await expect.poll(() => gate.count('page')).toBe(pages + 1);
      await expect.poll(() => documentPending).toBe(true);
      expect(mutations).toEqual([]);
      expect(observed.documents).toHaveLength(2);
      releaseDocument(); gate.release('page');
      await expect(page.getByRole('heading', { name: 'Edge loading', exact: true })).toBeVisible();
      await expect(page.getByTestId('edge-context')).toHaveText('edge-runtime:undefined:browser:account-b:32:true');
      await expect(page.getByRole('button', { name: 'layout 0', exact: true })).toBeVisible();
      exit=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('__prnext_test_document_exit__')));
      expect(exit).toEqual({commits,visibility:'hidden',loadingShell:false});
      await context.setExtraHTTPHeaders({ 'x-user': 'browser' });
      // Only an explicit action in the newly authorized document dispatches.
      await page.getByRole('button', { name: 'mutate session probe', exact: true }).click();
      await expect.poll(async () => (await context.cookies()).find(cookie => cookie.name === 'session-probe-count')?.value).toBe('1');
      expect(mutations).toHaveLength(1);
      expect(observed.errors).toEqual([]);
    } finally { releaseDocument(); gate.release('page'); gate.release('node'); await test.info().attach('streamed-navigation-observation', { body: Buffer.from(JSON.stringify({ ...observed, mutations, exit })), contentType: 'application/json' }); }
  });

  test('a genuine server failure remains visible and reported', async ({ page, context }) => {
    const observed = observe(page);
    await visit(page, context);
    await page.getByRole('link', { name: 'failure page', exact: true }).click();
    await expect(page.getByRole('heading', { name: /This page couldn.*t load/ })).toBeVisible();
    await expect(page.getByText('ERROR EDGE_CONTROLLED_SERVER_FAILURE')).toBeVisible();
    await expect.poll(() => observed.errors.length).toBeGreaterThan(0);
    expect(observed.documents).toHaveLength(1);
  });
});
