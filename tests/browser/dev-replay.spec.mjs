import { test, expect } from '@playwright/test';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { devFixture } from '../dev-fixture.mjs';

const execute = promisify(execFile), require = createRequire(import.meta.url);

const component = ({ fixed = false, revision = 'original' } = {}) => `'use client';
import {useState} from 'react';
export default function ReplayFixture(){
  const [open,setOpen]=useState(false),[count,setCount]=useState(0);
  return <main style={{padding:60}}>
    <h1>Replay fixture</h1><p data-testid="revision">${revision}</p>
    <label>Search query <input name="query"/></label>
    <label>Private token <input type="password" name="token"/></label>
    <button onClick={()=>{${fixed ? 'setOpen(true)' : 'void 0'}}}>Open details</button>
    <button onClick={()=>setCount(count+1)}>Other action {count}</button>
    <a href="/docs/next">Next page</a>
    {open&&<p data-testid="details">Details ready</p>}
  </main>;
}`;

const scenario = (name = 'Open the details') => ({
  version: 1, name, viewport: { width: 1000, height: 700 }, steps: [
    { type: 'visit', path: '/docs/pages' },
    { type: 'click', target: { kind: 'role', role: 'button', name: 'Open details' } },
    { type: 'expectText', target: { kind: 'testId', value: 'details' }, text: 'Details ready' },
  ],
});

async function startFixture(options = {}) {
  return devFixture({ files: {
    // This application explicitly opts into the installed test-only adapter.
    // Resolution starts at this application's package.json, never PRNext's.
    'package.json': JSON.stringify({ name: 'prnext-replay-browser-test', type: 'module', devDependencies: { '@playwright/test': '*' } }),
    'components/Replay.jsx': component(options),
    'pages/pages.jsx': "export {default} from '../components/Replay';",
    'pages/next.jsx': "export {default} from '../components/Replay';",
  } });
}

async function tool(page, name, args = {}) {
  return page.evaluate(({ name, args }) => window.__PRNEXT_DEV__.tools.call(name, args), { name, args });
}

async function ready(page, fixture) {
  await page.goto(fixture.url + '/docs/pages');
  await expect.poll(() => page.evaluate(() => Boolean(window.__PRNEXT_DEV__?.confirmed))).toBe(true);
}

async function panel(page) {
  const host = page.locator('prnext-dev-tools');
  await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
  await host.getByRole('button', { name: 'Replay', exact: true }).click();
  const replay = host.locator('.wb-replay');
  await expect(replay).toBeVisible();
  return replay;
}

async function completed(invoke, id, runId) {
  let result;
  await expect.poll(async () => {
    result = await invoke('dev_replay_result', { id, runId });
    return result.run?.state;
  }, { timeout: 35000 }).not.toBe('running');
  expect(result.run?.runId).toBe(runId);
  return result;
}

function screenshots(run) {
  for (const name of ['before', 'after']) {
    const screenshot = run.screenshots[name];
    expect(screenshot.mimeType).toBe('image/png');
    expect(Buffer.from(screenshot.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(screenshot.width).toBeGreaterThanOrEqual(240);
    expect(screenshot.height).toBeGreaterThanOrEqual(240);
  }
}

async function executeExport(fixture, exported, testInfo) {
  const directory = path.join(fixture.root, '.prnext-replays', 'exported-test');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'replay-export.spec.mjs'), exported.code);
  await writeFile(path.join(directory, 'playwright.config.mjs'), `export default ${JSON.stringify({ testDir: '.', testMatch: 'replay-export.spec.mjs', workers: 1, timeout: 30000, outputDir: testInfo.outputPath('exported-test-results'), use: { baseURL: fixture.url, browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure' } })};`);
  const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  let result;
  try {
    result = await execute(process.execPath, [cli, 'test', '--config', path.join(directory, 'playwright.config.mjs')], { cwd: directory, env: { ...process.env, PRNEXT_REPLAY_BASE_URL: fixture.url }, timeout: 60000, maxBuffer: 1024 ** 2, windowsHide: true });
  } catch (error) {
    // These exported fixtures contain only public test labels. Preserve the
    // child assertion, rather than replacing it with an opaque spawn failure.
    throw Error('Exported Playwright test failed:\n' + (error.stdout || '') + '\n' + (error.stderr || ''));
  }
  expect(result.stdout).toMatch(/1 passed/);
}

