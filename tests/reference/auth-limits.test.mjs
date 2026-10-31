import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticationLimits, consumeAuthenticationBudget } from '../../examples/saas-reference/lib/auth-limits.js';
import { oidcProfileFromVerifiedTokens } from '../../examples/saas-reference/lib/oidc-profile.js';

test('authentication budgets hash normalized identities and separate operations and installations', async () => {
  const calls = [];
  const pool = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ allowed: true }] }; } };
  const secret = 'a'.repeat(64);
  assert.equal(await consumeAuthenticationBudget(pool, { email: ' Alice@Example.test ', secret }), true);
  await consumeAuthenticationBudget(pool, { email: 'alice@example.test', secret });
  await consumeAuthenticationBudget(pool, { email: 'alice@example.test', secret, registering: true });
  await consumeAuthenticationBudget(pool, { email: 'alice@example.test', secret: 'b'.repeat(64) });
  assert.equal(calls[0].values[1], calls[1].values[1]);
  assert.notEqual(calls[1].values[1], calls[2].values[1]);
  assert.notEqual(calls[1].values[1], calls[3].values[1]);
  assert.match(calls[0].values[1], /^account:sign-in:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(calls).includes('Alice@'));
  assert.deepEqual(calls[0].values.slice(2), Object.values(authenticationLimits['sign-in']));
});

test('authentication budgets fail closed on empty decisions, invalid input and database failure', async () => {
  const options = { email: 'user@example.test', secret: 'a'.repeat(64) };
  for (const rows of [[], [{ allowed: false }], [{ allowed: 'true' }]]) {
    assert.equal(await consumeAuthenticationBudget({ query: async () => ({ rows }) }, options), false);
  }
  await assert.rejects(consumeAuthenticationBudget({ query: async () => { throw new Error('database unavailable'); } }, options), /database unavailable/);
  for (const invalid of [{ email: '' }, { email: 'a'.repeat(255) }, { secret: 'short' }]) {
    await assert.rejects(consumeAuthenticationBudget({ query: () => assert.fail('invalid input reached database') }, { ...options, ...invalid }), /bounded email/);
  }
});

test('OIDC profile mapping requires an ID token and retains only bounded identity claims', () => {
  const token = claims => 'e30.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.c2ln';
  const profile = oidcProfileFromVerifiedTokens({ idToken: token({ sub: 'subject', email: 'a@example.test', email_verified: true, name: 'Name', secret: 'not-a-profile-field' }) });
  assert.deepEqual(profile, { sub: 'subject', email: 'a@example.test', emailVerified: true, name: 'Name' });
  for (const tokens of [{}, { idToken: '' }, { idToken: 'bad' }, { idToken: 'a'.repeat(16385) }, { idToken: token({ email: 'a@example.test' }) }, { idToken: token({ sub: 's', email: 'invalid' }) }]) {
    assert.equal(oidcProfileFromVerifiedTokens(tokens), null);
  }
  assert.equal(oidcProfileFromVerifiedTokens({ idToken: token({ sub: 's', email: 'a@example.test', email_verified: 'true' }) }).emailVerified, false);
});
