import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';

const token = () => randomBytes(32).toString('base64url');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
const nonceValue = value => value === null || value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

/** An isolated test provider. It binds loopback only and never logs credentials. */
export async function startReferenceOidc() {
  const clientId = `prnext-reference-${randomBytes(8).toString('hex')}`, clientSecret = token();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(8).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const codes = new Map(), accessTokens = new Map();
  const faults = new Set(['state', 'nonce', 'issuer', 'audience', 'signature', 'expired', 'missing-id-token']);
  let fault = null, exchanges = 0, issuedTokens = 0;
  const tokenResponses = [];
  let issuer, user = { sub: 'reference-user-a', email: 'reference-a@example.test', email_verified: true, name: 'Reference user A' };
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' });
    res.end(JSON.stringify(value));
  };
  const invalid = (res, error = 'invalid_request', status = 400) => json(res, status, { error });
  const prune = () => {
    const now = Date.now();
    for (const store of [codes, accessTokens]) {
      for (const [key, value] of store) if (value.expires <= now) store.delete(key);
      while (store.size >= 256) store.delete(store.keys().next().value);
    }
  };
  function redirectUri(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    try {
      const uri = new URL(raw);
      if (!['http:', 'https:'].includes(uri.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) || uri.username || uri.password || uri.hash || uri.search || uri.pathname !== '/api/auth/callback/oidc') return null;
      return uri;
    } catch { return null; }
  }
  async function form(req) {
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) return null;
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8192) return null;
      chunks.push(chunk);
    }
    const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    for (const key of values.keys()) if (values.getAll(key).length !== 1) return null;
    return values;
  }
  function authenticates(req, values) {
    let id = values.get('client_id'), secret = values.get('client_secret');
    if (req.headers.authorization) {
      if (!req.headers.authorization.startsWith('Basic ') || id !== null || secret !== null) return false;
      const value = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8'), separator = value.indexOf(':');
      if (separator < 0) return false;
      try { id = decodeURIComponent(value.slice(0, separator)); secret = decodeURIComponent(value.slice(separator + 1)); }
      catch { return false; }
    }
    return equal(id, clientId) && equal(secret, clientSecret);
  }
  const server = createServer(async (req, res) => {
    try {
      prune();
      const url = new URL(req.url, issuer);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'email', 'profile'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name'],
      });
      if (req.method === 'GET' && url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const query = url.searchParams;
        for (const key of query.keys()) if (query.getAll(key).length !== 1) return invalid(res);
        const target = redirectUri(query.get('redirect_uri')), challenge = query.get('code_challenge'), nonce = query.get('nonce'), state = query.get('state');
        if (query.get('client_id') !== clientId || query.get('response_type') !== 'code' || !target || !state || state.length > 1024 || /[\x00-\x1f\x7f]/.test(state) || !nonceValue(nonce)) return invalid(res);
        if (query.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge || '')) return invalid(res);
        const scopes = (query.get('scope') || '').split(/\s+/).filter(Boolean);
        if (!scopes.includes('openid') || scopes.some(scope => !['openid', 'email', 'profile'].includes(scope))) return invalid(res, 'invalid_scope');
        const code = token();
        codes.set(code, { clientId, redirectUri: query.get('redirect_uri'), challenge, nonce, fault, user: { ...user }, expires: Date.now() + 60000 });
        target.searchParams.set('code', code); target.searchParams.set('state', fault === 'state' ? 'invalid-state' : state);
        res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }); return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const values = await form(req);
        if (!values) return invalid(res);
        if (!authenticates(req, values)) return invalid(res, 'invalid_client', 401);
        if (values.get('grant_type') !== 'authorization_code') return invalid(res, 'unsupported_grant_type');
        const code = values.get('code'), authorization = codes.get(code);
        if (!authorization) return invalid(res, 'invalid_grant');
        codes.delete(code);
        exchanges++;
        const verifier = values.get('code_verifier');
        if (authorization.expires <= Date.now() || authorization.clientId !== clientId || !equal(values.get('redirect_uri'), authorization.redirectUri) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier || '') || !equal(createHash('sha256').update(verifier).digest('base64url'), authorization.challenge)) return invalid(res, 'invalid_grant');
        const now = Math.floor(Date.now() / 1000), accessToken = token();
        const claims = { ...authorization.user, iss: issuer, aud: clientId, iat: now, exp: now + 300, ...(authorization.nonce !== null ? { nonce: authorization.nonce } : {}) };
        if (authorization.fault === 'nonce') claims.nonce = 'incorrect-nonce';
        if (authorization.fault === 'issuer') claims.iss = 'https://incorrect-issuer.example.test';
        if (authorization.fault === 'audience') claims.aud = 'incorrect-client';
        if (authorization.fault === 'expired') claims.exp = now - 300;
        const data = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(claims)}`;
        const signature = sign('RSA-SHA256', Buffer.from(data), privateKey);
        if (authorization.fault === 'signature') signature[0] ^= 1;
        const idToken = `${data}.${signature.toString('base64url')}`;
        accessTokens.set(accessToken, { user: authorization.user, expires: Date.now() + 300000 });
        res.once('finish', () => {
          issuedTokens++;
          if (tokenResponses.length < 256) tokenResponses.push({ status: 200, fault: authorization.fault });
        });
        return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, ...(authorization.fault === 'missing-id-token' ? {} : { id_token: idToken }), scope: 'openid email profile' });
      }
      if (req.method === 'GET' && url.pathname === '/userinfo') {
        const authorization = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || ''), access = authorization && accessTokens.get(authorization[1]);
        if (!access || access.expires <= Date.now()) return invalid(res, 'invalid_token', 401);
        return json(res, 200, access.user);
      }
      return invalid(res, 'not_found', 404);
    } catch { if (!res.headersSent) invalid(res); else res.end(); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  issuer = `http://127.0.0.1:${server.address().port}`;
  return {
    issuer, clientId, clientSecret,
    get exchanges() { return exchanges; },
    get issuedTokens() { return issuedTokens; },
    get tokenResponses() { return tokenResponses.map(value => ({ ...value })); },
    setFault(value) {
      if (value !== null && !faults.has(value)) throw new Error('Unknown reference OIDC fault.');
      fault = value;
    },
    setUser(id, email) {
      if (typeof id !== 'string' || !id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id) || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Provide a test subject and email address.');
      user = { sub: id, email, email_verified: true, name: `Reference user ${id}` };
    },
    async close() { codes.clear(); accessTokens.clear(); await new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }); },
  };
}
