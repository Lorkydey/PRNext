import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, freePort, repositoryRoot } from '../support.mjs';

test('the App Router CLI development server hydrates and navigates real development Flight', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  // Keep evidence across document replacements without recording request
  // bodies, cookie values, query strings or arbitrary response headers.
  const transitions = [];
  const record = event => { if (transitions.length < 300) transitions.push({ order: transitions.length, ...event }); };
  await page.exposeBinding('__recordAppDevelopmentTransition', (_source, event) => record(event));
  await page.addInitScript(() => {
    const documentId = crypto.randomUUID();
    let previous, emitted = 0;
    const snapshot = (kind, reloadReason) => {
      const development = globalThis.__PRNEXT_DEV__;
      const button = [...document.querySelectorAll('button')].find(item => /^Layout count: \d+$/.test(item.textContent));
      const serverCount = document.querySelector('[data-testid="server-count"]')?.textContent;
      const event = { kind, documentId, at: performance.now(), path: location.pathname.slice(0, 256),
        layout: button ? Number(button.textContent.slice('Layout count: '.length)) : null,
        serverCount: /^\d+$/.test(serverCount || '') ? Number(serverCount) : null,
        actionResultReady: document.querySelector('[data-testid="action-result"]')?.textContent === '1 / Date / server',
        boundResultReady: document.querySelector('[data-testid="server-bound"]')?.textContent === 'record-42:development',
        marker: window.__prnextDevMarker === true, buildId: development?.buildId,
        sequence: development?.sequence, applying: development?.applying, confirmed: development?.confirmed,
        reloadReason: typeof reloadReason === 'string' ? reloadReason.slice(0, 256) : document.querySelector('#__prnext_reload_reason__')?.textContent.slice(0, 256) ?? null };
      const key = JSON.stringify({ ...event, kind: null, at: 0 });
      if (kind === 'mutation' && key === previous) return;
      previous = key;
      if (emitted++ < 300) void window.__recordAppDevelopmentTransition(event).catch(() => {});
      return event;
    };
    window.__snapshotAppDevelopmentTransition = snapshot;
    new MutationObserver(() => snapshot('mutation')).observe(document, { subtree: true, childList: true, characterData: true });
    for (const name of ['prnext:refresh', 'prnext:devtools:ready', 'pagehide']) addEventListener(name, () => snapshot(name));
    addEventListener('prnext:reload', event => snapshot('prnext:reload', event.detail?.reason));
  });
  const requestSummary = request => ({ path: new URL(request.url()).pathname.slice(0, 256), method: request.method(),
    document: request.isNavigationRequest() && request.frame() === page.mainFrame(),
    rsc: request.headers().rsc === '1', action: !!request.headers()['next-action'] });
  const relevant = request => request.frame() === page.mainFrame() && (request.isNavigationRequest() || request.headers().rsc === '1' || !!request.headers()['next-action']);
  page.on('request', request => { if (relevant(request)) record({ kind: 'request', ...requestSummary(request) }); });
  page.on('response', response => { if (relevant(response.request())) record({ kind: 'response', ...requestSummary(response.request()), status: response.status() }); });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) record({ kind: 'main-frame-navigation', path: new URL(frame.url()).pathname.slice(0, 256) }); });
  const stage = name => page.evaluate(name => window.__snapshotAppDevelopmentTransition(name), name);
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
    await stage('actions-arrived');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__prnextDevMarker)).toBe(true);
    await page.getByRole('button', { name: 'Increment on server', exact: true }).click();
    await expect(page.getByTestId('server-count')).toHaveText('1');
    await expect(page.getByTestId('action-result')).toHaveText('1 / Date / server');
    await stage('increment-completed');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__prnextDevMarker)).toBe(true);
    await page.getByLabel('Record value', { exact: true }).fill('development');
    await page.getByRole('button', { name: 'Save bound record', exact: true }).click();
    await expect(page.getByTestId('server-bound')).toHaveText('record-42:development');
    await stage('bound-completed');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__prnextDevMarker)).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    error.message += `\nDevelopment server output:\n${output}`;
    throw error;
  } finally {
    try {
      await stage('finally').catch(() => {});
      const diagnosticPath = testInfo.outputPath('app-development-transitions.json');
      await writeFile(diagnosticPath, JSON.stringify({ limit: 300, transitions }, null, 2));
      await testInfo.attach('app-development-transitions', { path: diagnosticPath, contentType: 'application/json' });
    } finally {
      try {
        if (child && child.exitCode === null && !child.signalCode) {
          await new Promise(resolve => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.kill('SIGTERM');
          });
        }
      } finally { await fixture.remove(); }
    }
  }
});
