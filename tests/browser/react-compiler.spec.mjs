import { test, expect } from '@playwright/test';
import { reactCompilerFixture, compilerDemoSource } from '../react-compiler-fixture.mjs';
import { startServer } from '../support.mjs';

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

const calls = (page, kind) => page.evaluate(name => window.__reactCompilerCalls?.[name] || 0, kind);

async function openFixture(page, url, router, { development = false } = {}) {
  const response = await page.goto(url + '/docs/' + router);
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain({ pages: 'Pages server rendered', app: 'App server rendered', edge: 'Edge server rendered' }[router]);
  expect(html).toMatch(/data-testid="automatic-result"[^>]*>20100/);
  expect(html).toMatch(/data-testid="decorated-result"[^>]*>40/);
  await page.waitForFunction(() => window.__reactCompilerCalls?.automatic > 0);
  if (development) await page.waitForFunction(() => window.__PRNEXT_DEV__?.confirmed === true);
  await expect(page.getByTestId('automatic-result')).toHaveText('20100');
  await expect(page.getByTestId('decorated-result')).toHaveText('40');
  // Pages SSR deliberately runs the original source. The browser transform
  // must therefore keep React's identity/tree shape and source coordinates
  // identical, rather than merely hiding hydration warnings or leaving stale
  // SSR attributes behind (React does not patch every mismatched attribute).
  const identity = await page.evaluate(source => {
    const server = new DOMParser().parseFromString(source, 'text/html');
    const read = (element, attribute) => element.getAttribute(attribute);
    const properties = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))] || {};
    return ['automatic', 'annotated', 'optout'].map(kind => {
      const selector = suffix => '[data-testid="' + kind + suffix + '"]';
      const input = document.querySelector(selector('-input'));
      const label = document.querySelector(selector('-label'));
      const serverInput = server.querySelector(selector('-input'));
      const serverLabel = server.querySelector(selector('-label'));
      const nodes = ['', '-count', '-input', '-label', '-result'].map(suffix => {
        const element = document.querySelector(selector(suffix));
        const serverElement = server.querySelector(selector(suffix));
        return { selector: selector(suffix), server: read(serverElement, 'data-prnext-source'), dom: read(element, 'data-prnext-source'), react: properties(element)['data-prnext-source'] ?? null };
      });
      return {
        kind,
        serverId: read(serverInput, 'id'), domId: read(input, 'id'), reactId: properties(input).id,
        serverFor: read(serverLabel, 'for'), domFor: read(label, 'for'), reactFor: properties(label).htmlFor,
        nodes,
      };
    });
  }, html);
  for (const item of identity) {
    expect(item.serverId).toBeTruthy();
    expect(item.serverFor).toBe(item.serverId);
    expect(item.domId).toBe(item.serverId);
    expect(item.reactId).toBe(item.serverId);
    expect(item.domFor).toBe(item.serverId);
    expect(item.reactFor).toBe(item.serverId);
    for (const node of item.nodes) {
      if (development) expect(node.server, node.selector + ' has an inspector source coordinate').toBeTruthy();
      else expect(node.server).toBeNull();
      expect(node.dom, node.selector + ' retains SSR source coordinates').toBe(node.server);
      expect(node.react, node.selector + ' hydrates with matching source coordinates').toBe(node.server);
    }
  }
  return identity;
}

async function exerciseMemoization(page, kind, { cached }) {
  const baseline = await calls(page, kind);
  expect(baseline).toBeGreaterThan(0);
  for (let count = 1; count <= 3; count++) {
    await page.getByTestId(kind + '-count').click();
    await expect(page.getByTestId(kind + '-count')).toHaveText('Count ' + count);
  }
  const afterUnrelatedState = await calls(page, kind);
  if (cached) expect(afterUnrelatedState, kind + ' reuses an unchanged computation').toBe(baseline);
  else expect(afterUnrelatedState - baseline, kind + ' recomputes without compiler memoization').toBeGreaterThanOrEqual(3);

  // A relevant input change must still recalculate. A compiler integration that
  // freezes old values would appear fast but fail this correctness assertion.
  await page.getByTestId(kind + '-input').fill('201');
  await expect(page.getByTestId(kind + '-result')).toHaveText('20301');
  const afterRelevantState = await calls(page, kind);
  expect(afterRelevantState).toBeGreaterThan(afterUnrelatedState);
  await page.getByTestId(kind + '-count').click();
  await expect(page.getByTestId(kind + '-count')).toHaveText('Count 4');
  if (cached) expect(await calls(page, kind)).toBe(afterRelevantState);
  else expect(await calls(page, kind)).toBeGreaterThan(afterRelevantState);
  return { kind, cached, initialCalls: baseline, afterThreeUnrelatedUpdates: afterUnrelatedState, afterRelevantInputChange: afterRelevantState, finalCalls: await calls(page, kind) };
}

