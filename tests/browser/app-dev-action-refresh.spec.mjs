import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { appFixture, freePort, repositoryRoot } from '../support.mjs';

const developmentTest = test.extend({ developmentApp: async ({ page }, use) => {
  test.setTimeout(60_000);
  const fixture = await appFixture();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child, output = '';
  try {
    child = spawn(process.execPath, [process.env.PRNEXT_DEV_TEST_CLI || path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'dev', fixture.root,
      '--hostname', '127.0.0.1', '--port', String(port)], {
      env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launchError;
    child.on('error', error => { launchError = error; });
    const capture = data => { output = `${output}${data}`.slice(-24_000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    for (let attempt = 0; ; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Development server exited before becoming ready');
      try { await fetch(`${url}/robots.txt`); break; } catch { /* Initial compilation. */ }
      if (attempt >= 200) throw new Error('Development server did not become ready');
      await delay(50);
    }
    await use({ fixture, url });
  } catch (error) {
    error.message += `\nDevelopment server output:\n${output}`;
    throw error;
  } finally {
    await page.evaluate(() => window.__releaseActionRefresh?.()).catch(() => {});
    if (child && child.exitCode === null && !child.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await fixture.remove();
  }
} });

async function observeDevelopmentWait(page) {
  await page.evaluate(() => {
    const development = globalThis.__PRNEXT_DEV__;
    let applied = development.applied;
    window.__actionRefreshWaitObserved = false;
    Object.defineProperty(development, 'applied', {
      configurable: true,
      get() { window.__actionRefreshWaitObserved = true; return applied; },
      set(value) { applied = value; },
    });
  });
}

developmentTest('a bound Server Action cannot render new client exports before their React Refresh transaction commits', async ({ page, developmentApp: { url } }) => {
  let releaseResponse;
  try {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/actions`);
    await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
    await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    await page.getByLabel('Record value', { exact: true }).fill('refresh-race');
    let responseReady;
    const responseCaptured = new Promise(resolve => { responseReady = resolve; });
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    let mutations = 0;
    await page.route(`${url}/actions`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      mutations++;
      const response = await route.fetch();
      responseReady(response.status());
      await responseGate;
      await route.fulfill({ response });
    });
    // Execute against its original server generation exactly once; only the
    // transport delivery is held while another tab compiles an unopened route.
    await page.getByRole('button', { name: 'Save bound record', exact: true }).click();
    expect(await responseCaptured).toBe(200);
    await page.evaluate(async () => {
      window.__actionRefreshDocument = {};
      const application = await globalThis.__PRNEXT_DEV__.applications.get('app');
      const prepare = application.devPrepare;
      const gate = new Promise(resolve => { window.__releaseActionRefresh = resolve; });
      application.devPrepare = async options => {
        await prepare(options);
        window.__actionRefreshExportsReady = true;
        await gate;
      };
    });
    // Compile an unopened destination without leaving the action form. A
    // second tab or a pending navigation can publish this same new graph.
    const other = await page.context().newPage();
    await other.goto(`${url}/about`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__actionRefreshExportsReady === true);
    await observeDevelopmentWait(page);
    // Deliver the old action's successful Flight while new exports are loaded
    // but their React Refresh registration has not committed yet.
    releaseResponse();
    await page.waitForFunction(() => window.__actionRefreshWaitObserved === true);
    await page.evaluate(() => window.__releaseActionRefresh());
    await expect(page.getByTestId('server-bound')).toHaveText('record-42:refresh-race');
    await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(mutations).toBe(1);
    expect(await page.evaluate(() => !!window.__actionRefreshDocument)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    releaseResponse?.();
    await page.evaluate(() => window.__releaseActionRefresh?.()).catch(() => {});
  }
});

developmentTest('an action error remains a rejection when refresh supersedes its prepared tree', async ({ page, developmentApp: { url } }) => {
  let releaseStyles;
  try {
    await page.goto(`${url}/actions`);
    await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
    let stylesRequested;
    const requested = new Promise(resolve => { stylesRequested = resolve; });
    const gate = new Promise(resolve => { releaseStyles = resolve; });
    await page.route(`${url}/__action-refresh-gate.css`, async route => {
      stylesRequested();
      await gate;
      await route.fulfill({ contentType: 'text/css', body: '/* controlled action stylesheet */' });
    });
    let posts = 0;
    await page.route(`${url}/actions`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(500);
      const body = await response.text();
      expect(body).toContain('actionError');
      expect(body).toContain('"css":[');
      // Slow stylesheet I/O places this completed error response between the
      // two development barriers without replaying the failed mutation.
      await route.fulfill({ response, body: body.replaceAll('"css":[', '"css":["/__action-refresh-gate.css",') });
    });
    await page.getByRole('button', { name: 'Test action error', exact: true }).click();
    await requested;
    await page.evaluate(async () => {
      const application = await globalThis.__PRNEXT_DEV__.applications.get('app');
      const prepare = application.devPrepare;
      const gate = new Promise(resolve => { window.__releaseActionRefresh = resolve; });
      application.devPrepare = async options => {
        await prepare(options);
        window.__actionRefreshExportsReady = true;
        await gate;
      };
    });
    const other = await page.context().newPage();
    await other.goto(`${url}/about`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__actionRefreshExportsReady === true);
    await observeDevelopmentWait(page);
    releaseStyles();
    await page.waitForFunction(() => window.__actionRefreshWaitObserved === true);
    // The new navigation makes the action's UI obsolete while its outcome
    // must still reject for the application's catch handler.
    await page.evaluate(async () => {
      const application = await globalThis.__PRNEXT_DEV__.applications.get('app');
      application.router.refresh();
      window.__releaseActionRefresh();
    });
    await expect(page.getByTestId('action-error')).toContainText('PRNEXT_ACTION_PRIVATE_ERROR_DO_NOT_SEND');
    await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
    expect(posts).toBe(1);
  } finally {
    releaseStyles?.();
    await page.evaluate(() => window.__releaseActionRefresh?.()).catch(() => {});
  }
});

developmentTest('an action replacing an uncommitted refresh releases the development transaction', async ({ page, developmentApp: { url, fixture } }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/actions`);
  await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.evaluate(async () => {
    window.__actionRefreshDocument = {};
    const application = await globalThis.__PRNEXT_DEV__.applications.get('app');
    const render = application.root.render.bind(application.root);
    application.root.render = view => {
      render(view);
      if (typeof view?.props?.children?.props?.committed !== 'function') return;
      application.root.render = render;
      window.__actionRefreshCommitInterrupted = true;
      // React has received the refresh but has not committed it yet. A real
      // button event schedules the replacement through the normal transport.
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Increment on server').click();
    };
  });
  const client = path.join(fixture.root, 'app/actions/client.tsx');
  await writeFile(client, `${await readFile(client, 'utf8')}\n// exercise a superseded refresh commit\n`);
  await page.waitForFunction(() => window.__actionRefreshCommitInterrupted === true);
  await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
  await expect(page.getByTestId('server-count')).toHaveText('1');
  await expect(page.getByTestId('action-result')).toHaveText('1 / Date / server');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(await page.evaluate(() => !!window.__actionRefreshDocument)).toBe(true);
  expect(errors).toEqual([]);
});

developmentTest('bound forms remain valid when another tab compiles an unopened route', async ({ page, developmentApp: { url } }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/actions`);
  await page.waitForFunction(() => globalThis.__PRNEXT_DEV__?.confirmed === true);
  await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
  await page.getByLabel('Record value', { exact: true }).fill('another-tab');
  const generation = await page.evaluate(() => {
    window.__actionRefreshDocument = {};
    return globalThis.__PRNEXT_DEV__.buildId;
  });
  const other = await page.context().newPage();
  await other.goto(`${url}/about`);
  await page.waitForFunction(previous => globalThis.__PRNEXT_DEV__?.confirmed === true && globalThis.__PRNEXT_DEV__.buildId !== previous, generation);
  let mutations = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.headers()['next-action']) mutations++; });
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && !!response.request().headers()['next-action']);
  await page.getByRole('button', { name: 'Save bound record', exact: true }).click();
  expect((await completed).status()).toBe(200);
  await expect(page.getByTestId('server-bound')).toHaveText('record-42:another-tab');
  await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
  expect(mutations).toBe(1);
  expect(await page.evaluate(() => !!window.__actionRefreshDocument)).toBe(true);
  expect(errors).toEqual([]);
});
