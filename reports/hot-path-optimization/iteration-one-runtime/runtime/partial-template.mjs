// Retain only replayable static values, never React decoder chunks (which can
// retain their response), streams, server functions or request contexts.
import { withSignal } from './stream-utils.mjs';
import { isPartialHole } from './app-partial-model.mjs';
const LAZY = Symbol.for('react.lazy');
const CLIENT = Symbol.for('react.client.reference');
const directModels = new WeakSet();
const values = new WeakMap();
const holes = new WeakSet();
const reusable = new WeakMap();
const holeError = Object.assign(new Error('Partial request data'), { digest: 'RUSTYX_PPR_DYNAMIC' });
function throwHole() { throw holeError; }
const holeLazy = () => { const value = { $$typeof: LAZY, _payload: {}, _init: throwHole }; holes.add(value); return value; };
class Unreplayable extends Error {}
// Factories at module scope cannot close over a snapshot's signal or decoder.
const readyLazy = value => { const copy = { $$typeof: LAZY, _payload: {}, _init() { return value; } }; values.set(copy, value); return copy; };
const readyPromise = value => { const copy = { then(resolve) { return resolve(value); } }; values.set(copy, value); return copy; };

// Only proven root replacements can consume the original React model directly.
// A nested hole needs the ordinary Flight decoder to locate a server component's
// rendered children. Cycles, bindings and advanced routing stay on that path.
function rootReplacementsOnly(model) {
  if (!model || Object.getPrototypeOf(model) !== Object.prototype || model.routing || model.keyScopes?.some(scope => scope.liveProps?.length)) return false;
  const seen = new WeakMap();
  function classify(value) {
    if (!value || typeof value !== 'object') return 'static';
    if (holes.has(value)) return 'hole';
    if (seen.has(value)) return seen.get(value);
    seen.set(value, 'nested');
    let result;
    if (values.has(value)) result = classify(values.get(value));
    else {
      const children = value instanceof Map ? [...value].flat() : value instanceof Set ? [...value] : Object.values(value);
      result = children.every(child => classify(child) === 'static') ? 'static' : 'nested';
    }
    seen.set(value, result); return result;
  }
  return Object.values(model).every(value => classify(value) !== 'nested');
}

export function canResumePartialDirectly(model) { return directModels.has(model); }

// Classify static subtrees once, while no request exists. A subtree with a hole,
// a live prop binding or a cycle must be copied/merged in the ordinary way.
// Key remapping is decided per navigation, without retaining its request here.
function classifyReusable(model) {
  const entries = new WeakMap();
  const bindings = new Set((model.keyScopes || []).filter(scope => scope.liveProps?.length).map(scope => scope.key));
  const empty = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return empty;
    if (entries.has(value)) return entries.get(value);
    entries.set(value, null);
    if (holes.has(value) || value.$$typeof === Symbol.for('react.transitional.element') && bindings.has(value.key)) return null;
    const children = values.has(value) ? [values.get(value)] : value instanceof Map ? [...value].flat() : value instanceof Set ? [...value] : Object.values(value);
    const keys = new Set(value.$$typeof === Symbol.for('react.transitional.element') && value.key !== null ? [value.key] : []);
    let stable = true;
    for (const child of children) {
      const nested = visit(child);
      if (nested === null) stable = false;
      else for (const key of nested) keys.add(key);
    }
    const result = stable ? keys.size ? [...keys] : empty : null;
    entries.set(value, result);
    return result;
  }
  visit(model);
  return entries;
}
export function partialTemplateReuse(model, keyMap) {
  const entries = reusable.get(model);
  if (!entries) return undefined;
  return value => {
    if (value === model) return false; // The root receives this request's router.
    const keys = entries.get(value);
    return keys !== undefined && keys !== null && (!keyMap?.size || keys.every(key => !keyMap.has(key)));
  };
}