test.describe('functional development replay', () => {
  test.setTimeout(150000);
  let fixture;
  test.afterEach(async () => { await fixture?.close(); fixture = undefined; });

  test('manual recording, assertions and replay work without an assistant and never retain typed secrets', async ({ page }) => {
    fixture = await startFixture({ fixed: true });
    await page.setViewportSize({ width: 1000, height: 700 });
    await ready(page, fixture);
    expect((await tool(page, 'dev_connection')).connected).toBe(false);
    let replay = await panel(page);
    await replay.getByRole('button', { name: 'Start recording', exact: true }).click();
    const secret = 'replay-private-password-83652';
    await page.getByLabel('Private token').fill(secret);
    await page.getByRole('button', { name: 'Open details', exact: true }).click();
    await expect(page.getByTestId('details')).toHaveText('Details ready');
    const toolbar = page.locator('prnext-dev-replay').getByRole('region', { name: 'Replay recording' });
    await toolbar.getByRole('button', { name: 'Add text assertion', exact: true }).click();
    await page.getByTestId('details').click();
    await toolbar.getByRole('button', { name: 'Stop recording', exact: true }).click();
    replay = page.locator('prnext-dev-tools .wb-replay');
    await expect(replay).toBeVisible();
    await replay.getByRole('textbox', { name: 'Scenario name', exact: true }).fill('Manual details regression');
    await replay.getByRole('button', { name: 'Save scenario', exact: true }).click();
    let saved;
    await expect.poll(async () => {
      saved = (await tool(page, 'dev_replay_list')).scenarios.find(item => item.name === 'Manual details regression');
      return Boolean(saved);
    }).toBe(true);
    expect(saved.steps.map(step => step.type)).toEqual(['visit', 'click', 'expectText']);
    expect(saved.steps[1].target).toEqual({ kind: 'role', role: 'button', name: 'Open details' });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(await page.evaluate(() => sessionStorage.getItem('__prnext_replay_draft_v1__') || '')).not.toContain(secret);
    await replay.getByRole('button', { name: 'Run replay', exact: true }).click();
    let result;
    await expect.poll(async () => {
      result = await tool(page, 'dev_replay_result', { id: saved.id });
      return result.run?.state;
    }, { timeout: 35000 }).toBe('verified');
    expect(result.run.verified).toBe(true);
    await expect(replay.locator('button[data-scenario-id="' + saved.id + '"]')).toContainText('Verified');
    screenshots(result.run);
    expect((await tool(page, 'dev_connection')).connected).toBe(false);
    for (const directory of ['scenarios', 'results']) {
      for (const filename of await readdir(path.join(fixture.root, '.prnext-replays', directory))) {
        const bytes = await readFile(path.join(fixture.root, '.prnext-replays', directory, filename));
        expect(bytes.toString('utf8')).not.toContain(secret);
      }
    }
  });

  test('a silent broken handler and an unrelated build fail; only the actual fix verifies its exact browser generation', async ({ page }, testInfo) => {
    fixture = await startFixture();
    await ready(page, fixture);
    const browserErrors = [];
    const missingAssets = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (response.status() === 404 && pathname.includes('/_prnext/assets/')) missingAssets.push(pathname);
    });
    const assistant = await fixture.connectAI();
    const invoke = (name, args) => assistant.call(name, args);
    const { scenario: saved } = await invoke('dev_replay_save', { scenario: scenario() });
    async function run() {
      const started = await invoke('dev_replay_run', { id: saved.id });
      expect(started.state).toBe('running');
      return completed(invoke, saved.id, started.runId);
    }
    const original = await run();
    expect(original.run.state).toBe('failed');
    expect(original.run.verified).toBe(false);
    expect(original.run.steps.at(-1).state).toBe('failed');
    expect(original.run.errors).toEqual([]);
    // MCP delivers screenshots as image blocks and omits their bytes from the
    // structured text. Inspect the local HTTP evidence for both PNGs.
    screenshots((await tool(page, 'dev_replay_result', { id: saved.id, runId: original.run.runId })).run);
    let accepted = original.run.before.sequence;
    // Keep the Replay panel unloaded across more generations than the asset
    // retention window. Its first opening must use the current lazy module.
    for (const revision of ['unrelated edit', 'another unrelated edit', 'final unrelated edit']) {
      await fixture.write('components/Replay.jsx', component({ revision }));
      await expect(page.getByTestId('revision')).toHaveText(revision, { timeout: 25000 });
      await expect.poll(() => page.evaluate(previous => {
        const state = window.__PRNEXT_DEV__;
        return state.confirmed && state.sequence > previous;
      }, accepted), { timeout: 25000 }).toBe(true);
      accepted = await page.evaluate(() => window.__PRNEXT_DEV__.sequence);
    }
    const unrelated = await run();
    expect(unrelated.run.state).toBe('failed');
    expect(unrelated.run.verified).toBe(false);
    expect(unrelated.run.before.buildId).not.toBe(original.run.before.buildId);
    expect(unrelated.previous.runId).toBe(original.run.runId);
    await fixture.write('components/Replay.jsx', component({ fixed: true, revision: 'actual fix' }));
    await expect(page.getByTestId('revision')).toHaveText('actual fix', { timeout: 25000 });
    await expect.poll(() => page.evaluate(() => window.__PRNEXT_DEV__.confirmed)).toBe(true);
    const generation = await invoke('dev_snapshot');
    const fixed = await run();
    expect(fixed.run.state).toBe('verified');
    expect(fixed.run.verified).toBe(true);
    expect(fixed.run.steps.every(step => step.state === 'passed')).toBe(true);
    expect(fixed.run.before.buildId).toBe(generation.buildId);
    expect(fixed.run.after.buildId).toBe(generation.buildId);
    expect(fixed.run.before.sequence).toBe(generation.sequence);
    expect(fixed.run.after.sequence).toBe(generation.sequence);
    expect(fixed.run.before.session).toBe(generation.session);
    expect(fixed.run.after.session).toBe(generation.session);
    expect(fixed.previous.runId).toBe(unrelated.run.runId);
    screenshots((await tool(page, 'dev_replay_result', { id: saved.id, runId: fixed.run.runId })).run);
    expect(browserErrors).toEqual([]);
    const exported = await invoke('dev_replay_export', { id: saved.id });
    expect(exported.code).toMatch(/@playwright\/test/);
    expect(exported.code).toContain('Open details');
    expect(exported.code).toContain('Details ready');
    expect(exported.code).not.toMatch(/dev_replay_run|__PRNEXT_DEV__/);
    await executeExport(fixture, exported, testInfo);
    const review = await panel(page);
    await expect(review.locator('.wb-replay-result')).toHaveAttribute('data-state', 'verified');
    const runButton = review.getByRole('button', { name: 'Run replay', exact: true });
    await runButton.evaluate(node => { window.__replayFocusedRunButton = node; node.focus(); });
    await fixture.write('components/Replay.jsx', component({ fixed: true, revision: 'focus preserved' }));
    await expect(page.getByTestId('revision')).toHaveText('focus preserved', { timeout: 25000 });
    await expect(runButton).toBeFocused();
    expect(await runButton.evaluate(node => node === window.__replayFocusedRunButton)).toBe(true);
    expect(missingAssets).toEqual([]);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await review.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('replay-' + width + '.png') });
    }
  });

  test('ordinary fills persist only parameter names and reject malformed or external-route scenarios', async ({ page }) => {
    fixture = await startFixture({ fixed: true });
    await ready(page, fixture);
    const replay = await panel(page);
    await replay.getByRole('button', { name: 'Start recording', exact: true }).click();
    const typed = 'private query 497351';
    await page.getByLabel('Search query').fill(typed);
    const toolbar = page.locator('prnext-dev-replay').getByRole('region', { name: 'Replay recording' });
    await toolbar.getByRole('button', { name: 'Add URL assertion', exact: true }).click();
    await toolbar.getByRole('button', { name: 'Stop recording', exact: true }).click();
    const draft = await page.evaluate(() => window[Symbol.for('prnext.dev.replay.recorder')].getState().scenario);
    expect(draft.steps[1]).toEqual({ type: 'fill', target: { kind: 'label', value: 'Search query' }, parameter: 'field1' });
    expect(JSON.stringify(draft)).not.toContain(typed);
    expect(await page.evaluate(() => sessionStorage.getItem('__prnext_replay_draft_v1__'))).not.toContain(typed);
    const { scenario: saved } = await tool(page, 'dev_replay_save', { scenario: draft });
    const invoke = (name, args) => tool(page, name, args);
    const started = await invoke('dev_replay_run', { id: saved.id, parameters: { field1: typed } });
    const result = await completed(invoke, saved.id, started.runId);
    expect(result.run.state).toBe('verified');
    expect(JSON.stringify(result)).not.toContain(typed);
    expect((await invoke('dev_replay_export', { id: saved.id })).code).not.toContain(typed);
    for (const invalid of [
      { ...scenario(), steps: [{ type: 'visit', path: 'https://example.com/' }, { type: 'expectURL', path: '/' }] },
      { ...scenario(), steps: [{ type: 'visit', path: '//example.com/' }, { type: 'expectURL', path: '/' }] },
      { ...scenario(), steps: [{ type: 'visit', path: '/docs/pages' }] },
      { ...scenario(), steps: [{ type: 'expectURL', path: '/docs/pages' }] },
    ]) await expect(invoke('dev_replay_save', { scenario: invalid })).rejects.toThrow();
    expect((await invoke('dev_replay_list')).scenarios).toHaveLength(1);
  });

  test('recording survives full navigation and the review controls fit narrow keyboard-operated viewports', async ({ page }) => {
    fixture = await startFixture({ fixed: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 720 });
      await ready(page, fixture);
      const replay = await panel(page);
      const start = replay.getByRole('button', { name: 'Start recording', exact: true });
      await start.focus();
      await page.keyboard.press('Enter');
      const navigating = page.waitForURL(fixture.url + '/docs/next');
      await page.getByRole('link', { name: 'Next page', exact: true }).click();
      await navigating;
      const toolbar = page.locator('prnext-dev-replay').getByRole('region', { name: 'Replay recording' });
      await expect(toolbar).toBeVisible();
      const pause = toolbar.getByRole('button', { name: 'Pause recording', exact: true });
      await pause.focus(); await page.keyboard.press('Enter');
      const resume = toolbar.getByRole('button', { name: 'Resume recording', exact: true });
      await expect(resume).toHaveAttribute('aria-pressed', 'true');
      await resume.focus(); await page.keyboard.press('Enter');
      await toolbar.getByRole('button', { name: 'Add on-screen assertion', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => window[Symbol.for('prnext.dev.replay.recorder')].getState().picking)).toBe(null);
      await toolbar.getByRole('button', { name: 'Add text assertion', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await toolbar.getByRole('button', { name: 'Add URL assertion', exact: true }).focus();
      await page.keyboard.press('Enter');
      await toolbar.getByRole('button', { name: 'Stop recording', exact: true }).focus();
      await page.keyboard.press('Enter');
      const review = page.locator('prnext-dev-tools .wb-replay');
      await expect(review).toBeVisible();
      const draft = await page.evaluate(() => window[Symbol.for('prnext.dev.replay.recorder')].getState().scenario);
      expect(draft.steps).toEqual([
        { type: 'visit', path: '/docs/pages' },
        { type: 'click', target: { kind: 'role', role: 'link', name: 'Next page' } },
        { type: 'expectURL', path: '/docs/next' },
        { type: 'expectText', target: { kind: 'role', role: 'heading', name: 'Replay fixture' }, text: 'Replay fixture' },
        { type: 'expectURL', path: '/docs/next' },
      ]);
      expect(await review.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const bounds = await review.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      const name = review.getByRole('textbox', { name: 'Scenario name', exact: true });
      await name.fill('Navigation at ' + width);
      await review.getByRole('button', { name: 'Save scenario', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(review.getByRole('button', { name: 'Run replay', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(review).toBeHidden();
      await expect(page.locator('prnext-dev-tools').getByRole('button', { name: /Open PRNext developer tools/ })).toBeFocused();
    }
  });
});
