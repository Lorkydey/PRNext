import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, freePort, repositoryRoot } from '../support.mjs';

test('an in-flight App navigation waits for a development module update before committing', async ({ page }, testInfo) => {
  const fixture = await appFixture();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let output = '';
  let releaseResponse;
  const heldResponse = new Promise(resolve => { releaseResponse = resolve; });
  let requestHeld;
  const heldRequest = new Promise(resolve => { requestHeld = resolve; });
  let releaseEnsure;
  const heldEnsure = new Promise(resolve => { releaseEnsure = resolve; });
  let ensureHeld;
  const coldEnsure = new Promise(resolve => { ensureHeld = resolve; });
  try {
    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'dev', fixture.root,
      '--hostname', '127.0.0.1', '--port', String(port)], {
      env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launchError;
    child.on('error', error => { launchError = error; });
    const capture = chunk => { output = `${output}${chunk}`.slice(-24_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    for (let attempt = 0; ; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Development server exited before becoming ready');
      try { await fetch(`${origin}/robots.txt`); break; } catch { /* Initial compilation is still running. */ }
      if (attempt >= 200) throw new Error('Development server did not become ready');
      await delay(50);
    }
    await page.goto(origin);
    await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    await page.evaluate(() => { window.__navigationRefreshDocument = crypto.randomUUID(); });
    const documentId = await page.evaluate(() => window.__navigationRefreshDocument);

    // Let the normal navigation ensure /about first. Its real Flight request
    // is already running when another cold route changes the module graph.
    await page.route(`${origin}/about`, async route => {
      if (route.request().headers().rsc !== '1') return route.continue();
      requestHeld();
      await heldResponse;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.route(`${origin}/_prnext/ensure?*`, async route => {
      if (new URL(route.request().url()).searchParams.get('path') === '/items/alpha') {
        ensureHeld();
        await heldEnsure;
      }
      await route.continue();
    });
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await heldRequest;
    const clientId = 'client-' + createHash('sha256').update('components/navigation.tsx').digest('hex').slice(0, 16);
    await page.evaluate(async clientId => {
      const development = globalThis.__PRNEXT_DEV__;
      const application = await development.applications.get('app');
      const prepare = application.devPrepare;
      const render = application.root.render.bind(application.root);
      const originalType = globalThis.__webpack_require__(clientId).default;
      window.__navigationRefreshRenders = 0;
      application.root.render = (...args) => {
        if (development.applying) window.__navigationRefreshRenders++;
        return render(...args);
      };
      application.devPrepare = async options => {
        await prepare(options);
        application.devPrepare = prepare;
        window.__navigationRefreshClientTypeChanged = globalThis.__webpack_require__(clientId).default !== originalType;
        window.__navigationRefreshPrepared = true;
        await new Promise(resolve => { window.__releaseNavigationRefresh = resolve; });
      };
      // The intercepted real ensure request keeps navigation admission active
      // while the test gives this shared boundary new source bytes. Its hook
      // signature stays unchanged; this compiles a public route, not an action.
      window.__navigationRefreshEnsure = development.ensureRoute('/items/alpha');
      void window.__navigationRefreshEnsure.catch(() => {});
    }, clientId);
    await coldEnsure;
    const navigationFile = path.join(fixture.root, 'components/navigation.tsx');
    await writeFile(navigationFile, await readFile(navigationFile, 'utf8') + '\n// Shared layout source revision; hook signature unchanged.\n');
    releaseEnsure();
    await page.waitForFunction(() => window.__navigationRefreshPrepared === true);
    const navigationResponse = page.waitForResponse(response => response.url() === origin + '/about' && response.request().headers().rsc === '1');
    releaseResponse();
    await (await navigationResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const blocked = await page.evaluate(() => ({
      renders: window.__navigationRefreshRenders,
      clientTypeChanged: window.__navigationRefreshClientTypeChanged,
      path: location.pathname,
      layout: [...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Layout count: '))?.textContent,
      applying: globalThis.__PRNEXT_DEV__.applying,
      sameDocument: window.__navigationRefreshDocument,
    }));
    const diagnostic = testInfo.outputPath('navigation-before-refresh.json');
    await writeFile(diagnostic, JSON.stringify(blocked, null, 2));
    await testInfo.attach('navigation-before-refresh', { path: diagnostic, contentType: 'application/json' });
    expect(blocked.clientTypeChanged).toBe(true);
    expect(blocked.applying).toBe(true);
    expect(blocked.renders).toBe(0);
    await expect(page).toHaveURL(origin + '/');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();

    await page.evaluate(() => window.__releaseNavigationRefresh());
    await page.evaluate(() => window.__navigationRefreshEnsure);
    await expect(page).toHaveURL(origin + '/about');
    await expect(page.getByTestId('pathname')).toHaveText('/about');
    await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__navigationRefreshDocument)).toBe(documentId);
  } catch (error) {
    error.message += `\nDevelopment server output:\n${output}`;
    throw error;
  } finally {
    releaseResponse();
    releaseEnsure();
    await page.evaluate(() => window.__releaseNavigationRefresh?.()).catch(() => {});
    await writeFile(testInfo.outputPath('development-server.log'), output);
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
