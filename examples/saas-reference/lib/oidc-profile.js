// Better Auth's generic OAuth plugin verifies the ID token against discovery,
// JWKS, audience and the request nonce BEFORE invoking this profile mapper.
// Require that token: the generic plugin otherwise permits a userinfo fallback
// when the provider omits it, which is not the OIDC contract of this reference.
export function oidcProfileFromVerifiedTokens(tokens) {
  if (typeof tokens.idToken !== 'string' || tokens.idToken.length > 16384) return null;
  const parts = tokens.idToken.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { return null; }
  if (typeof claims?.sub !== 'string' || !claims.sub || claims.sub.length > 255
      || /[\x00-\x1f\x7f]/.test(claims.sub)
      || typeof claims.email !== 'string' || claims.email.length > 254
      || /[\x00-\x1f\x7f]/.test(claims.email)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) return null;
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : claims.sub,
  };
}
