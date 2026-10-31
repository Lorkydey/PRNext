import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../scripts/main-module.mjs';
import { referenceFixture } from './fixture.mjs';
import { startReferenceOidc } from './oidc.mjs';
import { assertSuccessfulActionBody } from './action-response.mjs';
import { repositoryRoot } from '../support.mjs';
import { createActionNetworkRecorder } from './action-network.mjs';
import { referenceDeadline, acquireReferenceResource, closeReferenceResources } from './lifecycle.mjs';
import { referenceBrowserOptions, captureReferenceAction, qualifyAuthenticationBudgets, qualifySecureOrigin, qualifyCsrf, qualifyRevokedMutation, qualifyOidcRejections, qualifyOidcSuccess } from './security-scenarios.mjs';

export async function qualifyReference({ candidateArchive, preparedRoot, skipBuild = false, preserveInstallation = false, outputDirectory, argv = process.argv.slice(2) } = {}) {
const { values } = parseArgs({ args: argv, options: { 'candidate-archive': { type: 'string' }, 'output-directory': { type: 'string' } }, allowPositionals: false });
const directory = path.resolve(outputDirectory || values['output-directory'] || path.join(repositoryRoot, 'artifacts/alpha019/reference'));
await mkdir(path.join(directory, 'screenshots'), { recursive: true });
const report = { version: 2, complete: false, checks: [], pageErrors: [], node: process.version, platform: process.platform, transport: 'owned loopback HTTPS proxy with overwritten forwarding headers' };
report.qualificationMode = preparedRoot || skipBuild || preserveInstallation ? 'diagnostic' : 'clean';
let fixture, oidc, browser, browserServer, pool, scenarioTimer, primaryError, expired = false, closing = false, persistenceFailed = false;
const persist = async () => {
  if (persistenceFailed) throw new Error('Reference report persistence previously failed.');
  try {
    await referenceDeadline(writeFile(path.join(directory, 'qualification.json'), JSON.stringify(report, null, 2) + '\n'), 'Reference report persistence exceeded its deadline.', 5000);
  } catch (error) { persistenceFailed = true; throw error; }
};
const acquire = (factory, dispose) => acquireReferenceResource(factory, { isClosed: () => expired || closing, dispose });
const checked = message => { if (expired) throw new Error('Reference workflow deadline exceeded.'); report.checks.push(message); console.log('Completed: ' + message); };
const bounded = async (promise, message, timeout = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
};
async function clickAction(page, click) {
  const matches = request => request.method() === 'POST' && !!request.headers()['next-action'] && new URL(request.url()).pathname === '/en/dashboard';
  let finish, fail, selected, resolveTerminal;
  const observed = new Map();
  const terminal = new Promise(resolve => {
    resolveTerminal = resolve;
    const record = (request, value) => {
      if (!matches(request)) return;
      observed.set(request, value);
      if (request === selected) resolve(value);
    };
    finish = request => record(request, { state: 'finished', failure: null });
    fail = request => record(request, { state: 'failed', failure: request.failure()?.errorText });
    page.on('requestfinished', finish); page.on('requestfailed', fail);
  });
  const request = page.waitForRequest(matches, { timeout: 15000 });
  void request.catch(() => {});
  try {
    await click();
    selected = await request;
    if (observed.has(selected)) resolveTerminal(observed.get(selected));
    const [received, ended] = await Promise.all([bounded(selected.response(), 'Browser Server Action did not return response headers.'), bounded(terminal, 'Browser Server Action did not reach a terminal network event.')]);
    assert.ok(received);
    assert.equal(received.status(), 200);
    assert.match(received.headers()['content-type'], /^text\/x-component/);
    if (ended.state === 'failed') assert.equal(ended.failure, 'net::ERR_ABORTED');
    return { response: received, terminal: ended.state };
  } finally { page.off('requestfinished', finish); page.off('requestfailed', fail); }
}

async function completedNegativeReplay(context, request) {
  assert.equal(new URL(request.url()).origin, fixture.origin);
  const headers = { origin: fixture.origin };
  for (const name of ['next-action', 'content-type', 'rsc', 'accept', 'x-prnext-router-state']) if (request.headers()[name]) headers[name] = request.headers()[name];
  const response = await context.request.post(request.url(), { headers, data: request.postDataBuffer(), timeout: 15000 });
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /^text\/x-component/);
  assertSuccessfulActionBody(await response.body());
}
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
  fixture = await referenceFixture({ oidc, candidateArchive: candidateArchive || values['candidate-archive'], preparedRoot, preserveInstallation, artifactsDirectory: directory, onProgress: message => console.log(message) });
  report.installation = fixture.evidence;
  report.proxyRequests = fixture.proxyRequests;
  if (preparedRoot || preserveInstallation) report.diagnosticConsumer = fixture.root;
  if (!skipBuild) await fixture.build();
  else report.reusedBuild = true;
  const workflows = (async () => {
  await fixture.start({ workers: 2 });
  console.log('Reference server ready; starting browser workflows.');
  pool = await acquire(() => fixture.pool(), resource => resource.end());
  assert.equal((await pool.query('SHOW fsync')).rows[0].fsync, 'on');
  assert.equal((await pool.query('SHOW unix_socket_directories')).rows[0].unix_socket_directories, '');
  checked('PostgreSQL runtime fsync remains enabled');
  checked('PostgreSQL test cluster accepts TCP only');
  browserServer = await acquire(() => chromium.launchServer({ headless: true, host: '127.0.0.1' }), resource => resource.kill());
  report.browserProcess = browserServer.process().pid;
  browser = await acquire(() => chromium.connect(browserServer.wsEndpoint()), resource => resource.close());
  const actionNetwork = createActionNetworkRecorder(fixture.origin);
  report.browserActions = actionNetwork.records;
  const watch = target => target.on('pageerror', error => { report.pageErrors.push(error.name); });
  const contexts = { async newContext(options) {
    const context = await acquire(() => browser.newContext({ ...referenceBrowserOptions, ...options }), resource => resource.close());
    context.on('page', watch);
    actionNetwork.observeContext(context);
    return context;
  } };
  report.authenticationBudgets = {};
  await qualifyAuthenticationBudgets({ fixture, pool, browser: contexts, proof: report.authenticationBudgets, directory });
  checked('atomic account/global authentication budgets across independent PostgreSQL pools and concurrent real Server Actions');
  const context = await contexts.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const first = await page.goto(fixture.origin, { waitUntil: 'load' });
  await expect(page).toHaveURL(fixture.origin + '/fr');
  assert.match(first.headers().link || '', /hreflang="fr"/);
  assert.match(first.headers().link || '', /hreflang="en"/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  checked('locale negotiation and alternate links');
  await page.goto(fixture.origin + '/fr/sign-up');
  await page.getByLabel('Nom', { exact: true }).fill('Reference Alice');
  await page.getByLabel('E-mail', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('Reference-password-12345');
  await page.getByRole('button', { name: 'Créer un compte', exact: true }).click();
  await expect(page).toHaveURL(fixture.origin + '/fr/dashboard');
  await expect(page.getByTestId('account')).toContainText('alice@example.test');
  await page.getByLabel('Note', { exact: true }).fill('ALICE_PRIVATE_NOTE');
  const saveAction = await captureReferenceAction(page, () => page.getByRole('button', { name: 'Enregistrer la note', exact: true }).click());
  await expect(page.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  checked('registration, nextCookies and authenticated Server Action');
  await qualifySecureOrigin({ context, fixture });
  checked('secure HttpOnly SameSite session cookie and configured HTTPS redirects despite forged proxy headers');
  await qualifyCsrf({ context, action: saveAction, fixture, pool });
  checked('cross-origin and null-origin Server Actions/auth API reject before mutation and external callbacks are refused');

  // Test renewal without sleeping a day, against the isolated test schema only.
  const old = new Date(Date.now() - 172800000), expiry = new Date(Date.now() + 259200000);
  await pool.query('UPDATE "session" SET "updatedAt"=$1,"expiresAt"=$2 WHERE "userId"=(SELECT id FROM "user" WHERE email=$3)', [old, expiry, 'alice@example.test']);
  const session = await context.request.get(fixture.origin + '/api/auth/get-session');
  assert.equal(session.status(), 200);
  const refreshed = await pool.query('SELECT "updatedAt","expiresAt" FROM "session" WHERE "userId"=(SELECT id FROM "user" WHERE email=$1)', ['alice@example.test']);
  assert.ok(new Date(refreshed.rows[0].updatedAt) > old);
  assert.ok(new Date(refreshed.rows[0].expiresAt) > expiry);
  checked('database-backed session renewal');

  await qualifyRevokedMutation({ browser: contexts, fixture, pool, ownerPage: page, locale: 'fr' });
  checked('remote session revocation rejects a captured POST with its old cookie, protects routing and leaves PostgreSQL unchanged');

  const bob = await contexts.newContext({ locale: 'en-US' }), bobPage = await bob.newPage();
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
  checked('concurrent private dashboards on two distinct application worker processes');
  const aliceNote = await pool.query('SELECT id FROM prnext_reference_notes WHERE body=$1', ['ALICE_PRIVATE_NOTE']);
  await bobPage.evaluate(() => { window.__referenceDeleteDocument = true; });
  await bobPage.locator('input[name="id"]').first().evaluate((node, value) => { node.value = value; }, aliceNote.rows[0].id);
  const rejectedDelete = await clickAction(bobPage, () => bobPage.getByRole('button', { name: 'Delete note', exact: true }).click());
  // Chromium can abort this fetch after receiving the Flight model. Playwright
  // resolves Response.finished() only for requestfinished, so that promise can
  // stay pending on ERR_ABORTED. Replay this idempotent forged delete
  // through the same authenticated context and wait for its complete HTTP body
  // before checking rejection in PostgreSQL.
  await completedNegativeReplay(bob, rejectedDelete.response.request());
  const documentChangedAfterTamperedDelete = await bobPage.evaluate(() => window.__referenceDeleteDocument !== true);
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE id=$1', [aliceNote.rows[0].id])).rows[0].count, '1');
  // A no-op delete would also reject the tampered ID. Prove the legitimate
  // owner can delete their own note after that action has completed.
  await bobPage.reload();
  const ownDelete = await clickAction(bobPage, () => bobPage.getByRole('button', { name: 'Delete note', exact: true }).click());
  report.deleteNetwork = { tampered: rejectedDelete.terminal, owner: ownDelete.terminal, forgedApiResponseComplete: true, documentChangedAfterTamperedDelete };
  await expect(bobPage.getByText('BOB_PRIVATE_NOTE', { exact: true })).toHaveCount(0);
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE body=$1', ['BOB_PRIVATE_NOTE'])).rows[0].count, '0');
  await page.reload();
  await expect(page.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  await expect(page.getByText('BOB_PRIVATE_NOTE', { exact: true })).toHaveCount(0);
  checked('PostgreSQL ownership isolation, completed tampered delete rejection and owner delete');

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
  checked('localized client navigation, responsive forms and account continuity');
  await context.close(); await bob.close();

  report.oidcRejections = [];
  await qualifyOidcRejections({ browser: contexts, fixture, pool, oidc, proof: report.oidcRejections, checkpoint: persist });
  checked('real RP rejects state/context mismatch, invalid nonce/issuer/audience/signature/expiry, missing ID token and unverified local-email linking');
  await qualifyOidcSuccess({ browser: contexts, fixture, pool, oidc, subject: 'oidc-normal' });
  checked('OpenID Connect discovery, PKCE, verified ID token, HTTPS callback, logout and callback replay rejection');

  await fixture.stop();
  await waitForDatabaseClientsToClose();
  await fixture.start({ standalone: true, removeSource: true, workers: 2 });
  const portable = await contexts.newContext(), portablePage = await portable.newPage();
  await portablePage.goto(fixture.origin + '/en/sign-in');
  await portablePage.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await portablePage.getByLabel('Password', { exact: true }).fill('Reference-password-12345');
  await portablePage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(portablePage).toHaveURL(fixture.origin + '/en/dashboard');
  await expect(portablePage.getByText('ALICE_PRIVATE_NOTE', { exact: true })).toBeVisible();
  await portablePage.getByLabel('Note', { exact: true }).fill('STANDALONE_PERSISTED_NOTE');
  await portablePage.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(portablePage.getByText('STANDALONE_PERSISTED_NOTE', { exact: true })).toBeVisible();
  const portableBob = await contexts.newContext(), portableBobPage = await portableBob.newPage();
  await portableBobPage.goto(fixture.origin + '/en/sign-in');
  await portableBobPage.getByLabel('Email', { exact: true }).fill('bob@example.test');
  await portableBobPage.getByLabel('Password', { exact: true }).fill('Reference-password-67890');
  await portableBobPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(portableBobPage).toHaveURL(fixture.origin + '/en/dashboard');
  report.standaloneWorkerProcessesObserved = await proveTwoWorkers(portable, portableBob, { firstNote: 'STANDALONE_PERSISTED_NOTE' });
  await qualifyRevokedMutation({ browser: contexts, fixture, pool, ownerPage: portablePage, prefix: 'standalone' });
  checked('relocated standalone revokes remote sessions and rejects their captured mutation POST');
  await qualifyOidcSuccess({ browser: contexts, fixture, pool, oidc, subject: 'oidc-standalone' });
  checked('relocated standalone completes OIDC over HTTPS, uses secure cookies and rejects callback replay');
  await portableBob.close();
  await portable.close();
  actionNetwork.assertComplete();
  checked(preserveInstallation ? 'diagnostic relocated standalone with retained source, two workers' : 'relocated standalone without original sources or node_modules, two workers');
  assert.deepEqual(report.pageErrors, []);
  })();
  void workflows.catch(() => {});
  await Promise.race([workflows, new Promise((_, reject) => {
    scenarioTimer = setTimeout(() => { expired = true; reject(new Error('Reference workflows exceeded their 180 second deadline.')); }, 180000);
  })]);
  report.workflowsComplete = true;
} catch (error) {
  primaryError = error;
  report.failure = { name: error.name, workflowDeadlineExceeded: expired };
  throw error;
} finally {
  clearTimeout(scenarioTimer);
  closing = true;
  let persistenceError;
  try { await persist(); } catch (error) { persistenceError = error; }
  if (!report.complete) {
    try { await referenceDeadline(Promise.resolve(fixture?.writeServerLog()), 'Reference diagnostic log deadline.', 5000); }
    catch { report.diagnosticLogFailed = true; }
  }
  report.cleanup = await closeReferenceResources([
    { name: 'browser', timeout: 5000, close: async () => { await browser?.close(); await browserServer?.close(); }, force: async () => { await browserServer?.kill(); } },
    { name: 'pool', timeout: 5000, close: async () => { await pool?.end(); } },
    { name: 'fixture', timeout: 45000, close: async () => { await fixture?.close(); } },
    { name: 'oidc', timeout: 5000, close: async () => { await oidc?.close(); } },
  ], async outcomes => { report.cleanup = outcomes; await persist(); });
  const failedCleanup = report.cleanup.some(outcome => outcome.phase !== 'closed' || outcome.progressPersistenceFailed);
  report.complete = report.qualificationMode === 'clean' && report.workflowsComplete === true && !failedCleanup && !primaryError && !persistenceError;
  try { await persist(); } catch (error) { persistenceError ||= error; }
  if (failedCleanup && !primaryError) throw new Error('Reference owned-resource cleanup failed; inspect the qualification report.');
  if (persistenceError && !primaryError) throw new Error('Reference report persistence failed after owned resource cleanup.');
}
if (report.workflowsComplete) console.log('Reference ' + (report.qualificationMode === 'clean' ? 'qualification' : 'diagnostic') + ' passed: ' + report.checks.length + ' complete workflows; owned-resource cleanup completed.');
return report;
}

if (isMainModule(import.meta.url)) await qualifyReference();
