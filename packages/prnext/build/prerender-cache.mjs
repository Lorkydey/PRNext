import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_VALUE = 2 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 256;
const LEASE_MS = 25_000;
const keyPattern = /^[a-f\d]{64}$/;

// A build-only, loopback capability. It shares only values which the existing
// runtime explicitly elects to cache. It never stores route output or fetches
// marked no-store. The entire store dies with this prerender session.
export async function createPrerenderCache() {
  const token = randomBytes(32).toString('hex');
  const values = new Map(), leases = new Map();
  let bytes = 0, active = 0;
  const generation = 0;
  function remove(key) { const value = values.get(key); if (value) { bytes -= value.cost; values.delete(key); } }
  function operation(input) {
    if (input.op === 'generation') return { generation };
    if (input.op === 'invalidate') throw new Error('Build cache invalidation requires a running production server');
    if (!keyPattern.test(input.key)) throw new Error('Invalid build cache key');
    const now = Date.now();
    for(const [key,lease] of leases)if(lease.until<=now)leases.delete(key);
    const lease = leases.get(input.key);
    if (input.op === 'leaseStatus') return { valid: Boolean(lease && lease.id === input.lease) };
    if (input.op === 'release') { if (lease?.id === input.lease) leases.delete(input.key); return {}; }
    if (input.op === 'commit') {
      if (!lease || lease.id !== input.lease || typeof input.value !== 'string' || input.value.length > Math.ceil(MAX_VALUE / 3) * 4) return { stored: false };
      const size = Buffer.byteLength(input.value, 'base64');
      if (size > MAX_VALUE || (input.revalidate !== null && (!Number.isFinite(input.revalidate) || input.revalidate < 0))) return { stored: false };
      remove(input.key);
      const cost = Buffer.byteLength(input.value) + 512;
      while (values.size && (bytes + cost > MAX_BYTES || values.size >= MAX_ENTRIES)) remove(values.keys().next().value);
      values.set(input.key, { value: input.value, cost, timestamp: now, revalidate: input.revalidate, expire: input.expire }); bytes += cost;
      leases.delete(input.key);
      return { stored: true };
    }
    if (input.op !== 'read') throw new Error('Unknown build cache operation');
    const record = values.get(input.key);
    const ttl = Math.min(input.revalidate ?? Infinity, record?.revalidate ?? Infinity, record?.expire ?? Infinity);
    if (record && now - record.timestamp < ttl * 1000) {
      values.delete(input.key); values.set(input.key, record);
      return { state: 'fresh', value: record.value, key: input.key, generation };
    }
    if (record) remove(input.key);
    if (lease) return { state: 'pending', retryAfterMs: 20, key: input.key, generation };
    if (leases.size >= MAX_ENTRIES) throw new Error('Build cache lease capacity exceeded');
    const id = randomBytes(16).toString('hex'); leases.set(input.key, { id, until: now + LEASE_MS });
    return { state: 'miss', lease: id, key: input.key, generation };
  }
  const server = createServer(async (request, response) => {
    if(active>=8){response.writeHead(503).end();return;}
    active++;
    try {
      const auth = Buffer.from(request.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (request.method !== 'POST' || request.url !== '/' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { response.writeHead(403).end(); return; }
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 3 * 1024 * 1024) throw new Error('Build cache request too large'); chunks.push(chunk); }
      const result = operation(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result));
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
    finally{active--;}
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const env = { PRNEXT_CACHE_URL: `http://127.0.0.1:${server.address().port}/`, PRNEXT_CACHE_TOKEN: token };
  return { env, async close() { values.clear(); leases.clear(); bytes = 0; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}
