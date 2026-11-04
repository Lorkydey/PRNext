import { isIP } from 'node:net';

export function validateServerConfig(value) {
  if (value === undefined) return { trustedProxies: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['publicOrigin', 'trustedProxies'].includes(key))) {
    throw new TypeError('server must be an object with publicOrigin and trustedProxies.');
  }
  let publicOrigin;
  if (value.publicOrigin !== undefined) {
    const source = value.publicOrigin;
    let url;
    try { url = new URL(source); } catch { /* validated below */ }
    if (typeof source !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(source) || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || source.includes('?') || source.includes('#')) {
      throw new TypeError('server.publicOrigin must be an HTTP(S) origin without credentials, path, query or fragment, for example https://example.com.');
    }
    publicOrigin = url.origin;
  }
  const ranges = value.trustedProxies ?? [];
  if (!Array.isArray(ranges) || ranges.length > 32 || ranges.some(range => {
    if (typeof range !== 'string' || range.length > 64) return true;
    const [address, bits, ...extra] = range.split('/');
    const family = isIP(address);
    return !family || extra.length || bits !== undefined && (!/^(0|[1-9]\d*)$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128));
  })) throw new TypeError('server.trustedProxies must contain at most 32 explicit IP addresses or CIDR ranges.');
  const normalized = ranges.map(range => {
    const [address, bits] = range.split('/');
    if (isIP(address) !== 6) return range;
    const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/i.exec(new URL(`http://[${address}]`).hostname);
    if (!mapped) return range;
    if (bits !== undefined && Number(bits) < 96) throw new TypeError('Mapped IPv4 proxy CIDR ranges need a prefix of at least 96 bits.');
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}${bits === undefined ? '' : '/' + (Number(bits) - 96)}`;
  });
  return { ...(publicOrigin ? { publicOrigin } : {}), trustedProxies: [...new Set(normalized)] };
}
