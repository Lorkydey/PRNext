import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { startServer, repositoryRoot } from '../support.mjs';

let server;
test.beforeAll(async () => {
  const root = path.join(repositoryRoot, 'examples/app');
  await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', root]);
  server = await startServer(root);
});
test.afterAll(async () => { await server?.close(); });

function browserErrors(page, { allowedStatuses = [404], allowedMessages = [] } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' &&
        !allowedStatuses.some(status => message.text().includes(`status of ${status}`)) &&
        !allowedMessages.some(text => message.text().includes(text))) errors.push(message.text());
  });
  return errors;
}

test('real Flight hydrates, preserves layout state, updates hooks, and navigates browser history', async ({ page }) => {
  const errors = browserErrors(page);
  const flightRequests = [];
  page.on('request', request => {
    if (request.headers().rsc === '1') flightRequests.push(new URL(request.url()).pathname);
  });
  await page.goto(`${server.url}/?view=browser`);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
  await expect(page.getByTestId('search-param')).toHaveText('browser');
  await expect(page).toHaveTitle('Rustyx · App Router');
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Page count: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Page count: 1', exact: true })).toBeVisible();
  await page.evaluate(() => { window.__rustyxNavigationMarker = 'same-document'; });

  await page.getByRole('link', { name: 'About', exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/about`);
  await expect(page.getByTestId('pathname')).toHaveText('/about');
  await expect(page.getByRole('heading')).toContainText('Same layout.');
  await expect(page).toHaveTitle('About · Rustyx');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rustyxNavigationMarker)).toBe('same-document');

  await page.getByRole('link', { name: 'Item', exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/items/alpha?tag=one&tag=two`);
  await expect(page.getByTestId('pathname')).toHaveText('/items/alpha');
  await expect(page.getByTestId('params')).toHaveText('{"slug":"alpha"}');
  await expect(page.getByRole('heading')).toHaveText('Item: alpha');
  await expect(page.getByTestId('tags')).toHaveText('one, two');
  await expect(page.getByTestId('nested-layout')).toContainText('NESTED LAYOUT / alpha');
  await expect(page.getByTestId('search-param')).toHaveText('default');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Page count: 10', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Page count: 11', exact: true })).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId('pathname')).toHaveText('/about');
  await expect(page.getByRole('heading')).toContainText('Same layout.');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('pathname')).toHaveText('/items/alpha');
  await expect(page.getByRole('heading')).toHaveText('Item: alpha');
  await expect(page.getByRole('button', { name: 'Page count: 10', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  const previousTime = await page.getByTestId('server-time').textContent();
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByTestId('server-time')).not.toHaveText(previousTime);
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rustyxNavigationMarker)).toBe('same-document');
  await page.getByRole('link', { name: 'Redirect', exact: true }).click();
  await expect(page).toHaveURL(`${server.url}/about`);
  await expect(page.getByRole('heading')).toContainText('Same layout.');
  const missingResponse = page.waitForResponse(response => response.url().endsWith('/items/missing') && response.request().headers().rsc === '1');
  await page.getByRole('link', { name: 'Missing item', exact: true }).click();
  expect((await missingResponse).status()).toBe(404);
  await expect(page.getByRole('heading')).toContainText('Item not found');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rustyxNavigationMarker)).toBe('same-document');
  expect(flightRequests).toEqual(expect.arrayContaining(['/about', '/items/alpha', '/']));
  expect(errors).toEqual([]);
});

