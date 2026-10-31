import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { getPool } from './database.js';
import { applicationOrigin, required } from './environment.js';

let instance;
export function getAuth() {
  if (!instance) {
    const secret = required('BETTER_AUTH_SECRET');
    if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
    const plugins = [];
    if (process.env.OIDC_ISSUER) {
      let issuer;
      try { issuer = new URL(process.env.OIDC_ISSUER); } catch { throw new Error('OIDC_ISSUER must be an absolute HTTPS URL.'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
      if (issuer.username || issuer.password || issuer.search || issuer.hash
          || !(issuer.protocol === 'https:' || (issuer.protocol === 'http:' && local))) throw new Error('OIDC_ISSUER requires HTTPS, except on loopback development hosts.');
      plugins.push(genericOAuth({ config: [{
        providerId: 'oidc',
        discoveryUrl: issuer.href.replace(/\/$/, '') + '/.well-known/openid-configuration',
        clientId: required('OIDC_CLIENT_ID'), clientSecret: required('OIDC_CLIENT_SECRET'),
        scopes: ['openid', 'profile', 'email'], pkce: true, requireIdTokenVerification: true,
      }] }));
    }
    plugins.push(nextCookies());
    instance = betterAuth({
      secret, baseURL: applicationOrigin(), database: getPool(),
      emailAndPassword: { enabled: true, minPasswordLength: 12 },
      session: { expiresIn: 604800, updateAge: 86400, cookieCache: { enabled: false } },
      plugins, telemetry: { enabled: false },
    });
  }
  return instance;
}
