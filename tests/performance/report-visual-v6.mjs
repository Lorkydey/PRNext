// Prepared only. Run after the final report and all benchmark measurements settle.
// No server or workload is started; Chromium reads the local HTML report.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(root, 'artifacts/performance-v6');
const input = path.join(base, 'report.html');
const outputName = process.argv[2] || 'report-qa';
assert.match(outputName, /^report-qa(?:-[a-z0-9]+)*$/, 'Use a distinct report-qa evidence directory name');
const output = path.join(base, outputName);
const script = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorRecord = error => ({ name: error?.name || 'Error', message: String(error?.message || error), stack: error?.stack });
const save = (name, value) => writeFile(path.join(output, name), value, { flag: 'wx' });
const desktop = { width: 1440, height: 1000 };
const mobile = { width: 390, height: 844 };

// Refuse redirection and existing evidence before writing anything. No deletion.
assert.equal(path.resolve(await realpath(base)).toLowerCase(), path.resolve(base).toLowerCase(), 'Report directory must not redirect outside the intended workspace');
assert.equal(path.dirname(output), base);
await mkdir(output); // EEXIST is intentional: never overwrite earlier QA.

const command = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
const result = {
  complete: false,
  kind: 'Local report rendering and DOM checks; no performance workload',
  startedAt: new Date().toISOString(),
  command,
  cwd: process.cwd(),
  input,
  output,
  node: process.version,
  v8: process.versions.v8,
  nodeExecutable: process.execPath,
  viewports: { desktop, mobile },
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  error: null,
};
let browser;
try {
  const source = await readFile(script);
  result.scriptSha256 = hash(source);
  await save('report-visual-v6.mjs', source);
  await save('command.json', JSON.stringify({ command, cwd: process.cwd(), node: process.version, startedAt: result.startedAt, scriptSha256: result.scriptSha256 }, null, 2) + '\n');
  assert.equal(process.version, 'v24.19.0', 'Use the pinned Node 24.19.0 executable for final QA');

  const htmlBytes = await readFile(input);
  result.reportSha256 = hash(htmlBytes);
  // The copy records exact input bytes. Navigation uses the original location
  // so report-relative links retain their actual resolution.
  await save('source-report.html', htmlBytes);
  const html = new TextDecoder('utf-8', { fatal: true }).decode(htmlBytes);
  assert.ok(!html.includes('\uFFFD'), 'HTML contains a Unicode replacement character');
  assert.ok(html.includes('Synth\u00e8se') && html.includes('Endurance'), 'Expected V6 headings are missing');
  assert.match(html, /<meta\b[^>]*charset\s*=\s*["']?utf-8/i, 'Explicit UTF-8 charset is required');
  result.utf8 = { fatalDecodePassed: true, replacementCharacters: 0, frenchHeadingsPresent: true };
  result.playwright = createRequire(import.meta.url)('@playwright/test/package.json').version;

  browser = await chromium.launch({ headless: true });
  result.chromium = browser.version();
  const page = await browser.newPage({ viewport: desktop, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => result.pageErrors.push(errorRecord(error)));
  page.on('console', message => {
    if (message.type() === 'error') result.consoleErrors.push({ text: message.text(), location: message.location() });
  });
  page.on('requestfailed', request => result.failedRequests.push({ url: request.url(), failure: request.failure() }));
  const url = pathToFileURL(input).href;
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  result.utf8.browserCharset = await page.evaluate(() => document.characterSet);
  assert.equal(result.utf8.browserCharset.toUpperCase(), 'UTF-8');

  result.anchors = await page.evaluate(() => {
    const samePage = new URL(location.href);
    const targets = [];
    const malformed = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      try {
        const resolved = new URL(href, document.baseURI);
        if (!resolved.hash || resolved.hash === '#') continue;
        if (!href.startsWith('#') && (resolved.protocol !== samePage.protocol || resolved.host !== samePage.host || resolved.pathname !== samePage.pathname)) continue;
        const id = decodeURIComponent(resolved.hash.slice(1));
        targets.push({ href, id, exists: document.getElementById(id) !== null });
      } catch (error) { malformed.push({ href, error: String(error) }); }
    }
    const seen = new Set();
    const duplicates = [];
    for (const element of document.querySelectorAll('[id]')) {
      if (seen.has(element.id)) duplicates.push(element.id);
      seen.add(element.id);
    }
    return { count: targets.length, targets, missing: targets.filter(target => !target.exists), malformed, duplicateIds: duplicates };
  });
  assert.ok(result.anchors.count > 0, 'No local section anchors found');
  assert.deepEqual(result.anchors.missing, [], 'A report anchor has no matching element');
  assert.deepEqual(result.anchors.malformed, [], 'Malformed report anchor');
  assert.deepEqual(result.anchors.duplicateIds, [], 'Duplicate report section IDs');

  async function screenshot(name, capture, description) {
    const file = path.join(output, name);
    const bytes = await capture(file);
    result.screenshots.push({ file: name, sha256: hash(bytes), bytes: bytes.length, description });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot('desktop-top.png', file => page.screenshot({ path: file }), 'Desktop 1440 × 1000, top of report');
  const summary = page.locator('section#summary');
  assert.equal(await summary.count(), 1, 'Expected one section#summary');
  await screenshot('desktop-summary.png', file => summary.screenshot({ path: file }), 'Complete synthesis section #summary');
  await page.locator('nav a[href="#soak"]').click();
  await page.waitForFunction(() => location.hash === '#soak');
  await screenshot('desktop-final.png', file => page.screenshot({ path: file }), 'Desktop viewport after actual #soak anchor navigation');
  const diagnostics = page.locator('section#static');
  assert.equal(await diagnostics.count(), 1, 'Expected one static admission section');
  await screenshot('desktop-static.png', file => diagnostics.screenshot({ path: file }), 'Complete instrumented static admission section #static');

  await page.setViewportSize(mobile);
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot('mobile-390.png', file => page.screenshot({ path: file }), 'Mobile 390 × 844, top of report');
  result.mobileWidths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: innerWidth,
    // Wide inner tables are allowed inside their own scroll containers. The
    // assertion below concerns overflow of the whole mobile document.
    wideElements: [...document.querySelectorAll('body *')].flatMap(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left < -1 || bounds.right > innerWidth + 1
        ? [{ tag: element.tagName, id: element.id, className: String(element.className), left: bounds.left, right: bounds.right, insideTableScroll: Boolean(element.closest('.scroll')) }]
        : [];
    }).slice(0, 20),
  }));
  assert.ok(result.mobileWidths.document <= result.mobileWidths.viewport, 'Global mobile document overflow: ' + JSON.stringify(result.mobileWidths));
  assert.ok(result.mobileWidths.body <= result.mobileWidths.viewport, 'Global mobile body overflow: ' + JSON.stringify(result.mobileWidths));
  assert.deepEqual(result.pageErrors, [], 'Browser page errors');
  assert.deepEqual(result.consoleErrors, [], 'Browser console errors');
  assert.deepEqual(result.failedRequests, [], 'Failed report resource requests');
  result.reportSha256After = hash(await readFile(input));
  assert.equal(result.reportSha256After, result.reportSha256, 'Report changed during rendering');
  for (const image of result.screenshots) {
    assert.equal(hash(await readFile(path.join(output, image.file))), image.sha256, 'Saved PNG differs from captured bytes');
  }
  const active = path.join(root, 'artifacts/performance/report.html');
  result.activeReportSha256 = hash(await readFile(active));
  await page.setViewportSize(desktop);
  await page.goto(pathToFileURL(active).href, { waitUntil: 'load' });
  await page.locator('nav a[href="#soak"]').click();
  await page.waitForFunction(() => location.hash === '#soak');
  result.activeEvidenceUrl = await page.locator('a[href$="soak-http/result.json"]').first().evaluate(a => a.href);
  assert.equal(result.activeEvidenceUrl, pathToFileURL(path.join(base, 'soak-http/result.json')).href);
  await screenshot('active-report-soak.png', file => page.screenshot({ path: file }), 'Active IDE report, actual endurance anchor navigation');
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.failedRequests, []);
  result.complete = true;
} catch (error) {
  result.error = errorRecord(error);
} finally {
  if (browser) {
    try { await browser.close(); }
    catch (error) { result.cleanupError = errorRecord(error); result.complete = false; }
  }
  result.finishedAt = new Date().toISOString();
  await save('result.json', JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ complete: result.complete, result: path.join(output, 'result.json'), reportSha256: result.reportSha256, screenshots: result.screenshots.length }));
if (!result.complete) process.exitCode = 1;
