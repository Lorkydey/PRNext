import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { startReferenceOidc } from './oidc.mjs';

const redirectUri = 'http://127.0.0.1:34567/api/auth/callback/oidc';
async function provider(t) {
  const oidc = await startReferenceOidc();
  t.after(() => oidc.close());
  return oidc;
}
async function authorize(oidc, overrides = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: oidc.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state: 'fixture-state', nonce: 'fixture-nonce', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...overrides });
  const response = await fetch(`${oidc.issuer}/authorize?${query}`, { redirect: 'manual' });
  return { response, code: response.headers.get('location') ? new URL(response.headers.get('location')).searchParams.get('code') : null, verifier };
}
async function exchange(oidc, authorization, overrides = {}, headers = {}) {
  return fetch(`${oidc.issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ grant_type: 'authorization_code', code: authorization.code, redirect_uri: redirectUri, code_verifier: authorization.verifier, client_id: oidc.clientId, client_secret: oidc.clientSecret, ...overrides }) });
}

test('local provider advertises OIDC discovery and verifies its RS256 identity tokens with public JWKS', async t => {
  const oidc = await provider(t);
  const discovery = await (await fetch(`${oidc.issuer}/.well-known/openid-configuration`)).json();
  assert.equal(discovery.issuer, oidc.issuer);
  assert.equal(discovery.token_endpoint, `${oidc.issuer}/token`);
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  const authorization = await authorize(oidc);
  assert.equal(authorization.response.status, 302);
  const callback = new URL(authorization.response.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  const response = await exchange(oidc, authorization);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const tokens = await response.json(), [header, payload, signature] = tokens.id_token.split('.');
  const protectedHeader = JSON.parse(Buffer.from(header, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const jwks = await (await fetch(discovery.jwks_uri)).json();
  assert.equal(jwks.keys[0].kid, protectedHeader.kid);
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(jwks.keys[0].d, undefined);
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')), true);
  assert.equal(claims.iss, oidc.issuer);
  assert.equal(claims.aud, oidc.clientId);
  assert.equal(claims.nonce, 'fixture-nonce');
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(claims.email_verified, true);
  const info = await fetch(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).sub, claims.sub);
  assert.equal((await fetch(discovery.userinfo_endpoint)).status, 401);
});

test('authorization codes are single-use and bound to client, exact redirect URI and PKCE verifier', async t => {
  const oidc = await provider(t), authorization = await authorize(oidc);
  assert.equal((await exchange(oidc, authorization, { client_secret: 'wrong-secret' })).status, 401);
  assert.equal((await exchange(oidc, authorization)).status, 200);
  const replay = await exchange(oidc, authorization);
  assert.equal(replay.status, 400);
  assert.deepEqual(await replay.json(), { error: 'invalid_grant' });
  const wrongVerifier = await authorize(oidc);
  assert.equal((await exchange(oidc, wrongVerifier, { code_verifier: 'a'.repeat(43) })).status, 400);
  assert.equal((await exchange(oidc, wrongVerifier)).status, 400);
  const wrongRedirect = await authorize(oidc);
  assert.equal((await exchange(oidc, wrongRedirect, { redirect_uri: 'http://127.0.0.1:34568/api/auth/callback/oidc' })).status, 400);
  assert.equal((await exchange(oidc, await authorize(oidc), { grant_type: 'refresh_token' })).status, 400);
});

test('authorization rejects external callbacks, mismatched clients, duplicate fields and missing PKCE', async t => {
  const oidc = await provider(t);
  for (const overrides of [
    { redirect_uri: 'https://example.test/api/auth/callback/oidc' },
    { redirect_uri: 'http://127.0.0.1:34567/api/auth/oauth2/callback/oidc' },
    { redirect_uri: 'http://127.0.0.1:34567/another-callback' },
    { redirect_uri: `${redirectUri}?leak=true` },
    { client_id: 'different-client' }, { response_type: 'token' }, { code_challenge_method: 'plain' }, { code_challenge: '' }, { scope: 'email' },
  ]) {
    const { response } = await authorize(oidc, overrides);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  }
  const duplicate = await fetch(`${oidc.issuer}/authorize?client_id=${oidc.clientId}&client_id=${oidc.clientId}`, { redirect: 'manual' });
  assert.equal(duplicate.status, 400);
});

test('test identities are snapshotted at authorization and contexts never share an identity', async t => {
  const oidc = await provider(t);
  oidc.setUser('user-a', 'user-a@example.test');
  const first = await authorize(oidc);
  oidc.setUser('user-b', 'user-b@example.test');
  const second = await authorize(oidc);
  for (const [authorization, subject] of [[first, 'user-a'], [second, 'user-b']]) {
    const tokens = await (await exchange(oidc, authorization)).json();
    const info = await (await fetch(`${oidc.issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json();
    assert.equal(info.sub, subject);
    assert.equal(info.email, `${subject}@example.test`);
  }
  assert.throws(() => oidc.setUser('', 'user@example.test'), /subject and email/);
});

test('client_secret_basic is supported and malformed or conflicting client credentials are rejected', async t => {
  const oidc = await provider(t), authorization = await authorize(oidc);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: authorization.code, redirect_uri: redirectUri, code_verifier: authorization.verifier });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${oidc.clientId}:${oidc.clientSecret}`).toString('base64')}` };
  const response = await fetch(`${oidc.issuer}/token`, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  const next = await authorize(oidc);
  assert.equal((await exchange(oidc, next, {}, { authorization: headers.authorization })).status, 401);
  assert.equal((await fetch(`${oidc.issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
});

test('RP fault modes alter real signed token responses and are snapshotted per authorization', async t => {
  const oidc = await provider(t);
  for (const fault of ['nonce', 'issuer', 'audience', 'signature', 'expired', 'missing-id-token']) {
    oidc.setFault(fault);
    const authorization = await authorize(oidc);
    oidc.setFault(null);
    const response = await exchange(oidc, authorization);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    if (fault === 'missing-id-token') { assert.equal(tokens.id_token, undefined); continue; }
    const [header, payload, signature] = tokens.id_token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const jwks = await (await fetch(oidc.issuer + '/jwks')).json();
    assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')), fault !== 'signature');
    if (fault === 'nonce') assert.notEqual(claims.nonce, 'fixture-nonce');
    if (fault === 'issuer') assert.notEqual(claims.iss, oidc.issuer);
    if (fault === 'audience') assert.notEqual(claims.aud, oidc.clientId);
    if (fault === 'expired') assert.ok(claims.exp < claims.iat);
  }
  assert.equal(oidc.exchanges, 6);
  assert.equal(oidc.issuedTokens, 6);
  assert.deepEqual(oidc.tokenResponses.map(value => value.fault), ['nonce', 'issuer', 'audience', 'signature', 'expired', 'missing-id-token']);
  oidc.setFault('state');
  const state = await authorize(oidc, { redirect_uri: 'https://127.0.0.1:34567/api/auth/callback/oidc' });
  assert.equal(new URL(state.response.headers.get('location')).searchParams.get('state'), 'invalid-state');
  assert.throws(() => oidc.setFault('unknown'), /Unknown reference OIDC fault/);
});
