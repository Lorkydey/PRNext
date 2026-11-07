import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, freePort, repositoryRoot } from '../support.mjs';

for (const scenario of ['after-root', 'before-root', 'before-root-then-partial-navigation', 'newer-edit']) {
  test(`development refresh ownership: ${scenario}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const fixture = await appFixture();
    const origin = `http://127.0.0.1:${await freePort()}`;
    let child, output = '', forced = false;
    try {
      await writeFile(path.join(fixture.root, 'components/environment.tsx'), `'use client'; export default function Environment(){return <p data-testid="client-environment">{process.env.NODE_ENV}</p>;}`);
      const pagePath = path.join(fixture.root, 'app/page.tsx');
      const source = await readFile(pagePath, 'utf8');
      await writeFile(pagePath, `import Environment from '../components/environment';\n${source.replace('return <>', 'return <><Environment /><p data-testid="server-environment">{process.env.NODE_ENV}</p>')}`);
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
      await page.goto(origin + '/?view=development');
      await expect(page.getByTestId('client-environment')).toHaveText('development');
      await page.getByRole('button', { name: 'Layout count: 0', exact: true }).click();
      await page.getByRole('button', { name: 'Page count: 0', exact: true }).click();
      await page.getByRole('link', { name: 'About', exact: true }).click();
      await expect(page).toHaveURL(origin + '/about');
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      await page.evaluate(async ({ scenario }) => {
        const fetch = globalThis.fetch.bind(globalThis);
        const gates = new Map();
        window.__refreshOwnership = { events: [], selected: false, refreshReturned: false, commits: 0, commitResults: {} };
        const record = (kind, details = {}) => {
          const state = window.__refreshOwnership;
          if (state.events.length < 80) state.events.push({ kind, at: performance.now(), path: location.pathname,
            applying: globalThis.__PRNEXT_DEV__?.applying, ...details });
        };
        const app = await globalThis.__PRNEXT_DEV__.applications.get('app');
        {
          const commit = app.devCommit;
          app.devCommit = async (...args) => {
            const state = window.__refreshOwnership, id = ++state.commits;
            state.insideCommit = id;
            record('refresh-enter', { commit: id });
            try {
              const committed = await commit(...args);
              state.commitResults[id] = committed === true;
              record('refresh-result', { commit: id, committed: committed === true });
              return committed;
            } finally { state.insideCommit = false; state.refreshReturned = true; record('refresh-return', { commit: id }); }
          };
        }
        globalThis.fetch = async (input, init) => {
          const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
          const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const response = await fetch(input, init);
          const state = window.__refreshOwnership;
          const refresh = !state.selected && state.insideCommit && url.pathname === '/about' && globalThis.__PRNEXT_DEV__?.applying;
          const navigation = scenario === 'before-root-then-partial-navigation' && url.pathname === '/actions' && !gates.has('navigation');
          if (method !== 'GET' || url.origin !== location.origin || headers.get('RSC') !== '1' || (!refresh && !navigation)) return response;
          if (refresh) { state.selected = true; state.selectedCommit = state.insideCommit; }
          const key = refresh ? 'refresh' : 'navigation';
          const media = response.headers.get('content-type')?.split(';', 1)[0].trim();
          if (response.status !== 200 || !['text/x-component', 'application/x-prnext-flight-delta'].includes(media)) {
            await response.body?.cancel(); throw Error('Owned gate requires a successful Flight response');
          }
          let release, controller, stopped = false, held = false, bytes = 0;
          const gate = new Promise(resolve => { release = resolve; });
          const reader = response.body.getReader();
          const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
          state[key + 'Active'] = true;
          const clean = () => { signal?.removeEventListener('abort', abort); try { reader.releaseLock(); } catch {} };
          const cancel = reason => Promise.resolve(reader.cancel(reason)).catch(() => {}).finally(clean);
          const abort = () => {
            if (stopped) return;
            stopped = true; state[key + 'Active'] = false; release();
            try { controller.error(signal.reason || new DOMException('Superseded gate', 'AbortError')); } catch {}
            void cancel(signal.reason); record(key + '-abort', { bytes });
          };
          gates.set(key, { release });
          const stream = new ReadableStream({
            start(value) { controller = value; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); },
            async pull(value) {
              if (stopped) return;
              try {
                const next = await reader.read();
                if (stopped) return;
                // Pre-root cases hold HMR before publishing ANY root bytes.
                // The after-root case and second navigation relay all bytes
                // and hold EOF only, allowing an incomplete DOM view to commit.
                if (!held && (refresh && scenario !== 'after-root' || next.done)) {
                  held = true; state[key + 'Held'] = true; record(key + '-held', { bytes });
                  await gate;
                  if (stopped) return;
                }
                if (next.done) { stopped = true; state[key + 'Active'] = false; clean(); value.close(); record(key + '-end', { bytes }); }
                else { bytes += next.value.byteLength; if (bytes > 1024 * 1024) throw Error('Owned gate exceeds1MiB'); value.enqueue(next.value); }
              } catch (error) {
                if (!stopped) { stopped = true; state[key + 'Active'] = false; release(); value.error(error); await cancel(error); }
              }
            },
            async cancel(reason) { stopped = true; state[key + 'Active'] = false; release(); await cancel(reason); record(key + '-cancel', { bytes }); },
          }, { highWaterMark: 0 });
          const metadata = { url: response.url, redirected: response.redirected, type: response.type };
          const decorate = result => {
            for (const [key, value] of Object.entries(metadata)) Object.defineProperty(result, key, { value, configurable: true });
            const clone = result.clone.bind(result); Object.defineProperty(result, 'clone', { value: () => decorate(clone()), configurable: true });
            return result;
          };
          return decorate(new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }));
        };
        window.__releaseRefreshOwnership = () => { for (const gate of gates.values()) gate.release(); };
      }, { scenario });
      const file = path.join(fixture.root, 'components/navigation.tsx');
      const navigationSource = await readFile(file, 'utf8');
      await writeFile(file, navigationSource + '\n// First genuine development edit.\n');
      await page.waitForFunction(() => window.__refreshOwnership.refreshHeld, null, { timeout: 15_000 });
      if (scenario === 'after-root') {
        await page.waitForFunction(() => window.__refreshOwnership.refreshReturned && !globalThis.__PRNEXT_DEV__?.applying, null, { timeout: 5000 });
        const beforeActions = await page.evaluate(() => {
          const state = window.__refreshOwnership;
          return state.beforeActions = { committed: state.commitResults[state.selectedCommit], active: state.refreshActive,
            terminalEvents: state.events.filter(event => ['refresh-end', 'refresh-abort', 'refresh-cancel'].includes(event.kind)) };
        });
        expect(beforeActions).toEqual({ committed: true, active: true, terminalEvents: [] });
      }
      else expect(await page.evaluate(() => window.__refreshOwnership.refreshReturned)).toBe(false);
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      if (scenario === 'newer-edit') {
        await writeFile(file, navigationSource.replace('return <header>', 'return <header data-testid="newest-generation">') + '\n// Newer genuine development edit.\n');
        await expect(page.getByTestId('newest-generation')).toBeVisible();
      } else {
        await page.getByRole('link', { name: 'Actions', exact: true }).click();
        await expect(page).toHaveURL(origin + '/actions');
        await expect(page).toHaveTitle('Server Actions · PRNext');
        if (scenario === 'before-root-then-partial-navigation') {
          await page.waitForFunction(() => window.__refreshOwnership.navigationHeld, null, { timeout: 5000 });
          await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
          await page.getByRole('link', { name: 'Home', exact: true }).click();
          await expect(page).toHaveURL(origin + '/');
          await expect(page.getByTestId('client-environment')).toHaveText('development');
        }
      }
      await expect(page.getByRole('button', { name: 'Layout count: 1', exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__refreshOwnership.events.some(event => ['refresh-abort', 'refresh-cancel'].includes(event.kind)))).toBe(true);
    } catch (error) { error.message += '\nDevelopment output:\n' + output; throw error; }
    finally {
      await page.evaluate(() => window.__releaseRefreshOwnership?.()).catch(() => {});
      const browser = await page.evaluate(() => window.__refreshOwnership).catch(() => null);
      try {
        await writeFile(testInfo.outputPath('refresh-ownership.json'), JSON.stringify(browser, null, 2));
        await writeFile(testInfo.outputPath('development-server.log'), output);
      } finally {
        try {
          if (child && child.exitCode === null && !child.signalCode) await new Promise(resolve => {
            const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 7000);
            child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
          });
        } finally { await fixture.remove(); }
      }
      expect(forced).toBe(false);
    }
  });
}
