import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { consumeAuthenticationBudget, authenticationLimits } from '../../examples/saas-reference/lib/auth-limits.js';
import { assertSuccessfulActionBody } from './action-response.mjs';
import { referenceDeadline } from './lifecycle.mjs';

export const referenceBrowserOptions = { ignoreHTTPSErrors: true };

export async function captureReferenceAction(page, click) {
  const pending = page.waitForRequest(request => request.method() === 'POST' && !!request.headers()['next-action']);
  void pending.catch(() => {});
  await click();
  const request = await pending;
  return { url: request.url(), headers: await request.allHeaders(), body: request.postDataBuffer() };
}

export async function replayReferenceAction(context, action, overrides = {}) {
  const headers = {};
  for (const name of ['next-action', 'content-type', 'rsc', 'accept', 'x-prnext-router-state', 'cookie', 'origin']) {
    if (action.headers[name]) headers[name] = action.headers[name];
  }
  return context.request.post(action.url, {
    headers: { ...headers, ...overrides.headers },
    data: overrides.body || action.body,
    maxRedirects: 0, timeout: 15000,
  });
}

export async function qualifyAuthenticationBudgets({ fixture, pool, browser, proof, directory }) {
  // Two independent pools model separate workers sharing only PostgreSQL. The
  // real Server Action test below also exercises the installed two-worker app.
  const other = await fixture.pool({ max: 4 });
  const secret = fixture.env.BETTER_AUTH_SECRET;
  try {
    const decisions = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      consumeAuthenticationBudget(index % 2 ? pool : other, { email: 'shared-budget@example.test', secret })));
    assert.equal(decisions.filter(Boolean).length, authenticationLimits['sign-in'].account);
    const signup = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      consumeAuthenticationBudget(index % 2 ? pool : other, { email: 'signup-budget-' + index + '@example.test', secret, registering: true })));
    assert.equal(signup.filter(Boolean).length, authenticationLimits['sign-up'].global);
    const keys = await pool.query("SELECT count(*) FROM prnext_reference_auth_limits WHERE key LIKE 'account:sign-up:%'");
    assert.equal(Number(keys.rows[0].count), authenticationLimits['sign-up'].global);
    await pool.query("UPDATE prnext_reference_auth_limits SET reset_at=now()-interval '1 second'");
    const recovered = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      consumeAuthenticationBudget(index % 2 ? pool : other, { email: index % 2 ? 'shared-budget@example.test' : 'second-recovered@example.test', secret })));
    assert.equal(recovered.filter(Boolean).length, 2 * authenticationLimits['sign-in'].account);
    proof.database = { simultaneousAttempts: decisions.length, accepted: decisions.filter(Boolean).length, signupAttempts: signup.length, signupAccepted: signup.filter(Boolean).length, recoveredAttempts: recovered.length, recoveredAccepted: recovered.filter(Boolean).length };
    assert.equal(await consumeAuthenticationBudget(other, { email: 'recovered-signup@example.test', secret, registering: true }), true);
    assert.ok(Number((await pool.query('SELECT count(*) FROM prnext_reference_auth_limits')).rows[0].count) <= 5);
    await pool.query('TRUNCATE prnext_reference_auth_limits');
  } finally { await other.end(); }

  const context = await browser.newContext({ ...referenceBrowserOptions, locale: 'fr-FR' });
  try {
    const page = await context.newPage();
    await page.goto(fixture.origin + '/fr/sign-in');
    await page.getByLabel('E-mail', { exact: true }).fill('quota@example.test');
    await page.getByLabel('Mot de passe', { exact: true }).fill('Invalid-password-12345');
    const action = await captureReferenceAction(page, () => page.getByRole('button', { name: 'Se connecter', exact: true }).click());
    await expect(page.getByRole('alert')).toHaveText('Connexion impossible. Vérifiez vos informations et réessayez.');
    const replies = await Promise.all(Array.from({ length: 20 }, async () => {
      const response = await replayReferenceAction(context, action);
      assert.equal(response.status(), 200);
      const body = await response.body();
      assertSuccessfulActionBody(body);
      return body.toString();
    }));
    assert.equal(replies.filter(body => body.includes('"error":"credentials"')).length, 4);
    assert.equal(replies.filter(body => body.includes('"error":"rateLimited"')).length, 16);
    proof.actions = { initialCredentialAttempt: 1, concurrentAttempts: replies.length, credentials: 4, throttled: 16 };
    // The real browser receives the localized denial too, not only a JSON key.
    proof.beforeSecondBrowserSubmit = {
      emailPresent: !!(await page.getByLabel('E-mail', { exact: true }).inputValue()),
      passwordLength: (await page.getByLabel('Mot de passe', { exact: true }).inputValue()).length,
      valid: await page.getByLabel('Mot de passe', { exact: true }).evaluate(input => input.form.checkValidity()),
      buttonDisabled: await page.getByRole('button', { name: 'Se connecter', exact: true }).isDisabled(),
    };
    // React resets uncontrolled inputs after an action returns. Re-enter the
    // credentials so native required validation permits this second submission.
    await page.getByLabel('E-mail', { exact: true }).fill('quota@example.test');
    await page.getByLabel('Mot de passe', { exact: true }).fill('Invalid-password-12345');
    const secondAction = await captureReferenceAction(page, () => page.getByRole('button', { name: 'Se connecter', exact: true }).click());
    await expect(page.getByRole('alert')).toHaveText('Trop de tentatives. Réessayez plus tard.');
    const secondFull = await replayReferenceAction(context, secondAction);
    const secondBody = await secondFull.body();
    assert.equal(secondFull.status(), 200);
    assertSuccessfulActionBody(secondBody);
    assert.match(secondBody.toString(), /"error":"rateLimited"/);
    await writeFile(path.join(directory, 'quota-second-complete-response.flight.txt'), secondBody);
    await page.goto(fixture.origin + '/en/sign-in');
    await page.getByLabel('Email', { exact: true }).fill('quota@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Invalid-password-12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Too many attempts. Try again later.');
    // Fail closed before reaching Better Auth when the counter store fails.
    // This schema belongs exclusively to this disposable test invocation.
    await pool.query('ALTER TABLE prnext_reference_auth_limits RENAME TO prnext_reference_auth_limits_unavailable');
    try {
      const unavailable = await replayReferenceAction(context, action);
      assert.equal(unavailable.status(), 200);
      const body = await unavailable.body();
      assertSuccessfulActionBody(body);
      assert.match(body.toString(), /"error":"authUnavailable"/);
    } finally {
      await pool.query('ALTER TABLE prnext_reference_auth_limits_unavailable RENAME TO prnext_reference_auth_limits');
    }
    const apiStatuses = await Promise.all(Array.from({ length: 8 }, async () => {
      const response = await context.request.post(fixture.origin + '/api/auth/sign-in/email', {
        headers: { origin: fixture.origin },
        data: { email: 'api-quota@example.test', password: 'Invalid-password-12345' },
      });
      await response.body();
      return response.status();
    }));
    assert.equal(apiStatuses.filter(status => status === 401).length, 3);
    assert.equal(apiStatuses.filter(status => status === 429).length, 5);
    proof.apiStatuses = apiStatuses;
    assert.equal((await pool.query('SELECT count(*) FROM "user"')).rows[0].count, '0');
  } finally { await context.close(); }
  // Isolated fixture administration, not a test-only production bypass.
  await pool.query('TRUNCATE prnext_reference_auth_limits');
}

