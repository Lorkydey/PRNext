import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { globalErrorFixture } from '../global-error-fixture.mjs';
import { binary, freePort, repositoryRoot } from '../support.mjs';

test('development global-error receives the original server error and retry refreshes the failed model', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await globalErrorFixture();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/docs`;
  let child, launchError, output = '';
  try {
    fixture.state.rootFailure = true;
    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'dev', fixture.root,
      '--hostname', '127.0.0.1', '--port', String(port), '--workers', '1'], {
      env: { ...process.env, NODE_ENV: 'development', RUSTYX_BINARY: binary }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', error => { launchError = error; });
    const capture = data => { output = (output + data).slice(-24_000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    for (let attempt = 0; ; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode) throw new Error('Development server exited before becoming ready');
      try { await fetch(`http://127.0.0.1:${port}/robots.txt`); break; } catch { /* Initial compilation is still running. */ }
      if (attempt >= 200) throw new Error('Development server did not become ready');
      await delay(50);
    }
    const manifest = JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    expect(manifest.dev).toBe(true);
    const errors = [], flights = [], documents = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.headers().rsc === '1') flights.push(request.url());
      if (request.resourceType() === 'document') documents.push(request.url());
    });
    const response = await page.goto(url);
    expect(response.status()).toBe(500);
    expect(await response.text()).toContain('id="__rustyx_error__"');
    await expect(page.getByTestId('global-heading')).toHaveText('Global error');
    await expect(page.getByTestId('global-heading')).toHaveCSS('color', 'rgb(130, 45, 91)');
    await expect(page).toHaveTitle('Global recovery');
    const error = JSON.parse(await page.getByTestId('global-error').textContent());
    expect(error).toMatchObject({ message: 'PRIVATE_ROOT_SERVER_ERROR', isError: true, reset: 'function', retry: 'function' });
    expect(error.digest).toMatch(/^[a-f0-9]{16}$/);
    expect(fixture.counts.get('root')).toBe(1);
    // Development deliberately reports caught React failures above the app's
    // own boundary. Dismiss that diagnostic to exercise its independent retry.
    const overlay = page.getByRole('alertdialog', { name: 'Rustyx development error' });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('PRIVATE_ROOT_SERVER_ERROR');
    await overlay.getByRole('button', { name: 'Dismiss' }).click();
    await expect(overlay).toHaveCount(0);
    await page.evaluate(({ message, digest }) => {
      // Flight recovery can reconstruct an Error object for the same failure.
      window.__RUSTYX_DEV__.reportError(Object.assign(new Error(message), { digest }));
    }, error);
    await expect(overlay).toHaveCount(0);
    await page.evaluate(() => { window.__globalDevMarker = 'same document'; });
    fixture.state.rootFailure = false;
    await page.getByTestId('global-retry').click();
    await expect(page.getByTestId('healthy-heading')).toHaveText('Healthy home');
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 0');
    await page.getByTestId('layout-count').click();
    await expect(page.getByTestId('layout-count')).toHaveText('Layout 1');
    expect(flights).toEqual([url]);
    expect(documents).toEqual([url]);
    expect(fixture.counts.get('root')).toBe(2);
    expect(await page.evaluate(() => window.__globalDevMarker)).toBe('same document');
    expect(errors).toEqual([]);
  } catch (error) {
    error.message += `\nDevelopment server output:\n${output}`;
    throw error;
  } finally {
    if (child && child.exitCode === null && !child.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await fixture.remove();
  }
});
