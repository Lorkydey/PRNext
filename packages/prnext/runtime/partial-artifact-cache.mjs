// Memoize parsing only AFTER the authoritative data cache returned its bytes.
// Comparing exact bytes preserves expiry and invalidation even for the same key.
// Never store live React models, request contexts, cookies or headers here.
import { createHash } from 'node:crypto';
import { SieveCache } from '../compat/sieve-cache.cjs';

export class PartialArtifactCache {
  constructor({ maxEntries = 16, maxBytes = 256 * 1024, maxEntryBytes = 64 * 1024 } = {}) {
    this.entries = new SieveCache({ maxEntries, maxBytes });
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.maxEntryBytes = maxEntryBytes;
  }
  parse(key, bytes) {
    const hit = this.entries.get(key);
    if (hit && hit.bytes.equals(bytes)) {
      return hit.value;
    }
    const value = JSON.parse(bytes.toString());
    if (hit) this.entries.delete(key);
    if (bytes.length <= this.maxEntryBytes && bytes.length <= this.maxBytes && this.maxEntries > 0) {
      // Own compact storage; a cache RPC buffer can share a much larger slab.
      const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
      this.entries.set(key, { bytes: owned, value }, owned.length);
    }
    return value;
  }
  get bytes() { return this.entries.bytes; }
}

const identities = new WeakMap();
export function partialIdentity(artifact) {
  let identity = identities.get(artifact);
  if (!identity) { identity = createHash('sha256').update(artifact.flight).digest('hex'); identities.set(artifact, identity); }
  return identity;
}
