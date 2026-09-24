// Memoize parsing only AFTER the authoritative data cache returned its bytes.
// Comparing exact bytes preserves expiry and invalidation even for the same key.
// Never store live React models, request contexts, cookies or headers here.
import { createHash } from 'node:crypto';

export class PartialArtifactCache {
  constructor({ maxEntries = 16, maxBytes = 256 * 1024, maxEntryBytes = 64 * 1024 } = {}) {
    this.entries = new Map(); this.bytes = 0;
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.maxEntryBytes = maxEntryBytes;
  }
  parse(key, bytes) {
    const hit = this.entries.get(key);
    if (hit && hit.bytes.equals(bytes)) {
      this.entries.delete(key); this.entries.set(key, hit);
      return hit.value;
    }
    const value = JSON.parse(bytes.toString());
    if (hit) { this.entries.delete(key); this.bytes -= hit.bytes.length; }
    if (bytes.length <= this.maxEntryBytes && bytes.length <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes.length > this.maxBytes)) {
        const [oldKey, old] = this.entries.entries().next().value;
        this.entries.delete(oldKey); this.bytes -= old.bytes.length;
      }
      // Own compact storage; a cache RPC buffer can share a much larger slab.
      const owned = Buffer.allocUnsafeSlow(bytes.length); bytes.copy(owned);
      this.entries.set(key, { bytes: owned, value }); this.bytes += owned.length;
    }
    return value;
  }
}

const identities = new WeakMap();
export function partialIdentity(artifact) {
  let identity = identities.get(artifact);
  if (!identity) { identity = createHash('sha256').update(artifact.flight).digest('hex'); identities.set(artifact, identity); }
  return identity;
}
