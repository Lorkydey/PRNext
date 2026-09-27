import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, freePort, repositoryRoot } from '../support.mjs';

test('the App Router CLI development server hydrates and navigates real development Flight', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await appFixture();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child;
  let output = '';
  try {
    await writeFile(path.join(fixture.root, 'components/environment.tsx'), `'use client'; export default function Environment(){return <p data-testid="client-environment">{process.env.NODE_ENV}</p>;}`);
    const pagePath = path.join(fixture.root, 'app/page.tsx');
    const source = await readFile(pagePath, 'utf8');
    await writeFile(pagePath, `import Environment from '../components/environment';\n${source.replace('return <>', 'return <><Environment /><p data-testid="server-environment">{process.env.NODE_ENV}</p>')}`);

    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'dev', fixture.root,
      '--hostname', '127.0.0.1', '--port', String(port)], {
      env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launchError;
    child.on('error', error => { launchError = error; });
    const capture = data => { output = `${output}${data}`.slice(-24_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    for (let attempt = 0; ; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Development server exited before becoming ready');
      try { await fetch(`${url}/robots.txt`); break; } catch { /* Initial compilation is still running. */ }
      if (attempt >= 200) throw new Error('Development server did not become ready');
      await delay(50);
    }

    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('status of 404')) errors.push(message.text());
    });
    const response = await page.goto(`${url}/?view=development`);
    expect(response.status()).toBe(200);
    await expect(page.getByTestId('server-environment')).toHaveText('development');
    await expect(page.getByTestId('client-environment')).toHaveText('development');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => Object.keys(button).some(key => key.startsWith('__reactProps$'))));
    await expect(page).toHaveTitle('PRNext · App Router');
    await expect(page.getByTestId('search-param')).toHaveText('development');
    await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
    await page.getByRole('button', { name: 'Page count: 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Page count: 1', exact: true })).toBeVisible();
    await page.evaluate(() => { window.__prnextDevMarker = true; });

    const navigated = page.waitForResponse(response => response.url().endsWith('/about') && response.request().headers().rsc === '1');
    await page.getByRole('link', { name: 'About', exact: true }).click();
    expect((await navigated).headers()['content-type']).toContain('text/x-component');
    await expect(page).toHaveURL(`${url}/about`);
    await expect(page).toHaveTitle('About · PRNext');
    await expect(page.getByTestId('pathname')).toHaveText('/about');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__prnextDevMarker)).toBe(true);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.getByTestId('client-environment')).toHaveText('development');
    await expect(page.getByTestId('server-environment')).toHaveText('development');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Actions', exact: true }).click();
    await expect(page).toHaveTitle('Server Actions · PRNext');
    await page.getByRole('button', { name: 'Increment on server', exact: true }).click();
    await expect(page.getByTestId('server-count')).toHaveText('1');
    await expect(page.getByTestId('action-result')).toHaveText('1 / Date / server');
    await page.getByLabel('Record value', { exact: true }).fill('development');
    await page.getByRole('button', { name: 'Save bound record', exact: true }).click();
    await expect(page.getByTestId('server-bound')).toHaveText('record-42:development');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__prnextDevMarker)).toBe(true);
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
