'use strict';
const { createHmac } = require('node:crypto');
function navigationAuthorization(context, secret, cookieNames) {
  if (!secret || context?.staticState) return undefined;
  const names = cookieNames === undefined ? null : new Set(cookieNames);
  const cookies = context.cookies.getAll().filter(cookie => !names || names.has(cookie.name)).map(({ name, value }) => [name, value]).sort((a, b) => a[0].localeCompare(b[0]));
  return createHmac('sha256', secret).update(JSON.stringify([cookies, context.headers.get('authorization') || ''])).digest('hex');
}
module.exports = { navigationAuthorization };
