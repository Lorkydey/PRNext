import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, freePort, repositoryRoot } from '../support.mjs';

async function developmentFixture(testInfo, prepare, run, beforeClose = () => {}) {
  const fixture = await appFixture();
  const origin = `http://127.0.0.1:${await freePort()}`;
  let child, output = '', forced = false;
  try {
    await prepare(fixture.root);
    child = spawn(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'dev', fixture.root,
      '--hostname', '127.0.0.1', '--port', new URL(origin).port], {
      env: { ...process.env, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let launchError;
    child.on('error', error => { launchError = error; });
    const capture = bytes => { output = (output + bytes).slice(-24_000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    for (let attempt = 0; ; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw Error('Development server exited before readiness');
      try { await fetch(origin + '/robots.txt'); break; } catch {}
      if (attempt >= 200) throw Error('Development server did not become ready');
      await delay(50);
    }
    await run(origin, fixture.root);
  } catch (error) { error.message += '\nDevelopment output:\n' + output; throw error; }
  finally {
    try { await beforeClose(); }
    finally {
      try { await writeFile(testInfo.outputPath('development-server.log'), output); }
      finally {
        try {
          if (child && child.exitCode === null && !child.signalCode) await new Promise(resolve => {
            const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 7000);
            child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
          });
        } finally { await fixture.remove(); }
      }
    }
    expect(forced).toBe(false);
  }
}

test('superseding a development Flight with an unresolved row keeps its layout and revisits fresh data', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  let release, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const data = createServer((request, response) => {
    const number = ++requests;
    if (number === 1) void gate.then(() => { if (!response.destroyed) response.end('old suspended value'); });
    else response.end('fresh revisit value');
  });
  await new Promise(resolve => data.listen(0, '127.0.0.1', resolve));
  const dataUrl = `http://127.0.0.1:${data.address().port}/value`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await developmentFixture(testInfo, async root => {
      const navigation = path.join(root, 'components/navigation.tsx');
      await writeFile(navigation, (await readFile(navigation, 'utf8')).replace('</nav>', '<Link href="/pending-row" prefetch={false}>Pending row</Link></nav>'));
      await mkdir(path.join(root, 'app/pending-row'), { recursive: true });
      await writeFile(path.join(root, 'app/pending-row/page.tsx'), `import {Suspense} from 'react';
export const dynamic='force-dynamic';
async function Row(){const response=await fetch(${JSON.stringify(dataUrl)},{cache:'no-store'});return <p data-testid="received-row">{await response.text()}</p>}
export default function Page(){return <><h1>Pending row route</h1><Suspense fallback={<p data-testid="pending-row">Still receiving this row</p>}><Row/></Suspense></>}`);
    }, async origin => {
      await page.goto(origin + '/about');
      await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
      await page.evaluate(() => { window.__streamDocument = true; });
      await page.getByRole('link', { name: 'Pending row', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Pending row route', exact: true })).toBeVisible();
      await expect(page.getByTestId('pending-row')).toBeVisible();
      await expect.poll(() => requests).toBe(1);
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'About', exact: true }).click();
      await expect(page).toHaveURL(origin + '/about');
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__streamDocument)).toBe(true);
      release();
      await page.getByRole('link', { name: 'Pending row', exact: true }).click();
      await expect(page.getByTestId('received-row')).toHaveText('fresh revisit value');
      expect(requests).toBeGreaterThanOrEqual(2);
      await expect(page.getByText('old suspended value', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__streamDocument)).toBe(true);
      expect(errors).toEqual([]);
      await writeFile(testInfo.outputPath('row-observations.json'), JSON.stringify({ originRequests: requests, unresolvedRowWasVisible: true, freshValue: true, sameDocument: true, layoutCount: 1 }, null, 2));
    }, release);
  } finally {
    release();
    data.closeAllConnections();
    await new Promise(resolve => data.close(resolve));
  }
});