for (const configuration of [
  { name: 'automatic esbuild', mode: true, automatic: true, annotated: true },
  { name: 'annotation esbuild', mode: { compilationMode: 'annotation' }, automatic: false, annotated: true },
  { name: 'disabled esbuild', mode: false, automatic: false, annotated: false },
  { name: 'automatic webpack', mode: true, webpack: true, automatic: true, annotated: true },
]) test(`${configuration.name}: production Pages/App/Edge hydrate, memoize correctly and retain Server Actions`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await reactCompilerFixture(configuration);
  let server;
  const errors = collectErrors(page);
  const measurements = [];
  try {
    await fixture.build();
    server = await startServer(fixture.root);
    for (const router of ['pages', 'app', 'edge']) {
      await openFixture(page, server.url, router);
      for (const [kind, cached] of [['automatic', configuration.automatic], ['annotated', configuration.annotated], ['optout', false]]) {
        measurements.push({ router, ...await exerciseMemoization(page, kind, { cached }) });
      }
      if (router === 'app') {
        await expect(page.getByTestId('server-action-value')).toHaveText('not saved');
        await page.getByTestId('run-action').click();
        await expect(page.getByTestId('action-result')).toHaveText('Server Action complete');
        await expect(page.getByTestId('server-action-value')).toHaveText('saved on server');
        await expect(page.getByTestId('automatic-count')).toHaveText('Count 4');
        await expect(page.getByTestId('automatic-input')).toHaveValue('201');
      }
    }
    expect(errors).toEqual([]);
    await testInfo.attach('memoization-evidence', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  } finally {
    await server?.close();
    await fixture.remove();
  }
});

for (const webpack of [false, true]) test(`${webpack ? 'webpack' : 'esbuild'} development: Pages/App/Edge compile, Fast Refresh preserves state and exact reversions stay live`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await reactCompilerFixture({ development: true, webpack });
  const errors = collectErrors(page);
  const measurements = [];
  try {
    for (const router of ['pages', 'app', 'edge']) {
      const identity = await openFixture(page, fixture.url, router, { development: true });
      for (const [kind, cached] of [['automatic', true], ['annotated', true], ['optout', false]]) measurements.push({ router, ...await exerciseMemoization(page, kind, { cached }) });
      await page.evaluate(() => { window.__compilerSameDocument = true; });
      for (const label of ['Edited', 'Original']) {
        await fixture.write('components/CompilerDemo.jsx', compilerDemoSource(label));
        await expect(page.getByTestId('automatic').getByRole('heading')).toHaveText(label + ' automatic', { timeout: 30_000 });
        for (const kind of ['automatic', 'annotated', 'optout']) {
          await expect(page.getByTestId(kind + '-count')).toHaveText('Count 4');
          await expect(page.getByTestId(kind + '-input')).toHaveValue('201');
          await expect(page.getByTestId(kind + '-result')).toHaveText('20301');
          const originalId = identity.find(item => item.kind === kind).serverId;
          await expect(page.getByTestId(kind + '-input')).toHaveAttribute('id', originalId);
          await expect(page.getByTestId(kind + '-label')).toHaveAttribute('for', originalId);
        }
        expect(await page.evaluate(() => window.__compilerSameDocument)).toBe(true);
      }
      const before = await calls(page, 'automatic');
      await page.getByTestId('automatic-count').click();
      await expect(page.getByTestId('automatic-count')).toHaveText('Count 5');
      expect(await calls(page, 'automatic')).toBe(before);
      if (router === 'app') {
        await page.getByTestId('run-action').click();
        await expect(page.getByTestId('action-result')).toHaveText('Server Action complete');
        await expect(page.getByTestId('server-action-value')).toHaveText('saved on server');
        await expect(page.getByTestId('automatic-count')).toHaveText('Count 5');
      }
    }
    expect(errors).toEqual([]);
    await testInfo.attach('memoization-evidence', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  } finally {
    await fixture.close();
  }
});
