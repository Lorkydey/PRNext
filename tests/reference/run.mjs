import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { referenceFixture } from './fixture.mjs';
import { startReferenceOidc } from './oidc.mjs';
import { repositoryRoot } from '../support.mjs';

const directory = path.join(repositoryRoot, 'artifacts/alpha019/reference');
const { values } = parseArgs({ options: { 'candidate-archive': { type: 'string' } }, allowPositionals: false });
await mkdir(path.join(directory, 'screenshots'), { recursive: true });
const report = { version: 1, complete: false, checks: [], pageErrors: [], node: process.version, platform: process.platform };
let fixture, oidc, browser, pool;
async function proveTwoWorkers(first, second, { firstNote, secondNote } = {}) {
  const boundary = (await pool.query('SELECT clock_timestamp()::text AS started')).rows[0].started;
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const own = index % 2 === 0, context = own ? first : second;
    const response = await context.request.get(fixture.origin + '/en/dashboard', { maxRedirects: 0 });
    assert.equal(response.status(), 200);
    const html = await response.text();
    if (firstNote) assert.equal(html.includes(firstNote), own);
    if (secondNote) assert.equal(html.includes(secondNote), !own);
  }));
  const activity = await pool.query("SELECT DISTINCT application_name FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'prnext-saas-reference:%' AND query_start >= $1::timestamptz", [boundary]);
  const pids = new Set(activity.rows.map(row => /^prnext-saas-reference:(\d+):\d+$/.exec(row.application_name)?.[1]).filter(Boolean));
  assert.ok(pids.size >= 2, 'Concurrent authenticated requests must use at least two distinct application worker processes.');
  return pids.size;
}