test('a DOM-committed partial development view cannot retain account A drafts after account B authorizes', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const errors = [], postEvents = []; let postOverflow = false, appOrigin, sidecarOrigin;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const url = new URL(request.url());
    const event = { origin: url.origin, path: url.pathname, queryPresent: url.search !== '', actionHeaderPresent: Object.hasOwn(request.headers(), 'next-action') };
    if (postEvents.length < 100) postEvents.push(event); else postOverflow = true;
  });
  const assertNoApplicationMutation = () => {
    expect(postOverflow).toBe(false);
    expect(postEvents.filter(event => event.origin === appOrigin)).toEqual([]);
    expect(postEvents.filter(event => event.actionHeaderPresent)).toEqual([]);
    for (const event of postEvents) {
      const endpoint = new URL(event.origin);
      expect(['127.0.0.1', 'localhost', '[::1]']).toContain(endpoint.hostname);
      expect(endpoint.protocol).toBe('http:');
      expect(event.origin).not.toBe(appOrigin);
      expect(event.origin).toBe(sidecarOrigin);
      expect(event.path).toBe('/v1/browser');
      expect(event.queryPresent).toBe(false);
    }
  };
  await developmentFixture(testInfo, async root => {
    await writeFile(path.join(root, 'prnext.config.mjs'), `export default {navigationCache:{authCookies:['tenant']}}`);
    const navigation = path.join(root, 'components/navigation.tsx');
    await writeFile(navigation, (await readFile(navigation, 'utf8')).replace('return <header>', 'return <header><input aria-label="Layout draft"/>').replace('</nav>', '<Link href="/private-draft" prefetch={false}>Private draft</Link></nav>'));
    await mkdir(path.join(root, 'app/private-draft'), { recursive: true });
    await writeFile(path.join(root, 'components/private-draft.tsx'), `'use client';export default function Draft(){return <input aria-label="Page draft"/>}`);
    await writeFile(path.join(root, 'app/private-draft/page.tsx'), `import {cookies} from 'next/headers';import {randomUUID} from 'node:crypto';import Draft from '../../components/private-draft';export const dynamic='force-dynamic';export default async function Page(){return <><p data-testid="tenant">{(await cookies()).get('tenant')?.value||'guest'}</p><p data-testid="response-token">{randomUUID()}</p><Draft/></>}`);
  }, async (origin, root) => {
    appOrigin = origin;
    // Read only the endpoint from our own fixture's generated public config;
    // never record its ephemeral sidecar token or request bodies/headers.
    const manifest = JSON.parse(await readFile(path.join(root, '.prnext/manifest.json'), 'utf8'));
    sidecarOrigin = new URL(manifest.devTools.endpoint).origin;
    await context.addCookies([{ name: 'tenant', value: 'account-a', url: origin, httpOnly: true }]);
    await page.goto(origin + '/private-draft');
    await expect(page.getByTestId('tenant')).toHaveText('account-a');
    await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
    await page.getByRole('textbox', { name: 'Layout draft', exact: true }).fill('ACCOUNT_A_LAYOUT_DRAFT');
    await page.getByRole('textbox', { name: 'Page draft', exact: true }).fill('ACCOUNT_A_PAGE_DRAFT');
    const initialResponse = await page.getByTestId('response-token').textContent();
    await page.evaluate(() => {
      window.__accountDocument = true;
      const fetch = globalThis.fetch.bind(globalThis); let selected = false;
      globalThis.fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        const response = await fetch(input, init);
        if (selected || (init?.method || 'GET') !== 'GET' || headers.get('RSC') !== '1' || new URL(String(input), location.href).pathname !== '/private-draft') return response;
        selected = true;
        const media = response.headers.get('content-type')?.split(';', 1)[0].trim();
        if (response.status !== 200 || !['text/x-component', 'application/x-prnext-flight-delta'].includes(media)) { await response.body?.cancel(); throw Error('Account gate requires successful Flight'); }
        const reader = response.body.getReader(), signal = init?.signal;
        let release, stopped = false, controller, bytes = 0;
        const gate = new Promise(resolve => { release = resolve; });
        window.__releaseAccountEof = release;
        const clean = () => { signal?.removeEventListener('abort', abort); try { reader.releaseLock(); } catch {} };
        const cancel = reason => Promise.resolve(reader.cancel(reason)).catch(() => {}).finally(clean);
        const abort = () => { if (stopped) return; stopped = true; release(); try { controller.error(signal.reason); } catch {} void cancel(signal.reason); };
        const stream = new ReadableStream({
          start(value) { controller = value; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); },
          async pull(value) {
            if (stopped) return;
            try {
              const next = await reader.read(); if (stopped) return;
              if (next.done) { window.__accountEofHeld = true; await gate; if (!stopped) { stopped = true; clean(); value.close(); } }
              else { bytes += next.value.byteLength; if (bytes > 1024 * 1024) throw Error('Account gate exceeds1MiB'); value.enqueue(next.value); }
            } catch (error) { if (!stopped) { stopped = true; release(); value.error(error); await cancel(error); } }
          },
          async cancel(reason) { stopped = true; release(); await cancel(reason); },
        }, { highWaterMark: 0 });
        const metadata = { url: response.url, redirected: response.redirected, type: response.type };
        const decorate = result => { for (const [key, value] of Object.entries(metadata)) Object.defineProperty(result, key, { value, configurable: true }); const clone = result.clone.bind(result); Object.defineProperty(result, 'clone', { value: () => decorate(clone()), configurable: true }); return result; };
        return decorate(new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }));
      };
    });
    try {
      await page.getByRole('link', { name: 'Private draft', exact: true }).click();
      await page.waitForFunction(() => window.__accountEofHeld, null, { timeout: 5000 });
      await expect(page.getByTestId('response-token')).not.toHaveText(initialResponse);
      await expect(page.getByRole('textbox', { name: 'Layout draft', exact: true })).toHaveValue('ACCOUNT_A_LAYOUT_DRAFT');
      await expect(page.getByRole('textbox', { name: 'Page draft', exact: true })).toHaveValue('ACCOUNT_A_PAGE_DRAFT');
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      await context.addCookies([{ name: 'tenant', value: 'account-b', url: origin, httpOnly: true }]);
      await page.getByRole('link', { name: 'Private draft', exact: true }).click();
      await expect(page.getByTestId('tenant')).toHaveText('account-b');
      await expect(page.getByRole('textbox', { name: 'Layout draft', exact: true })).toHaveValue('');
      await expect(page.getByRole('textbox', { name: 'Page draft', exact: true })).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Layout count: 0', exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__accountDocument)).toBeUndefined();
      assertNoApplicationMutation();
      expect(errors).toEqual([]);
    } finally { await page.evaluate(() => window.__releaseAccountEof?.()).catch(() => {}); }
  });
  assertNoApplicationMutation();
  await writeFile(testInfo.outputPath('account-observations.json'), JSON.stringify({ appOrigin, sidecarOrigin, postEvents,
    sameAccountBothDraftsPreserved: true, sameAccountLayoutCount: 1, newAccountBothDraftsEmpty: true,
    newAccountLayoutCount: 0, documentReauthorized: true }, null, 2));
});
