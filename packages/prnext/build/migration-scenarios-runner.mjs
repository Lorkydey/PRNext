import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let browser, browserServer, activeContext, closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await activeContext?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => {});
  if (process.connected) process.send({ type: 'browser-closed' });
}
process.on('disconnect', () => { void close().finally(() => process.exit(1)); });
process.on('SIGTERM', () => { void close().finally(() => process.exit(1)); });
process.on('message', async message => {
  if (message?.type === 'close') { await close(); process.exit(0); }
  if (message?.type !== 'run') return;
  const results = [];
  let report;
  const unknown = reason => ({ ok: false, state: 'unknown', reason, results });
  try {
    const require = createRequire(path.join(message.root, 'package.json'));
    let playwright;
    for (const name of ['playwright', '@playwright/test']) {
      try { playwright = await import(pathToFileURL(require.resolve(name)).href); break; } catch {}
    }
    if (!playwright?.chromium && !playwright?.default?.chromium) { report = unknown('playwright-unavailable'); return; }
    let scenarios, importTimer, expiredImport = false;
    try { scenarios = (await Promise.race([
      import(pathToFileURL(message.filename).href),
      new Promise((_, reject) => { importTimer = setTimeout(() => { expiredImport = true; reject(new Error('timeout')); }, Math.min(10000, Math.max(1000, message.timeout))); }),
    ])).default; }
    catch { report = unknown(expiredImport ? 'scenario-module-timeout' : 'scenario-module-failed'); return; }
    finally { clearTimeout(importTimer); }
    if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length > 20 || scenarios.some(item => !item || typeof item.run !== 'function')) { report = unknown('invalid-scenarios'); return; }
    try {
      const chromium = playwright.chromium || playwright.default.chromium;
      browserServer = await chromium.launchServer({ headless: true, timeout: 10000 });
      // The parent can stop the specifically owned browser even when a trusted
      // callback blocks this worker's event loop with synchronous JavaScript.
      if (process.connected) process.send({ type: 'browser-started', pid: browserServer.process().pid });
      browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
    }
    catch { report = unknown('browser-unavailable'); return; }
    for (let index = 0; index < scenarios.length; index++) {
      for (const target of ['reference', 'candidate']) {
        let timer, expired = false;
        try {
          activeContext = await browser.newContext({ serviceWorkers: 'block' });
          const page = await activeContext.newPage();
          page.setDefaultTimeout(message.timeout);
          page.setDefaultNavigationTimeout(message.timeout);
          await Promise.race([
            Promise.resolve().then(() => scenarios[index].run({ page, baseURL: target === 'reference' ? message.reference : message.candidate })),
            new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('timeout')); }, message.timeout); }),
          ]);
          results.push({ scenario: index + 1, target, status: 'passed' });
        } catch { results.push({ scenario: index + 1, target, status: 'failed', reason: expired ? 'timeout' : 'assertion-or-runtime-failure' }); }
        finally { clearTimeout(timer); await activeContext?.close().catch(() => {}); activeContext = undefined; }
        // An expired callback may continue running its own JavaScript. Stop this
        // worker after closing its browser instead of starting another target.
        if (expired) { report = unknown('worker-failed'); return; }
      }
    }
    report = { ok: results.every(item => item.status === 'passed'), state: 'checked', results };
  } catch { report = unknown('worker-failed'); }
  finally {
    await close();
    if (process.connected) process.send({ type: 'result', report: report || unknown('worker-failed') });
    else process.exit(1);
  }
});
