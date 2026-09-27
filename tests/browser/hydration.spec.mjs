import { test, expect } from '@playwright/test';

test('React hydrates the static page, hooks work, and navigation renders SSR', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  await page.goto('/');
  await expect(page).toHaveTitle('PRNext — Rust meets React');
  const counter = page.getByRole('button', { name: 'Count: 0' });
  await expect(counter).toBeVisible();
  // Playwright can click before hydration has attached handlers: wait for a small
  // browser-side signal that the React root has actually hydrated.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
  await counter.click();
  await expect(page.getByRole('button', { name: 'Count: 1' })).toBeVisible();
  await page.getByRole('link', { name: 'Server rendering' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, PRNext.' })).toBeVisible();
  await expect(page).toHaveTitle('SSR · PRNext');
  await page.waitForTimeout(150);
  expect(failures).toEqual([]);
});

test('catch-all params remain the same after hydration', async ({ page }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/docs/one/two');
  await expect(page.getByTestId('segments')).toHaveText('one / two');
  await page.waitForTimeout(150);
  expect(failures).toEqual([]);
});

test('static HTML still has content with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3198/blog/hello');
  await expect(page.getByRole('heading')).toHaveText('Post: hello');
  await context.close();
});