export async function qualifySecureOrigin({ context, fixture }) {
  const cookies = await context.cookies();
  const cookie = cookies.find(value => value.name === '__Secure-better-auth.session_token');
  const preferredLocale = cookies.find(value => value.name === 'NEXT_LOCALE')?.value || 'fr';
  assert.ok(['en', 'fr'].includes(preferredLocale));
  assert.ok(cookie, 'HTTPS authentication must issue the secure-prefixed session cookie.');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.path, '/');
  const response = await context.request.get(fixture.origin + '/', {
    maxRedirects: 0,
    headers: { 'accept-language': 'fr', host: 'attacker.example.test', forwarded: 'host=attacker.example.test;proto=http', 'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'http', 'x-forwarded-for': '198.51.100.1' },
  });
  assert.ok([307, 308].includes(response.status()));
  assert.equal(new URL(response.headers().location).origin, fixture.origin);
  assert.equal(new URL(response.headers().location).pathname, '/' + preferredLocale);
  const slashes = await context.request.get(fixture.origin + '//attacker.example.test/en', { maxRedirects: 0 });
  if (slashes.headers().location) assert.equal(new URL(slashes.headers().location, fixture.origin).origin, fixture.origin);
}

export async function qualifyCsrf({ context, action, fixture, pool }) {
  const before = (await pool.query('SELECT count(*) FROM prnext_reference_notes')).rows[0].count;
  for (const origin of ['https://attacker.example.test', 'null']) {
    const response = await replayReferenceAction(context, action, { headers: { origin, 'x-forwarded-host': 'attacker.example.test' } });
    assert.equal(response.status(), 403);
    await response.body();
    const api = await context.request.post(fixture.origin + '/api/auth/sign-out', {
      headers: { origin }, data: {}, maxRedirects: 0,
    });
    assert.equal(api.status(), 403);
    await api.body();
  }
  assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes')).rows[0].count, before);
  assert.ok(await (await context.request.get(fixture.origin + '/api/auth/get-session')).json(), 'Rejected cross-origin sign-out must preserve the valid session.');
  const external = await context.request.post(fixture.origin + '/api/auth/sign-in/social', {
    headers: { origin: fixture.origin }, data: { provider: 'oidc', callbackURL: 'https://attacker.example.test/after-login' }, maxRedirects: 0,
  });
  assert.equal(external.status(), 403);
  await external.body();
}

