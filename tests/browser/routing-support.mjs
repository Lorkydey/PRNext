import { expect } from '@playwright/test';

// The load event can precede the dynamic imports used for hydration. Tests of
// soft navigation need hydrated handlers, not just a visible server-rendered link.
export async function openRoutingPage(page, url, { delayHydration = false } = {}) {
  const control = page.getByRole('button', { name: 'refresh route', exact: true });
  if (!delayHydration) {
    await page.goto(url);
    await expect(control).toBeEnabled();
    return;
  }

  let release, heldScripts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pattern = '**/_prnext/assets/**';
  const hold = async route => {
    if (route.request().resourceType() === 'script') { heldScripts++; await gate; }
    await route.continue();
  };
  await page.route(pattern, hold);
  try {
    await page.goto(url, { waitUntil: 'commit' });
    await expect.poll(() => heldScripts).toBeGreaterThan(0);
    await expect(control).toBeDisabled();
    release();
    await expect(control).toBeEnabled();
  } finally {
    release();
    await page.unroute(pattern, hold);
  }
}
