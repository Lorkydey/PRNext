import { defineConfig } from '@playwright/test';

const port = process.env.PRNEXT_BROWSER_PORT || '3198';
if (!/^[1-9]\d{3,4}$/.test(port) || Number(port) > 65535 || Number(port) < 1024) throw new Error('Invalid PRNEXT_BROWSER_PORT');
const origin = 'http://127.0.0.1:' + port;

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  // Includes fixture shutdown's existing 30-second drain and process cleanup.
  timeout: 60000,
  use: { baseURL: origin, browserName: 'chromium' },
  webServer: {
    command: 'node packages/prnext/cli.mjs build examples/basic && node packages/prnext/cli.mjs start examples/basic --port ' + port,
    url: origin,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
