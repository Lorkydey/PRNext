import { createHmac } from 'node:crypto';

// The global budget both limits aggregate password work and bounds the number
// of account keys an attacker can create. Neither budget trusts forwarded IPs.
export const authenticationLimits = Object.freeze({
  'sign-in': Object.freeze({ account: 5, global: 100, seconds: 60 }),
  'sign-up': Object.freeze({ account: 3, global: 20, seconds: 600 }),
});

// All writers lock global -> account -> expired rows of the SAME operation.
// Cleanup depends on the account decision and excludes that account, avoiding
// both same-statement double modification and reverse lock-order deadlocks.
export const authenticationBudgetSql = `
WITH global_budget AS (
  INSERT INTO prnext_reference_auth_limits (key, hits, reset_at)
  VALUES ($1, 1, statement_timestamp() + $5 * interval '1 second')
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN prnext_reference_auth_limits.reset_at <= statement_timestamp()
      THEN 1 ELSE prnext_reference_auth_limits.hits + 1 END,
    reset_at = CASE WHEN prnext_reference_auth_limits.reset_at <= statement_timestamp()
      THEN statement_timestamp() + $5 * interval '1 second'
      ELSE prnext_reference_auth_limits.reset_at END
  WHERE prnext_reference_auth_limits.reset_at <= statement_timestamp()
    OR prnext_reference_auth_limits.hits < $4
  RETURNING key
), account_budget AS (
  INSERT INTO prnext_reference_auth_limits (key, hits, reset_at)
  SELECT $2, 1, statement_timestamp() + $5 * interval '1 second' FROM global_budget
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN prnext_reference_auth_limits.reset_at <= statement_timestamp()
      THEN 1 ELSE prnext_reference_auth_limits.hits + 1 END,
    reset_at = CASE WHEN prnext_reference_auth_limits.reset_at <= statement_timestamp()
      THEN statement_timestamp() + $5 * interval '1 second'
      ELSE prnext_reference_auth_limits.reset_at END
  WHERE prnext_reference_auth_limits.reset_at <= statement_timestamp()
    OR prnext_reference_auth_limits.hits < $3
  RETURNING key
), expired AS (
  DELETE FROM prnext_reference_auth_limits WHERE key IN (
    SELECT key FROM prnext_reference_auth_limits
    WHERE key LIKE ('account:' || split_part($1, ':', 2) || ':%')
      AND reset_at <= statement_timestamp() AND key <> $2
      AND EXISTS (SELECT FROM account_budget)
    ORDER BY reset_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) RETURNING key
)
SELECT EXISTS (SELECT FROM account_budget) AS allowed`;

export async function consumeAuthenticationBudget(pool, { email, registering, secret }) {
  if (typeof email !== 'string' || !email || email.length > 254
      || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Authentication budget requires a bounded email and an auth secret.');
  }
  const operation = registering ? 'sign-up' : 'sign-in';
  const limit = authenticationLimits[operation];
  const account = createHmac('sha256', secret)
    .update('prnext-reference-auth-limit-v1\0' + operation + '\0' + email.trim().toLowerCase())
    .digest('hex');
  const result = await pool.query(authenticationBudgetSql, [
    'global:' + operation, 'account:' + operation + ':' + account,
    limit.account, limit.global, limit.seconds,
  ]);
  return result.rows[0]?.allowed === true;
}
