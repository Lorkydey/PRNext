import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'artifacts/performance-v4/report-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = []; page.on('pageerror', error => errors.push(String(error)));
const files = [];
try {
  await page.goto(pathToFileURL(path.join(root, 'artifacts/performance/report.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, 'desktop.png') }); files.push('desktop.png');
  for (const [title, file] of [['Débit, CPU, RAM et latences — mesures finales', 'comparison.png'], ['Endurance mixte et ressources', 'endurance.png'], ['Repos réel : 1, 5 et 15 minutes, trois cycles', 'idle.png'], ['Profilage ETW séparé : CPU, fichiers et réseau', 'etw.png']]) {
    await page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).screenshot({ path: path.join(output, file) }); files.push(file);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'mobile.png') }); files.push('mobile.png');
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(widths.document <= widths.viewport, JSON.stringify(widths));
  assert.deepEqual(errors, []);
  const reportSha256 = createHash('sha256').update(await readFile(path.join(root, 'artifacts/performance/report.html'))).digest('hex');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ complete: true, reportSha256, screenshots: files, mobileWidths: widths, pageErrors: errors }, null, 2));
} finally { await browser.close(); }
console.log('Report rendered at desktop/mobile sizes; screenshots saved');