export async function snapshotPartialTemplate(model, signal) {
  const seen = new WeakMap();
  let nodes = 0;
  async function visit(value, depth = 0) {
    signal?.throwIfAborted();
    if (typeof value === 'function') {
      if (value.$$typeof === CLIENT) return { value };
      throw new Unreplayable('Function retains decoder state');
    }
    if (!value || typeof value !== 'object') return { value };
    if (seen.has(value)) {
      const copy = seen.get(value);
      if (copy === undefined) throw new Unreplayable('Unresolved lazy cycle');
      return { value: copy };
    }
    if (++nodes > 4096 || depth > 128) throw new Unreplayable('Template complexity limit');
    seen.set(value, undefined);
    if (value.$$typeof === LAZY || typeof value.then === 'function') {
      let resolved;
      try {
        if (value.$$typeof === LAZY) {
          for (;;) {
            signal?.throwIfAborted();
            try { resolved = value._init(value._payload); break; }
            catch (error) { if (typeof error?.then !== 'function') throw error; await withSignal(error, signal); }
          }
        } else resolved = await withSignal(value, signal);
      } catch (error) {
        if (!isPartialHole(error)) throw new Unreplayable('Errored static value');
        const copy = value.$$typeof === LAZY ? holeLazy() : { then: rejectHole };
        holes.add(copy);
        seen.set(value, copy); return { value: copy };
      }
      const resolvedCopy = (await visit(resolved, depth + 1)).value;
      const copy = value.$$typeof === LAZY ? readyLazy(resolvedCopy) : readyPromise(resolvedCopy);
      seen.set(value, copy); return { value: copy };
    }
    let copy;
    if (value instanceof Date) copy = new Date(value);
    else if (value instanceof ArrayBuffer) copy = value.slice(0);
    else if (ArrayBuffer.isView(value)) throw new Unreplayable('Keep typed-array backing identities in the ordinary decoder');
    else if (value instanceof Map) copy = new Map();
    else if (value instanceof Set) copy = new Set();
    else if (Array.isArray(value)) copy = [];
    else if ([Object.prototype, null].includes(Object.getPrototypeOf(value))) copy = Object.create(Object.getPrototypeOf(value));
    else throw new Unreplayable('Stream or non-replayable prototype');
    seen.set(value, copy);
    if (value instanceof Map) for (const [key, item] of value) copy.set((await visit(key, depth + 1)).value, (await visit(item, depth + 1)).value);
    else if (value instanceof Set) for (const item of value) copy.add((await visit(item, depth + 1)).value);
    else if (!(value instanceof Date) && !(value instanceof ArrayBuffer)) for (const key of Object.keys(value)) Object.defineProperty(copy, key, { value: (await visit(value[key], depth + 1)).value, enumerable: true, writable: true, configurable: true });
    // Box thenables so this async walk does not accidentally assimilate them.
    return { value: copy };
  }
  const copy = (await visit(model)).value;
  if (rootReplacementsOnly(copy)) directModels.add(copy);
  if (copy && typeof copy === 'object') reusable.set(copy, classifyReusable(copy));
  return { model: copy, nodes };
}
function rejectHole(_resolve, reject) { return reject(holeError); }

export class PartialTemplates {
  constructor({ maxEntries = 8, maxBytes = 512 * 1024, maxWireBytes = 64 * 1024 } = {}) {
    this.entries = new Map(); this.bytes = 0;
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.maxWireBytes = maxWireBytes;
  }
  async get(flight, consumer, decode, signal) {
    const previous = this.entries.get(flight);
    if (previous && previous.moduleMap === consumer.moduleMap && previous.serverModuleMap === consumer.serverModuleMap) {
      this.entries.delete(flight); this.entries.set(flight, previous);
      return previous.bypass ? decode() : previous.model;
    }
    const decoded = await decode();
    if (flight.length > this.maxWireBytes || this.maxEntries === 0) return decoded;
    let snapshot;
    try { snapshot = await snapshotPartialTemplate(decoded, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof Unreplayable)) throw error;
      snapshot = { nodes: 0, bypass: true };
    }
    // Budget the encoded string conservatively plus a per-node allowance.
    // This is a retention policy, not a promise about V8's exact heap size.
    const size = flight.length * 2 + snapshot.nodes * 128;
    if (size > this.maxBytes) return decoded;
    const old = this.entries.get(flight);
    if (old) { this.entries.delete(flight); this.bytes -= old.size; }
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + size > this.maxBytes)) {
      const [key, entry] = this.entries.entries().next().value;
      this.entries.delete(key); this.bytes -= entry.size;
    }
    this.entries.set(flight, { moduleMap: consumer.moduleMap, serverModuleMap: consumer.serverModuleMap, model: snapshot.model, bypass: snapshot.bypass, size });
    this.bytes += size;
    return snapshot.bypass ? decoded : snapshot.model;
  }
}
