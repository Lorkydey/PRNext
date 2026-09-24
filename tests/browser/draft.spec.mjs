import { test, expect } from '@playwright/test';
import { draftFixture } from '../draft-fixture.mjs';
import { startServer } from '../support.mjs';

let fixture, server;
test.beforeAll(async () => { fixture = await draftFixture(); await fixture.build(); server = await startServer(fixture.root); });
test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

for (const [route, label] of [['/content', 'App'], ['/page', 'Pages']]) test(`${label} draft sessions hydrate and can be cleared without leaking into public visits`, async ({ page, browser }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/docs' + route);
  await expect(page.getByRole('heading')).toHaveText(`${label} draft:false`);
  await page.request.get(server.url + '/docs/toggle');
  await page.reload();
  await expect(page.getByRole('heading')).toHaveText(`${label} draft:true`);
  if (label === 'Pages') await expect(page.locator('#router-preview')).toHaveText('true');
  const independent = await browser.newPage();
  try { await independent.goto(server.url + '/docs' + route); await expect(independent.getByRole('heading')).toHaveText(`${label} draft:false`); }
  finally { await independent.close(); }
  await page.request.get(server.url + '/docs/toggle?enable=0');
  await page.reload();
  await expect(page.getByRole('heading')).toHaveText(`${label} draft:false`);
  expect(errors).toEqual([]);
});
test('Server Actions update Draft Mode and rerender with the new cookie state', async ({ page }) => {
  await page.goto(server.url + '/docs/edit');
  await expect(page.getByRole('heading')).toHaveText('Editor draft:false');
  await page.getByRole('button', { name: 'Toggle draft' }).click();
  await expect(page.getByRole('heading')).toHaveText('Editor draft:true');
  await page.reload();
  await expect(page.getByRole('heading')).toHaveText('Editor draft:true');
  await page.getByRole('button', { name: 'Toggle draft' }).click();
  await expect(page.getByRole('heading')).toHaveText('Editor draft:false');
});
