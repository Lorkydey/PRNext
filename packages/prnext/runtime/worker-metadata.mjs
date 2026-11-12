import { clientChunk } from '../compat/client-chunk.cjs';
import { SieveCache } from '../compat/sieve-cache.cjs';

// Only build manifests belong here. Never register headers, models, closures or
// request contexts. Eviction is ordered on the same MessagePort as requests.
const immutableClientManifests = new WeakSet();

// Production build metadata comes from JSON and does not change until a new
// worker loads the next build. Only explicitly sealed maps can skip validation;
// callers using mutable manifests (including development) keep the old checks.
export function freezeClientModules(value) {
  if (!value || typeof value !== 'object') return value;
  if (immutableClientManifests.has(value)) return value;
  const entries = Object.getOwnPropertyDescriptors(value);
  // An accessor may change even on a frozen object. Do not trust such a map.
  if (!Object.values(entries).every(entry => Object.hasOwn(entry, 'value') &&
      entry.value && typeof entry.value === 'object' &&
      typeof Object.getOwnPropertyDescriptor(entry.value, 'ssrModule')?.value === 'string')) return value;
  for (const entry of Object.values(entries)) Object.freeze(entry.value);
  Object.freeze(value);
  immutableClientManifests.add(value);
  return value;
}

export function isImmutableClientModules(value) {
  return immutableClientManifests.has(value);
}

export function workerMetadata(port, limit = 32) {
  const entries = new SieveCache({ maxEntries: limit, onEvict: (_, id) => port.postMessage({ type: 'metadata-drop', id }) });
  let sequence = 0;
  return value => {
    if (!value || typeof value !== 'object') return undefined;
    let id = entries.get(value);
    if (id !== undefined) return id;
    id = ++sequence;
    if (!entries.set(value, id)) return undefined;
    try { port.postMessage({ type: 'metadata', id, value }); }
    catch (error) { try { entries.delete(value); } catch {} throw error; }
    return id;
  };
}

const bundlers = new WeakMap();
const empty = Object.freeze({});
export function flightBundler(clientModules = empty, browser = true, chunkReferences = false) {
  let pair = bundlers.get(clientModules);
  if (!pair) { pair = []; bundlers.set(clientModules, pair); }
  const slot = browser ? chunkReferences ? 2 : 1 : 0;
  if (!pair[slot]) pair[slot] = Object.fromEntries(Object.entries(clientModules).map(([id, item]) =>
    [id, { id, chunks: browser && item.browserModule ? [chunkReferences ? clientChunk(id, item.browserModule) : id, item.browserModule] : [], name: '*' }]));
  return pair[slot];
}
