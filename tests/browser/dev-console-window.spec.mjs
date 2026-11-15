import { test, expect } from '@playwright/test';
import { devFixture, counterSource } from '../dev-fixture.mjs';

test.describe('embedded console window', () => {
  test.setTimeout(90000);
  let fixture;
  test.afterEach(async () => { await fixture?.close(); fixture = undefined; });
  async function open(page) {
    fixture = await devFixture(); await page.goto(fixture.url + '/docs/app');
    const host = page.locator('prnext-dev-tools');
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await host.getByRole('button', { name: 'Client console', exact: true }).click();
    const panel = host.getByRole('dialog', { name: 'Client console', exact: true });
    await expect(panel).toHaveAttribute('data-window-controls', 'true');
    // Finish the existing entrance animation before measuring its geometry.
    await panel.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    return { host, panel, heading: panel.locator('.wb-head') };
  }
  async function drag(page, target, dx, dy, position) {
    const box = await target.boundingBox(), x = box.x + (position?.x ?? box.width / 2), y = box.y + (position?.y ?? box.height / 2);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
  }
  const appearance = panel => panel.evaluate(node => {
    const style = getComputedStyle(node); return [style.backgroundColor, style.borderColor, style.borderRadius, style.boxShadow, style.fontFamily];
  });

  test('title dragging and all eight resize edges retain the console appearance and controls', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { panel, heading } = await open(page), style = await appearance(panel), initial = await panel.boundingBox();
    await page.evaluate(() => console.info('window-keeps-recording'));
    await drag(page, heading, 90, -120, { x: 150, y: 24 });
    let before = await panel.boundingBox(); expect(before.x).toBeCloseTo(initial.x + 90, 0); expect(before.y).toBeCloseTo(initial.y - 120, 0);
    for (const [edge, dx, dy] of [['e',64,0],['s',0,50],['w',20,0],['n',0,20],['ne',40,-20],['se',40,30],['sw',-30,20],['nw',-20,-20]]) {
      await drag(page, panel.locator(`[data-edge=${edge}]`), dx, dy);
      const after = await panel.boundingBox();
      expect(after.x).toBeCloseTo(before.x + (edge.includes('w') ? dx : 0), 0);
      expect(after.y).toBeCloseTo(before.y + (edge.includes('n') ? dy : 0), 0);
      expect(after.width).toBeCloseTo(before.width + (edge.includes('e') ? dx : edge.includes('w') ? -dx : 0), 0);
      expect(after.height).toBeCloseTo(before.height + (edge.includes('s') ? dy : edge.includes('n') ? -dy : 0), 0);
      before = after;
    }
    expect(await appearance(panel)).toEqual(style);
    await expect(panel.getByRole('region', { name: 'Console messages' })).toContainText('window-keeps-recording');
    await panel.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await panel.boundingBox()).toEqual(before);
    await panel.getByRole('searchbox').fill('window-keeps-recording');
    await expect(panel.getByRole('region', { name: 'Console messages' })).toContainText('window-keeps-recording');
    await fixture.write('components/Counter.jsx', counterSource('Window refreshed'));
    await expect(page.getByTestId('counter')).toHaveText('Window refreshed 0', { timeout: 25000 });
    expect(await panel.boundingBox()).toEqual(before);
  });

  test('keyboard, reopening, viewport changes and preview docking retain usable geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { host, panel, heading } = await open(page), initial = await panel.boundingBox();
    await heading.focus(); await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+Shift+ArrowRight'); await page.keyboard.press('Alt+Shift+ArrowDown');
    const moved = await panel.boundingBox(); expect(moved.x).toBeCloseTo(initial.x + 10, 0); expect(moved.y).toBeCloseTo(initial.y - 10, 0);
    expect(moved.width).toBeCloseTo(initial.width + 10, 0); expect(moved.height).toBeCloseTo(initial.height + 10, 0);
    await panel.getByRole('button', { name: 'Close console', exact: true }).click();
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await host.getByRole('button', { name: 'Client console', exact: true }).click(); await expect.poll(() => panel.boundingBox()).toEqual(moved);
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await host.locator('#tools').getByRole('button', { name: 'Phone', exact: true }).click();
    const preview = host.getByRole('dialog', { name: 'Device preview', exact: true });
    await expect(panel).not.toHaveAttribute('data-window-controls', 'true');
    expect(await panel.evaluate(node => node.style.cssText)).toBe('');
    await preview.getByRole('button', { name: 'Close device preview', exact: true }).click();
    await expect(panel).toHaveAttribute('data-window-controls', 'true'); await expect.poll(() => panel.boundingBox()).toEqual(moved);
    await page.setViewportSize({ width: 320, height: 400 });
    await expect.poll(async () => { const box = await panel.boundingBox(); return box.x >= 8 && box.y >= 8 && box.x + box.width <= 312 && box.y + box.height <= 392; }).toBe(true);
    await expect(panel.getByRole('button', { name: 'Close console', exact: true })).toBeInViewport();
    await expect(panel.getByRole('region', { name: 'Console messages' })).toBeInViewport();
    await panel.getByRole('searchbox').focus(); await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
  });

  test('Escape cancels a drag and pointer capture loss restores the preceding window', async ({ page }) => {
    const { panel, heading } = await open(page), initial = await panel.boundingBox(), box = await heading.boundingBox();
    await heading.focus(); await page.mouse.move(box.x + 150, box.y + 24); await page.mouse.down(); await page.mouse.move(box.x + 220, box.y - 50);
    await expect(panel).toHaveAttribute('data-window-gesture', 'move'); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(panel).toBeVisible(); expect(await panel.boundingBox()).toEqual(initial);
    await drag(page, heading, 40, -40, { x: 150, y: 24 }); const moved = await panel.boundingBox();
    const corner = panel.locator('[data-edge=se]'), cornerBox = await corner.boundingBox();
    await page.mouse.move(cornerBox.x + 5, cornerBox.y + 5); await page.mouse.down(); await page.mouse.move(cornerBox.x + 45, cornerBox.y + 45);
    await corner.evaluate(node => { for (let pointer = 1; pointer < 5; pointer++) if (node.hasPointerCapture(pointer)) node.releasePointerCapture(pointer); });
    await page.mouse.up(); expect(await panel.boundingBox()).toEqual(moved);
    await heading.focus(); await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
  });

  test('touch can move the console without scrolling and detached windows retain native sizing', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage(), { panel, heading } = await open(page), before = await panel.boundingBox(), box = await heading.boundingBox();
      const client = await context.newCDPSession(page), x = box.x + 130, y = box.y + 24;
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 4, y: y - 70, id: 1 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      let after = await panel.boundingBox(); expect(after.y).toBeCloseTo(before.y - 70, 0); expect(after.x).toBeCloseTo(before.x, 0);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      const corner = await panel.locator('[data-edge=se]').boundingBox(), cornerX = corner.x + 5, cornerY = corner.y + 5;
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cornerX, y: cornerY, id: 2 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cornerX - 20, y: cornerY + 20, id: 2 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const resized = await panel.boundingBox(); expect(resized.width).toBeCloseTo(after.width - 20, 0); expect(resized.height).toBeCloseTo(after.height + 20, 0); after = resized;
      const popupReady = page.waitForEvent('popup'); await panel.getByRole('button', { name: 'Open console in new window', exact: true }).click();
      const popup = await popupReady, detached = popup.locator('prnext-dev-window').getByRole('dialog', { name: 'Client console', exact: true });
      await expect(detached).toBeVisible(); await expect(detached).not.toHaveAttribute('data-window-controls', 'true');
      expect(await detached.evaluate(node => node.style.cssText)).toBe('');
      await detached.getByRole('button', { name: 'Dock console', exact: true }).click();
      await expect(panel).toBeVisible(); await expect.poll(() => panel.boundingBox()).toEqual(after);
    } finally { await context.close(); }
  });
});