export async function qualifyRevokedMutation({ browser, fixture, pool, ownerPage, locale = 'en', prefix = 'normal' }) {
  const second = await browser.newContext({ ...referenceBrowserOptions, locale: 'en-US' });
  try {
    const page = await second.newPage();
    await page.goto(fixture.origin + '/en/sign-in');
    await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Reference-password-12345');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(fixture.origin + '/en/dashboard');
    const marker = prefix.toUpperCase() + '_REVOKED_MUTATION';
    await page.getByLabel('Note', { exact: true }).fill(marker);
    const action = await captureReferenceAction(page, () => page.getByRole('button', { name: 'Save note', exact: true }).click());
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
    await pool.query('DELETE FROM prnext_reference_notes WHERE body=$1', [marker]);
    const label = locale === 'fr' ? 'Déconnecter les autres sessions' : 'Sign out other sessions';
    const status = locale === 'fr' ? 'Les autres sessions ont été déconnectées.' : 'Other sessions signed out.';
    await ownerPage.getByRole('button', { name: label, exact: true }).click();
    await expect(ownerPage.getByText(status, { exact: true })).toBeVisible();
    const rejected = await replayReferenceAction(second, action);
    assert.ok([200, 303, 307].includes(rejected.status()));
    await rejected.body();
    assert.equal((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE body=$1', [marker])).rows[0].count, '0');
    assert.equal((await second.request.get(fixture.origin + '/en/dashboard', { maxRedirects: 0 })).status(), 307);
    assert.equal(await (await second.request.get(fixture.origin + '/api/auth/get-session')).json(), null);
  } finally { await second.close(); }
}

async function oidcAuthorization({ context, fixture, oidc, fault = null }) {
  oidc.setFault(fault);
  const page = await context.newPage();
  await page.route(oidc.issuer + '/authorize?*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Authorization paused by the owned test harness.</p>' }));
  await page.goto(fixture.origin + '/en/sign-in');
  const pending = page.waitForRequest(request => request.url().startsWith(oidc.issuer + '/authorize?'));
  void pending.catch(() => {});
  await page.getByRole('button', { name: 'Continue with OpenID Connect', exact: true }).click();
  const authorization = await pending;
  const response = await context.request.get(authorization.url(), { maxRedirects: 0 });
  assert.equal(response.status(), 302);
  const callback = response.headers().location;
  assert.equal(new URL(callback).origin, fixture.origin, 'OIDC callback must retain the configured HTTPS public origin.');
  assert.equal(new URL(callback).pathname, '/api/auth/callback/oidc');
  // Keep the authorization page alive until the callback has settled. Browser
  // cookie synchronization belongs to the still-live browser context.
  return callback;
}

