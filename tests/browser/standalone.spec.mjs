import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { standaloneFixture, startServer, repositoryRoot } from '../support.mjs';

test('standalone npm components hydrate with a single React and synchronize router props', async ({ page }) => {
  const fixture = await standaloneFixture();
  let server;
  try {
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
    server = await startServer(fixture.root);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
    await page.goto(server.url + '/?from=browser');
    await expect(page.getByTestId('query')).toHaveText('browser');
    await expect(page.getByTestId('app-query')).toHaveText('browser');
    await expect(page.getByRole('heading')).toHaveCSS('color', 'rgb(12, 34, 56)');
    await page.getByRole('button', { name: 'npm production count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'npm production count 1', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('head script[type="application/ld+json"]').textContent()).toBe('{"name":"PRNext fixture"}');
    await page.getByRole('link', { name: 'SSR', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
    await page.getByRole('button', { name: 'count 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'count 1', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('head script[type="application/ld+json"]').textContent()).toBe('{"name":"PRNext fixture"}');
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
