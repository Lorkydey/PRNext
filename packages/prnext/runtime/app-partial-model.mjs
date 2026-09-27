// Flight's lazy values are part of React's decoded model. Preserve their shape
// while replacing only the explicit request-data holes in a build-time tree.
// The official encoder produces all final wire IDs; no Flight rows are edited.
import { withSignal } from './stream-utils.mjs';
const LAZY = Symbol.for('react.lazy');
const ELEMENT = Symbol.for('react.transitional.element');
const POSTPONED = 'PRNEXT_PPR_DYNAMIC';
const HOLE = Symbol('PRNext partial hole');

export function isPartialHole(error) { return error?.digest === POSTPONED || error?.code === POSTPONED; }

export function boundedPartialFlight(source, limit = 16 * 1024 * 1024) {
  let size = 0, closed = false;
  const reader = source.getReader();
  async function close(reason, cancel = false) {
    if (closed) return;
    closed = true;
    try { if (cancel) await reader.cancel(reason); }
    finally { reader.releaseLock(); }
  }
  // A single reader keeps the same bound and backpressure without allocating a
  // TransformStream's second queue and pipe pump for every PPR continuation.
  return new ReadableStream({
    async pull(controller) {
      try {
        const {value, done} = await reader.read();
        if (closed) return;
        if (done) { await close(); controller.close(); return; }
        size += value.byteLength;
        if (size > limit) throw new Error('Partial live Flight exceeds the 16 MiB response limit');
        controller.enqueue(value);
      } catch (error) {
        if (closed) return;
        controller.error(error);
        try { await close(error, true); } catch { /* Keep the original stream failure. */ }
      }
    },
    cancel(reason) { return close(reason, true); },
  }, { highWaterMark: 0 });
}

export async function preparePartialModel(model, {signal} = {}) {
  const visited = new WeakSet();
  async function visit(value) {
    signal?.throwIfAborted();
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value instanceof Map) {
      await Promise.all([...value].flatMap(([key, item]) => [visit(key), visit(item)]));
      return;
    }
    if (value instanceof Set) { await Promise.all([...value].map(visit)); return; }
    if (value.$$typeof === LAZY || typeof value.then === 'function') {
      try { await visit(await unwrap(value, signal)); }
      catch (error) { if (!isPartialHole(error)) throw error; }
      return;
    }
    if (value.$$typeof === ELEMENT) {
      // Only modules present in the static model are imported. A dynamic hole
      // must not make us preload unrelated client modules from the whole app.
      if (value.type?.$$typeof === LAZY) await unwrap(value.type, signal);
      await visit(value.props);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) || prototype === Object.prototype || prototype === null) {
      await Promise.all(Object.values(value).map(visit));
    }
  }
  await visit(model);
}

function unwrap(value, signal) {
  for (;;) {
    signal?.throwIfAborted();
    if (value?.$$typeof === LAZY) {
      try { value = value._init(value._payload); }
      catch (error) {
        if (typeof error?.then !== 'function') throw error;
        return withSignal(error, signal).then(() => unwrap(value, signal));
      }
    } else if (value && typeof value.then === 'function') return withSignal(value, signal).then(result => unwrap(result, signal));
    else return value;
  }
}

function lazy(callback, onHole, suspended) {
  let status = 'uninitialized', value, promise;
  return { $$typeof: LAZY, _payload: {}, _init() {
    // Decoded static chunks are usually already ready. Do not allocate a
    // microtask/promise for each one, or traverse branches React never renders.
    if (status === 'uninitialized') {
      try {
        value = callback();
        if (value && typeof value.then === 'function') {
          status = 'pending';
          promise = Promise.resolve(value).then(result => { status = 'fulfilled'; value = result; }, error => { status = 'rejected'; value = error; });
        } else status = 'fulfilled';
      } catch (error) { status = 'rejected'; value = error; }
    }
    if (status === 'pending') throw promise;
    if (status === 'rejected') throw value;
    if (value === HOLE) { onHole(); throw suspended; }
    return value;
  } };
}

function patternParams(pattern, pathname) {
  const actual = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const values = {};
  for (const [index, segment] of pattern.split('/').filter(Boolean).entries()) {
    const match = /^\[\[?(\.\.\.)?([^\]]+)\]\]?$/.exec(segment);
    if (match && index < actual.length) values[match[2]] = match[1] ? actual.slice(index) : actual[index];
  }
  return values;
}

