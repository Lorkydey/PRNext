import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3198', browserName: 'chromium' },
  webServer: {
    command: 'node packages/rustyx/cli.mjs build examples/basic && node packages/rustyx/cli.mjs start examples/basic --port 3198',
    url: 'http://127.0.0.1:3198',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
