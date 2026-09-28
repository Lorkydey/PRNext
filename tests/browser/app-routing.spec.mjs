import { test, expect } from '@playwright/test';
import { routingFixture } from '../app-routing-fixture.mjs';
import { startServer } from '../support.mjs';

test.describe('Parallel and intercepting App routes', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await routingFixture(); await fixture.build(); server = await startServer(fixture.root); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  test('hard navigation resolves slots and default pages independently', async ({ page }) => {
    const response = await page.goto(`${server.url}/docs/dashboard/settings`);
    expect(response.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Settings main' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Team settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Default analytics' })).toBeVisible();
    await expect(page.getByTestId('dashboard-segments')).toContainText('"one":"settings"');
    await expect(page.getByTestId('team-segments')).toContainText('"all":["settings"]');
  });

  test('soft navigation preserves unmatched slot state and its original server tree', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard`);
    await page.getByRole('button', { name: 'analytics count 0' }).click();
    await page.getByRole('button', { name: 'team count 0' }).click();
    await page.getByRole('button', { name: 'dashboard count 0' }).click();
    const requests = fixture.counts.get('analytics');
    await page.getByRole('link', { name: 'settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Team settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'analytics count 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'team count 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'dashboard count 1' })).toBeVisible();
    expect(fixture.counts.get('analytics')).toBe(requests);
  });

  test('parallel metadata includes parent inheritance and retained unmatched slots', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard`);
    await expect(page).toHaveTitle('Analytics title');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Primary dashboard');
    await expect(page.locator('meta[name="primary-metadata"]')).toHaveAttribute('content', 'present');
    await expect(page.locator('meta[name="team-metadata"]')).toHaveAttribute('content', 'present');
    await expect(page.locator('meta[name="team-parent"]')).toHaveAttribute('content', 'Analytics title');
    const count = fixture.counts.get('analytics');
    await page.getByRole('link', { name: 'settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Team settings' })).toBeVisible();
    await expect(page).toHaveTitle('Team settings');
    await expect(page.locator('meta[name="analytics-metadata"]')).toHaveAttribute('content', 'retained');
    expect(fixture.counts.get('analytics')).toBe(count);
    await page.reload();
    await expect(page).toHaveTitle('Team settings');
    await expect(page.locator('meta[name="analytics-metadata"]')).toHaveCount(0);
  });

  for (const source of ['transform', 'transform-alias']) test(`restored ${source} receives isolated middleware headers, cookies and metadata`, async ({ page, context }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs/${source}`);
    await expect(page.getByTestId('source-context')).toHaveText('branch-user:none:source');
    await context.clearCookies();
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('destination-context')).toHaveText('destination-user:current:none');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Metadata branch-user');
    await context.clearCookies();
    const refreshed = page.waitForResponse(response => response.request().headers()['x-prnext-router-state']?.includes('refresh'));
    await page.getByRole('button', { name: 'refresh route', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByTestId('source-context')).toHaveText('branch-user:none:source');
    await expect(page.getByTestId('destination-context')).toHaveText('destination-user:current:none');
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(documents).toHaveLength(1);
    expect((await context.cookies()).some(cookie => cookie.name === 'branch' && cookie.value === 'source')).toBe(true);
  });

  test('an interception inside an intercepted layout keeps both backgrounds and reloads canonical', async ({ page }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs/cascade`);
    await page.getByRole('button', { name: 'cascade count 0' }).click();
    await page.getByRole('link', { name: 'open item' }).click();
    await expect(page.getByRole('heading', { name: 'Item modal one' })).toBeVisible();
    await page.getByRole('button', { name: 'item count 0' }).click();
    await page.getByRole('link', { name: 'open zoom' }).click();
    await expect(page.getByRole('heading', { name: 'Zoom one:two' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'cascade count 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'item count 1' })).toBeVisible();
    const refreshed = page.waitForResponse(response => response.request().headers()['x-prnext-router-state']?.includes('refresh'));
    await page.getByRole('button', { name: 'refresh route', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Zoom one:two' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'item count 1' })).toBeVisible();
    await page.getByRole('button', { name: 'close modal' }).click();
    await expect(page.getByTestId('inner-modal')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Item modal one' })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'Zoom one:two' })).toBeVisible();
    expect(documents).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Canonical zoom one:two' })).toBeVisible();
    await expect(page.getByTestId('outer-modal')).toHaveCount(0);
  });

  test('a slot-only URL retains children during soft navigation and uses default on reload', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard`);
    await page.getByRole('button', { name: 'main count 0' }).click();
    await page.getByRole('link', { name: 'team only', exact: true }).click();
    await expect(page).toHaveURL(`${server.url}/docs/dashboard/team`);
    await expect(page.getByRole('heading', { name: 'Team only' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'main count 1' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Default main' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Default analytics' })).toBeVisible();
  });

  test('history restores retained slot content after its layout has unmounted', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard`);
    const requests = fixture.counts.get('analytics');
    await page.getByRole('link', { name: 'settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Analytics home', exact: false })).toBeVisible();
    await page.getByRole('link', { name: 'feed', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Feed', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Settings main' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Analytics home', exact: false })).toBeVisible();
    expect(fixture.counts.get('analytics')).toBe(requests);
  });

  test('refresh and Server Actions re-render unmatched slots while retaining mounted client state', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard`);
    await page.getByRole('button', { name: 'analytics count 0' }).click();
    await page.getByRole('button', { name: 'dashboard count 0' }).click();
    await page.getByRole('link', { name: 'settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings main' })).toBeVisible();
    for (const button of ['refresh route', 'mutate route']) {
      const count = fixture.counts.get('analytics');
      await page.getByRole('button', { name: button, exact: true }).click();
      await expect(page.getByRole('heading', { name: `Analytics home ${count + 1}`, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'analytics count 1' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'dashboard count 1' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Settings main' })).toBeVisible();
    }
  });

  test('history evicted from the bounded client cache reconstructs its unmatched slots from saved URLs', async ({ page }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs/dashboard`);
    await page.getByRole('link', { name: 'settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings main' })).toBeVisible();
    const count = fixture.counts.get('analytics');
    for (let step = 1; step <= 18; step++) {
      await page.getByRole('button', { name: 'advance history', exact: true }).click();
      await expect(page).toHaveURL(`${server.url}/docs/dashboard/settings?step=${step}`);
    }
    expect(fixture.counts.get('analytics')).toBe(count);
    await page.getByRole('link', { name: 'feed', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Feed', exact: true })).toBeVisible();
    await page.evaluate(() => window.history.go(-19));
    await expect(page).toHaveURL(`${server.url}/docs/dashboard/settings`);
    await expect(page.getByRole('heading', { name: 'Settings main' })).toBeVisible();
    await expect(page.getByRole('heading', { name: `Analytics home ${count + 1}`, exact: true })).toBeVisible();
    expect(documents).toHaveLength(1);
  });

  test('refresh keeps an intercepted modal and refreshes its background server data', async ({ page }) => {
    await page.goto(`${server.url}/docs`);
    await page.getByRole('button', { name: 'feed count 0' }).click();
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const count = fixture.counts.get('feed');
    await page.getByRole('button', { name: 'refresh route', exact: true }).click();
    await expect(page.getByText(`Feed version ${count + 1}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Modal photo one' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'feed count 1' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Canonical photo one' })).toHaveCount(0);
  });

  for (const mode of ['refresh after cookie removal', 'logout Server Action']) test(`middleware-protected modal backgrounds are checked again on ${mode}`, async ({ page, context }) => {
    await context.addCookies([{ name: 'auth', value: 'yes', url: server.url }]);
    await page.goto(`${server.url}/docs/admin`);
    await expect(page.getByRole('heading', { name: 'Protected admin', exact: false })).toBeVisible();
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const beforeRefresh = fixture.counts.get('admin');
    await page.getByRole('button', { name: 'refresh route', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Protected admin ${beforeRefresh + 1}`, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    const count = fixture.counts.get('admin');
    if (mode === 'refresh after cookie removal') {
      await context.clearCookies();
      await page.getByRole('button', { name: 'refresh route', exact: true }).click();
    } else await page.getByRole('button', { name: 'logout route', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Canonical photo one' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Protected admin', exact: false })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(fixture.counts.get('admin')).toBe(count);
  });

  test('interception opens a modal, preserves background, restores back/forward and reloads canonical page', async ({ page }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs`);
    await page.getByRole('button', { name: 'feed count 0' }).click();
    await page.getByRole('link', { name: 'photo one', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Modal photo one' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'feed count 1' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Canonical photo one' })).toHaveCount(0);
    await page.getByRole('button', { name: 'close modal' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'feed count 1' })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(documents).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Canonical photo one' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('missing slot without default is a hard 404', async ({ page }) => {
    const response = await page.goto(`${server.url}/docs/missing/deeper`);
    expect(response.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Routing missing' })).toBeVisible();
  });

  test('selected layout segments include route groups and a joined catch-all', async ({ page }) => {
    await page.goto(`${server.url}/docs/nested/one/two`);
    await expect(page.getByTestId('root-segments')).toContainText('"all":["(group)","nested","one/two"]');
    await expect(page.getByTestId('root-segments')).toContainText('"slug":["one","two"]');
  });

  test('singular selected segment uses the first children segment and last named-slot segment', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard/settings/deep`);
    await expect(page.getByTestId('dashboard-segments')).toContainText('"one":"settings","all":["settings","deep"]');
    await expect(page.getByTestId('team-segments')).toContainText('"one":"deep","all":["settings","deep"]');
  });

  for (const [source, link, expected, background] of [
    ['album', 'album photo', 'Album modal two', 'Album background'],
    ['album/deep', 'root photo', 'Root modal three', 'Deep background'],
  ]) test(`${source}: interception resolves relative to URL segments and preserves nested layout`, async ({ page }) => {
    await page.goto(`${server.url}/docs/${source}`);
    await page.getByRole('button', { name: 'album count 0' }).click();
    await page.getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveText(expected);
    await expect(page.getByRole('heading', { name: background })).toBeVisible();
    await expect(page.getByRole('button', { name: 'album count 1' })).toBeVisible();
  });

  test('interception without a named slot replaces the leaf within the preserved source layout', async ({ page }) => {
    await page.goto(`${server.url}/docs/standalone`);
    await page.getByRole('button', { name: 'standalone count 0' }).click();
    await page.getByRole('link', { name: 'inline photo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Inline intercepted four' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'standalone count 1' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  for (const delayHydration of [false, true]) test(`repeated parent interception preserves dynamic source params across modal navigations${delayHydration ? ' with delayed hydration' : ''}`, async ({ page }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    if (delayHydration) {
      let release;
      const heldScripts = [];
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/_prnext/assets/**', async route => {
        if (route.request().resourceType() === 'script') { heldScripts.push(route.request().url()); await gate; }
        await route.continue();
      });
      try {
        // Observe the SSR button while client scripts are held, without waiting
        // for the page load event those scripts would otherwise block.
        await page.goto(`${server.url}/docs/users/alice`, { waitUntil: 'commit' });
        await expect.poll(() => heldScripts.length).toBeGreaterThan(0);
        await expect(page.getByRole('button', { name: 'user count 0' })).toBeDisabled();
      } finally { release(); }
    } else await page.goto(`${server.url}/docs/users/alice`);
    await page.getByRole('button', { name: 'user count 0' }).click();
    await expect(page.getByRole('button', { name: 'user count 1' })).toBeVisible();
    await page.getByRole('link', { name: 'user photo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'User modal five' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'user count 1' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'User layout alice' })).toBeVisible();
    await expect(page.getByTestId('user-params')).toContainText('"user":"alice"');
    await page.getByRole('link', { name: 'next user photo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'User modal six' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'user count 1' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'User layout alice' })).toBeVisible();
    await expect(page.getByTestId('user-params')).toContainText('"user":"alice"');
    expect(documents).toHaveLength(1);
  });

  test('a server exception stays inside the parallel slot error boundary', async ({ page }) => {
    await page.goto(`${server.url}/docs/dashboard/fail`);
    await expect(page.getByRole('heading', { name: 'Analytics error private' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Healthy main next to error' })).toBeVisible();
    await expect(page.getByTestId('team')).toContainText('Default team');
    await expect(page.locator('body')).not.toContainText('PRIVATE_ANALYTICS_ERROR');
  });

  test('notFound resolves within the parallel slot and retains its siblings', async ({ page }) => {
    const response = await page.goto(`${server.url}/docs/dashboard/absent`);
    expect(response.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Analytics missing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Healthy main next to missing' })).toBeVisible();
  });
});

test.describe('Independent App root layouts', () => {
  let fixture, server;
  test.beforeAll(async () => { fixture = await routingFixture({ independentRoots: true }); await fixture.build(); server = await startServer(fixture.root); });
  test.afterAll(async () => { await server?.close(); await fixture?.remove(); });

  test('same-root links preserve state while crossing roots loads a new document', async ({ page }) => {
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.goto(`${server.url}/docs/a`);
    await expect(page).toHaveTitle('Page a');
    await page.getByRole('button', { name: 'root a count 0' }).click();
    await page.getByRole('link', { name: 'same root' }).click();
    await expect(page.getByRole('heading', { name: 'Page a/next' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'root a count 1' })).toBeVisible();
    expect(documents).toHaveLength(1);
    await page.getByRole('link', { name: 'other root' }).click();
    await expect(page.getByRole('heading', { name: 'Root b' })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-root', 'b');
    await expect(page).toHaveTitle('Page b');
    expect(documents).toHaveLength(2);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Root a' })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-root', 'a');
  });
});
