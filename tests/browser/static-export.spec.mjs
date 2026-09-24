import { test, expect } from '@playwright/test';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { staticExportFixture, serveStatic } from '../static-export-fixture.mjs';

test('exported App hydrates and navigates Flight on an ordinary static host', async ({ page }) => {
  const f = await staticExportFixture(); let server;
  const errors = [], documents = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  try {
    await f.build();
    for (const name of ['app', 'pages', '.rustyx', 'node_modules']) await rm(path.join(f.root, name), { recursive: true, force: true });
    server = await serveStatic(path.join(f.root, 'out'));
    await page.goto(server.url);
    await page.getByRole('button', { name: 'counter 0' }).click();
    await page.getByRole('link', { name: 'Post one' }).click();
    await expect(page.getByRole('heading', { name: 'Post one' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'counter 1' })).toBeVisible();
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { name: 'Export home' })).toBeVisible();
    expect(documents).toHaveLength(1); expect(errors).toEqual([]);
  } finally { await server?.close(); await f.remove(); }
});
