import { defineConfig } from '@playwright/test';

const engines = ['chromium', 'firefox', 'webkit'];
if (process.env.PRNEXT_BROWSER && !engines.includes(process.env.PRNEXT_BROWSER)) throw new Error('PRNEXT_BROWSER must be chromium, firefox or webkit.');
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['cross-engine.spec.mjs', 'lazy-dynamic-imports.spec.mjs', 'app-dev-action-refresh.spec.mjs'],
  outputDir: './artifacts/alpha019-cross-engine-results',
  workers: 1,
  timeout: 90000,
  retries: 0,
  projects: engines.filter(engine => !process.env.PRNEXT_BROWSER || process.env.PRNEXT_BROWSER === engine)
    .map(engine => ({ name: engine, use: { browserName: engine } })),
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
