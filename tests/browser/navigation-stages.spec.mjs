import { test, expect } from '@playwright/test';
import { navigationStagesFixture } from '../navigation-stages-fixture.mjs';
import { startServer } from '../support.mjs';

test('explicit Link prefetch prepares reusable UI without running navigation-only work', async ({ page }) => {
  const fixture = await navigationStagesFixture(); let server;
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await fixture.build(); server = await startServer(fixture.root); fixture.reset();
    await page.goto(server.url); await page.waitForFunction(() => window.__stagesRouter);
    await expect.poll(() => fixture.counts.get('prefetch') || 0).toBe(1);
    expect(fixture.counts.get('navigation') || 0).toBe(0);
    await page.getByRole('link', { name: 'Open stages' }).click();
    await expect(page.getByTestId('prefetch')).toHaveText('prefetch:public');
    await expect(page.getByTestId('navigation')).toHaveText('navigation:public');
    expect(errors).toEqual([]);
  } finally { await server?.close(); await fixture.remove(); }
});
