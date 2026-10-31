// Positive prefetch scenarios need a stable policy while Chromium's native
// connection estimates change during requests. Policy tests supply their own
// connection instead, so data saver/offline/slow-network behavior stays covered.
export async function setupPrefetchNetwork(page) {
  await page.addInitScript(() => {
    const connection = new EventTarget();
    Object.assign(connection, { saveData: false, effectiveType: '4g', downlink: 10 });
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
  await page.bringToFront();
}