async function waitForDatabaseClientsToClose() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await pool.query("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'prnext-saas-reference:%'");
    if (result.rows[0].count === '0') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Stopped reference workers still have database connections.');
}
try {
  oidc = await startReferenceOidc();
  console.log('Installing exact candidate archives in an independent consumer.');
  fixture = await referenceFixture({ oidc, candidateArchive: values['candidate-archive'], onProgress: message => console.log(message) });
  report.installation = fixture.evidence;
  await fixture.build();
  await fixture.start({ workers: 2 });
  pool = await fixture.pool();
  assert.equal((await pool.query('SHOW fsync')).rows[0].fsync, 'on');
  report.checks.push('PostgreSQL runtime fsync remains enabled');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const watch = target => target.on('pageerror', error => { report.pageErrors.push(error.name); });
  watch(page);
  const first = await page.goto(fixture.origin, { waitUntil: 'load' });
  await expect(page).toHaveURL(fixture.origin + '/fr');
  assert.match(first.headers().link || '', /hreflang="fr"/);
  assert.match(first.headers().link || '', /hreflang="en"/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  report.checks.push('locale negotiation and alternate links');
  await page.goto(fixture.origin + '/fr/sign-up');
  await page.getByLabel('Nom', { exact: true }).fill('Reference Alice');
  await page.getByLabel('E-mail', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Reference-password-12345');
  await page.getByRole('button', { name: 'Créer un compte', exact: true }).click();
  await expect(page).toHaveURL(fixture.origin + '/fr/dashboard');
  await expect(page.getByTestId('account')).toContainText('alice@example.test');
  await page.getByLabel('Note', { exact: true }).fill('ALICE_PRIVATE_NOTE');
  await page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click();
  await expect(page.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  report.checks.push('registration, nextCookies and authenticated Server Action');

  // Test renewal without sleeping a day, against the isolated test schema only.
  const old = new Date(Date.now() - 172800000), expiry = new Date(Date.now() + 259200000);
  await pool.query('UPDATE "session" SET "updatedAt"=$1,"expiresAt"=$2 WHERE "userId"=(SELECT id FROM "user" WHERE email=$3)', [old, expiry, 'alice@example.test']);
  const session = await context.request.get(fixture.origin + '/api/auth/get-session');
  assert.equal(session.status(), 200);
  const refreshed = await pool.query('SELECT "updatedAt","expiresAt" FROM "session" WHERE "userId"=(SELECT id FROM "user" WHERE email=$1)', ['alice@example.test']);
  assert.ok(new Date(refreshed.rows[0].updatedAt) > old);
  assert.ok(new Date(refreshed.rows[0].expiresAt) > expiry);
  report.checks.push('database-backed session renewal');

  const second = await browser.newContext({ locale: 'en-US' }), secondPage = await second.newPage();
  watch(secondPage);
  await secondPage.goto(fixture.origin + '/en/sign-in');
  await secondPage.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await secondPage.getByLabel('Password', { exact: true }).fill('Reference-password-12345');
  await secondPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(secondPage).toHaveURL(fixture.origin + '/en/dashboard');
  await expect(secondPage.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Déconnecter les autres sessions', exact: true }).click();
  await expect(page.getByText('Les autres sessions ont été déconnectées.', { exact: true })).toBeVisible();
  const denied = await second.request.get(fixture.origin + '/en/dashboard', { maxRedirects: 0 });
  assert.equal(denied.status(), 307);
  await secondPage.goto(fixture.origin + '/en/dashboard');
  await expect(secondPage).toHaveURL(fixture.origin + '/en/sign-in');
  report.checks.push('remote session revocation and protected routing');

  const bob = await browser.newContext({ locale: 'en-US' }), bobPage = await bob.newPage();
  watch(bobPage);
  await bobPage.goto(fixture.origin + '/en/sign-up');
  await bobPage.getByLabel('Name', { exact: true }).fill('Reference Bob');
  await bobPage.getByLabel('Email', { exact: true }).fill('bob@example.test');
  await bobPage.getByLabel('Password', { exact: true }).fill('Reference-password-67890');
  await bobPage.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(bobPage).toHaveURL(fixture.origin + '/en/dashboard');
  await expect(bobPage.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toHaveCount(0);
  await bobPage.getByLabel('Note', { exact: true }).fill('BOB_PRIVATE_NOTE');
  await bobPage.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(bobPage.getByText('BOB_PRIVATE_NOTE', { exact: true })).toBeVisible();
  report.normalWorkerProcessesObserved = await proveTwoWorkers(context, bob, { firstNote: 'ALICE_PRIVATE_NOTE', secondNote: 'BOB_PRIVATE_NOTE' });
  report.checks.push('concurrent private dashboards on two distinct application worker processes');
  const aliceNote = await pool.query('SELECT id FROM prnext_reference_notes WHERE body=$1', ['ALICE_PRIVATE_NOTE']);
  await bobPage.locator('input[name="id"]').first().evaluate((node, value) => { node.value = value; }, aliceNote.rows[0].id);
  const deleteResponse = bobPage.waitForResponse(response => response.request().method() === 'POST' && response.request().headers()['next-action'] && new URL(response.url()).pathname === '/en/dashboard');
  await bobPage.getByRole('button', { name: 'Delete note', exact: true }).click();
  const rejectedDelete = await deleteResponse;
  await rejectedDelete.finished();
  assert.equal(rejectedDelete.status(), 200);
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE id=$1', [aliceNote.rows[0].id])).rows[0].count, '1');
  // A no-op delete would also reject the tampered ID. Prove the legitimate
  // owner can delete their own note after that action has completed.
  await bobPage.reload();
  const ownDeleteResponse = bobPage.waitForResponse(response => response.request().method() === 'POST' && response.request().headers()['next-action'] && new URL(response.url()).pathname === '/en/dashboard');
  await bobPage.getByRole('button', { name: 'Delete note', exact: true }).click();
  const ownDelete = await ownDeleteResponse;
  await ownDelete.finished();
  assert.equal(ownDelete.status(), 200);
  await expect(bobPage.getByText('BOB_PRIVATE_NOTE', { exact: true })).toHaveCount(0);
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE body=$1', ['BOB_PRIVATE_NOTE'])).rows[0].count, '0');
  await page.reload();
  await expect(page.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  await expect(page.getByText('BOB_PRIVATE_NOTE', { exact: true })).toHaveCount(0);
  report.checks.push('PostgreSQL ownership isolation, completed tampered delete rejection and owner delete');

  await page.getByRole('link', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(fixture.origin + '/en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByTestId('account')).toContainText('alice@example.test');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'screenshots', 'dashboard-' + width + '.png') });
  }
  report.checks.push('localized client navigation, responsive forms and account continuity');
  await context.close(); await second.close(); await bob.close();

  const oauthContext = await browser.newContext(), oauthPage = await oauthContext.newPage();
  watch(oauthPage);
  oidc.setUser('oidc-user', 'oidc@example.test');
  await oauthPage.goto(fixture.origin + '/en/sign-in');
  await oauthPage.getByRole('button', { name: 'Continue with OpenID Connect', exact: true }).click();
  await expect(oauthPage).toHaveURL(fixture.origin + '/en/dashboard', { timeout: 20000 });
  await expect(oauthPage.getByTestId('account')).toContainText('oidc@example.test');
  await oauthPage.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(oauthPage).toHaveURL(fixture.origin + '/en/sign-in');
  assert.equal((await oauthContext.request.get(fixture.origin + '/en/dashboard', { maxRedirects: 0 })).status(), 307);
  const loggedOut = await oauthContext.request.get(fixture.origin + '/api/auth/get-session');
  assert.equal(loggedOut.status(), 200);
  assert.equal(await loggedOut.json(), null);
  await oauthContext.close();
  report.checks.push('OpenID Connect discovery, PKCE, signed ID token, callback and logout');

  await fixture.stop();
  await waitForDatabaseClientsToClose();
  await fixture.start({ standalone: true, removeSource: true, workers: 2 });
  const portable = await browser.newContext(), portablePage = await portable.newPage();
  watch(portablePage);
  await portablePage.goto(fixture.origin + '/en/sign-in');
  await portablePage.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await portablePage.getByLabel('Password', { exact: true }).fill('Reference-password-12345');
  await portablePage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(portablePage).toHaveURL(fixture.origin + '/en/dashboard');
  await expect(portablePage.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  await portablePage.getByLabel('Note', { exact: true }).fill('STANDALONE_PERSISTED_NOTE');
  await portablePage.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(portablePage.getByText('STANDALONE_PERSISTED_NOTE', { exact: true })).toBeVisible();
  const portableBob = await browser.newContext(), portableBobPage = await portableBob.newPage();
  watch(portableBobPage);
  await portableBobPage.goto(fixture.origin + '/en/sign-in');
  await portableBobPage.getByLabel('Email', { exact: true }).fill('bob@example.test');
  await portableBobPage.getByLabel('Password', { exact: true }).fill('Reference-password-67890');
  await portableBobPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(portableBobPage).toHaveURL(fixture.origin + '/en/dashboard');
  report.standaloneWorkerProcessesObserved = await proveTwoWorkers(portable, portableBob, { firstNote: 'STANDALONE_PERSISTED_NOTE' });
  await portableBob.close();
  await portable.close();
  report.checks.push('relocated standalone without original sources or node_modules, two workers');
  assert.deepEqual(report.pageErrors, []);
  report.complete = true;
  console.log('Reference qualification passed: ' + report.checks.length + ' complete workflows.');
} finally {
  await pool?.end();
  await browser?.close();
  await fixture?.close();
  await oidc?.close();
  await writeFile(path.join(directory, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
}