test('App Router redirects and nested not-found responses hydrate', async ({ page }) => {
  const errors = browserErrors(page);
  await page.goto(`${server.url}/redirect`);
  await expect(page).toHaveURL(`${server.url}/about`);
  await expect(page.getByRole('heading')).toContainText('Same layout.');
  const response = await page.goto(`${server.url}/items/missing`);
  expect(response.status()).toBe(404);
  await expect(page.getByRole('heading')).toContainText('Item not found');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a newer App Router navigation aborts an older request and Link respects preventDefault', async ({ page }) => {
  const errors = browserErrors(page);
  await page.goto(server.url);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
  const about = page.getByRole('link', { name: 'About', exact: true });
  await about.evaluate(element => element.addEventListener('click', event => event.preventDefault(), { once: true }));
  await about.click();
  await expect(page).toHaveURL(`${server.url}/`);
  await expect(page.getByTestId('pathname')).toHaveText('/');

  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`${server.url}/about`, async route => {
    if (route.request().headers().rsc !== '1') return route.continue();
    await held;
    await route.continue().catch(() => {});
  });
  const requested = page.waitForRequest(request => request.url() === `${server.url}/about` && request.headers().rsc === '1');
  const aborted = page.waitForEvent('requestfailed', { predicate: request => request.url() === `${server.url}/about` });
  await about.click();
  await requested;
  await page.getByRole('link', { name: 'Item', exact: true }).click();
  await expect(page.getByRole('heading')).toHaveText('Item: alpha');
  release();
  expect((await aborted).failure().errorText).toContain('ABORTED');
  await expect(page).toHaveURL(`${server.url}/items/alpha?tag=one&tag=two`);
  await expect(page.getByTestId('pathname')).toHaveText('/items/alpha');
  expect(errors).toEqual([]);
});

test('server error.js renders after an empty 500 document and retry recovers through Flight', async ({ page, context }) => {
  const errors = browserErrors(page, { allowedStatuses: [404, 500], allowedMessages: ['An error occurred', 'Minified React error #441;'] });
  const response = await page.goto(`${server.url}/failure`);
  expect(response.status()).toBe(500);
  expect(await response.text()).toContain('id="__rustyx_error__"');
  expect(await response.text()).not.toContain('Something went wrong');
  await expect(page.getByRole('heading')).toHaveText('Something went wrong');
  await expect(page.getByTestId('error-message')).not.toContainText('this detail stays on the server');
  await expect(page.getByTestId('error-digest')).toHaveText(/^[a-f0-9]{16}$/);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__rustyxNavigationMarker = 'error-recovery'; });
  await context.addCookies([{ name: 'example-recovered', value: '1', url: server.url }]);
  const refreshed = page.waitForResponse(response => response.url().endsWith('/failure') && response.request().headers().rsc === '1');
  await page.getByRole('button', { name: 'Retry page', exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole('heading')).toHaveText('Recovered server page');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Page count: 20', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Page count: 21', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rustyxNavigationMarker)).toBe('error-recovery');

  await context.clearCookies();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  const failedFlight = page.waitForResponse(response => response.url().endsWith('/failure') && response.request().headers().rsc === '1');
  await page.getByRole('link', { name: 'Server error', exact: true }).click();
  expect((await failedFlight).status()).toBe(500);
  await expect(page.getByRole('heading')).toHaveText('Something went wrong');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rustyxNavigationMarker)).toBe('error-recovery');
  expect(errors).toEqual([]);
});

test('client rendering errors reach error.js and reset remounts the failed subtree', async ({ page }) => {
  const errors = browserErrors(page, { allowedMessages: ['Example client failure'] });
  await page.goto(`${server.url}/client-failure`);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(() => { window.__rustyxNavigationMarker = 'client-error-recovery'; });
  await page.getByRole('button', { name: 'Trigger client failure', exact: true }).click();
  await expect(page.getByRole('heading')).toHaveText('Something went wrong');
  await expect(page.getByTestId('error-message')).toHaveText('Example client failure');
  await page.getByRole('button', { name: 'Retry page', exact: true }).click();
  await expect(page.getByRole('heading')).toHaveText('Client error boundary');
  await expect(page.getByRole('button', { name: 'Trigger client failure', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__rustyxNavigationMarker)).toBe('client-error-recovery');
  expect(errors).toEqual([]);
});