export async function qualifyOidcRejections({ browser, fixture, pool, oidc, proof = [], checkpoint = async () => {} }) {
  for (const fault of ['state', 'nonce', 'issuer', 'audience', 'signature', 'expired', 'missing-id-token', 'other-context', 'local-email-collision']) {
    const context = await browser.newContext(referenceBrowserOptions);
    let receiver, failure;
    const outcome = { fault, phase: 'authorization' };
    proof.push(outcome);
    await checkpoint();
    try {
      oidc.setUser('rejected-' + fault, fault === 'local-email-collision' ? 'alice@example.test' : 'rejected-' + fault + '@example.test');
      const before = await pool.query('SELECT (SELECT count(*) FROM "session") AS sessions, (SELECT count(*) FROM "account") AS accounts, (SELECT count(*) FROM "user") AS users');
      const exchanges = oidc.exchanges;
      const issued = oidc.issuedTokens;
      const callback = await oidcAuthorization({ context, fixture, oidc, fault: ['other-context', 'local-email-collision'].includes(fault) ? null : fault });
      receiver = fault === 'other-context' ? await browser.newContext(referenceBrowserOptions) : context;
      outcome.phase = 'callback';
      await checkpoint();
      let response;
      try { response = await referenceDeadline(receiver.request.get(callback, { maxRedirects: 0, timeout: 15000 }), 'OIDC callback deadline.', 15000); }
      catch { throw new Error('OIDC rejection ' + fault + ' callback did not complete within 15 seconds; inspect proxy lifecycle evidence.'); }
      outcome.status = response.status();
      outcome.phase = 'callback-body';
      await checkpoint();
      assert.ok([302, 303, 307, 400, 401, 403].includes(response.status()), fault + ' callback must be rejected.');
      await referenceDeadline(response.body(), 'OIDC callback body deadline.', 15000);
      outcome.phase = 'session-check';
      await checkpoint();
      assert.equal(await (await receiver.request.get(fixture.origin + '/api/auth/get-session')).json(), null, fault);
      const after = await pool.query('SELECT (SELECT count(*) FROM "session") AS sessions, (SELECT count(*) FROM "account") AS accounts, (SELECT count(*) FROM "user") AS users');
      assert.deepEqual(after.rows, before.rows, fault + ' must not create or link an account/session.');
      if (fault === 'state' || fault === 'other-context') assert.equal(oidc.exchanges, exchanges, 'Invalid browser state must be rejected before the token exchange.');
      else assert.equal(oidc.exchanges, exchanges + 1, 'The real RP must reject the actual token/profile response.');
      assert.equal(oidc.issuedTokens, issued + (fault === 'state' || fault === 'other-context' ? 0 : 1), 'Each token rejection must follow a completed HTTP200 token response, not an invalid_grant response.');
      if (oidc.issuedTokens > issued) assert.equal(oidc.tokenResponses.at(-1).fault, ['local-email-collision'].includes(fault) ? null : fault);
      outcome.phase = 'rejected';
      await checkpoint();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      oidc.setFault(null);
      const phase = outcome.phase;
      outcome.phase = phase === 'rejected' ? 'closing-rejected-context' : 'closing-failed-context';
      await checkpoint();
      const closing = [context, ...(receiver && receiver !== context ? [receiver] : [])];
      const results = await Promise.allSettled(closing.map(value => referenceDeadline(value.close(), 'OIDC browser context close deadline.', 5000)));
      if (results.some(value => value.status === 'rejected')) {
        outcome.contextCloseFailed = true;
        if (!failure) throw new Error('OIDC browser context cleanup exceeded its 5 second deadline.');
      }
      outcome.phase = phase;
      await checkpoint();
    }
  }
}

export async function qualifyOidcSuccess({ browser, fixture, pool, oidc, subject }) {
  const context = await browser.newContext(referenceBrowserOptions);
  try {
    oidc.setFault(null);
    oidc.setUser(subject, subject + '@example.test');
    const callback = await oidcAuthorization({ context, fixture, oidc });
    const response = await context.request.get(callback, { maxRedirects: 0 });
    assert.ok([302, 303, 307].includes(response.status()));
    assert.equal(new URL(response.headers().location, fixture.origin).href, fixture.origin + '/en/dashboard');
    const page = await context.newPage();
    await page.goto(fixture.origin + '/en/dashboard');
    await expect(page.getByTestId('account')).toContainText(subject + '@example.test');
    await qualifySecureOrigin({ context, fixture });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(fixture.origin + '/en/sign-in');
    assert.equal(await (await context.request.get(fixture.origin + '/api/auth/get-session')).json(), null);
    const before = (await pool.query('SELECT count(*) FROM "session"')).rows[0].count;
    const replay = await context.request.get(callback, { maxRedirects: 0 });
    assert.ok([302, 303, 307, 400, 401, 403].includes(replay.status()));
    await replay.body();
    assert.equal(await (await context.request.get(fixture.origin + '/api/auth/get-session')).json(), null);
    assert.equal((await pool.query('SELECT count(*) FROM "session"')).rows[0].count, before);
  } finally { await context.close(); }
}