export function partialKeyMap(scopes = [], params = {}, pathname) {
  return new Map(scopes.map(({ key, prefix, suffix = '', names, pattern, segments }) => {
    const values = pattern && pathname ? patternParams(pattern, pathname) : params;
    if (segments) {
      const selected = segments.map(segment => {
        const match = /^\[\[?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(segment);
        return match ? Array.isArray(values[match[1]]) ? values[match[1]].join('/') : values[match[1]] : segment;
      }).filter(value => value !== undefined && !value.startsWith('@'));
      return [key, selected.join('/') || prefix + JSON.stringify(Object.fromEntries(names.filter(name => Object.hasOwn(values, name)).map(name => [name, values[name]]))) + suffix];
    }
    return [key, prefix + JSON.stringify(Object.fromEntries(names.filter(name => Object.hasOwn(values, name)).map(name => [name, values[name]]))) + suffix];
  }));
}

export function partialModel(model, { live, keyMap, reuse, onHole = () => {}, suspended = new Promise(() => {}) } = {}) {
  const seen = new WeakMap();
  const positions = new WeakMap();
  const at = (collection,index) => {
    let values=positions.get(collection);
    if(!values){values=[...collection.keys()];positions.set(collection,values);}
    return values[index];
  };
  const bindings = new Map((model.keyScopes || []).filter(scope => scope.liveProps?.length).map(scope => [scope.key, scope.liveProps]));
  const property = (getter, key) => {
    let ready = false, value;
    return () => {
      if (!ready) {
        const parent = unwrap(getter());
        value = parent && typeof parent.then === 'function' ? parent.then(item => item?.[key]) : parent?.[key];
        ready = true;
      }
      return value;
    };
  };
  function visit(value, current) {
    if (!value || typeof value !== 'object') return value;
    if (reuse?.(value)) return value;
    if (seen.has(value)) return seen.get(value);
    if (value.$$typeof === LAZY) {
      const hole = error => {
        if (!isPartialHole(error)) throw error;
        if (current) return unwrap(current());
        return HOLE;
      };
      const result=lazy(() => {
        try {
          const resolved = unwrap(value);
          return resolved && typeof resolved.then === 'function' ? resolved.then(item => visit(item, current), hole) : visit(resolved, current);
        } catch (error) { return hole(error); }
      }, onHole, suspended);
      seen.set(value,result);return result;
    }
    if (typeof value.then === 'function') {
      const result=Promise.resolve(value).then(
      result => visit(result, current), error => {
        if (!isPartialHole(error)) throw error;
        if (current) return unwrap(current());
        onHole();
        return suspended;
      },
      );
      seen.set(value,result);return result;
    }
    if (value instanceof Map || value instanceof Set) {
      if (seen.has(value)) return seen.get(value);
      const copy = value instanceof Map ? new Map() : new Set();
      seen.set(value, copy);
      let index = 0;
      for (const entry of value) {
        const position = index++;
        if (value instanceof Map) {
          const [key, item] = entry;
          const liveKey = current ? async () => at(await unwrap(await current()),position) : null;
          // Primitive keys stay stable even if the live Map changes order.
          const liveItem = current ? async () => {
            const map = await unwrap(await current());
            return map.get(key !== null && typeof key === 'object' ? await liveKey() : key);
          } : null;
          copy.set(visit(key, liveKey), visit(item, liveItem));
        } else {
          copy.add(visit(entry, current ? async () => at(await unwrap(await current()),position) : null));
        }
      }
      return copy;
    }
    // Dates, typed arrays and references retain their rich-data identities.
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && value.$$typeof !== ELEMENT && prototype !== Object.prototype && prototype !== null) return value;
    if (seen.has(value)) return seen.get(value);
    const copy = Array.isArray(value) ? [] : Object.create(prototype);
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      if (value.$$typeof === ELEMENT && key !== 'props') copy[key] = key === 'key' && keyMap?.has(value[key]) ? keyMap.get(value[key]) : value[key];
      else copy[key] = visit(value[key], current ? property(current, key) : null);
    }
    if (live && current && value.$$typeof === ELEMENT && bindings.has(value.key)) return lazy(async () => {
      const actual = await unwrap(await current());
      for (const name of bindings.get(value.key)) copy.props[name] = actual?.props?.[name];
      return copy;
    }, onHole, suspended);
    return copy;
  }
  const output = visit(model, live ? () => live : null);
  if (live) {
    // These describe the current navigation, not the build-time document.
    output.router = live.router;
    if (model.routing) output.routing = live.routing;
    delete output.keyScopes;
  }
  return output;
}
