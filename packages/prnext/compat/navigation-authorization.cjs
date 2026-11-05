'use strict';
const { createHmac } = require('node:crypto');
function developmentNavigationSecret(actionKey) {
  if (typeof actionKey !== 'string' || !actionKey) return undefined;
  // The compiler retains this private key across generations of one dev
  // session. Derive a separate purpose key so worker replacement cannot look
  // like an account change, without publishing or reusing the encryption key.
  return createHmac('sha256', actionKey).update('prnext:development:navigation-authorization:v1').digest('hex');
}
function navigationAuthorization(context, secret, cookieNames) {
  if (!secret || context?.staticState) return undefined;
  const names = cookieNames === undefined ? null : new Set(cookieNames);
  const cookies = context.cookies.getAll().filter(cookie => !names || names.has(cookie.name)).map(({ name, value }) => [name, value]).sort((a, b) => a[0].localeCompare(b[0]));
  return createHmac('sha256', secret).update(JSON.stringify([cookies, context.headers.get('authorization') || ''])).digest('hex');
}
module.exports = { navigationAuthorization, developmentNavigationSecret };
