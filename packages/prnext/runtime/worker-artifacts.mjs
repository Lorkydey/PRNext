// Immutable build artefacts only. IDs and evictions use the request's MessagePort
// so a receiver resolves an ID before a later eviction can remove its entry.
export function workerArtifacts(port, { maxEntries = 8, maxBytes = 256 * 1024, maxEntryBytes = 64 * 1024 } = {}) {
  const entries = new Map();
  let sequence = 0, bytes = 0;
  return flight => {
    if (typeof flight !== 'string') return undefined;
    const size = flight.length * 2;
    if (!maxEntries || size > maxBytes || size > maxEntryBytes) return undefined;
    const old = entries.get(flight);
    if (old) { entries.delete(flight); entries.set(flight, old); return old.id; }
    while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) {
      const [key, item] = entries.entries().next().value;
      port.postMessage({ type: 'artifact-drop', id: item.id });
      entries.delete(key); bytes -= item.size;
    }
    const id = ++sequence;
    port.postMessage({ type: 'artifact', id, value: flight });
    entries.set(flight, { id, size }); bytes += size;
    return id;
  };
}
