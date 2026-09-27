'use strict';
const { createHash } = require('node:crypto');
const { serialize, deserialize } = require('node:v8');
const { cachedValue, currentCacheScope, runCacheScope, optionalRequestContext, getCachePaths, validateTags } = require('./data-cache.cjs');
const { trackStaticDependency, dynamicUsage } = require('./static-generation.cjs');
const { defaults, validateLife } = require('./cache-life.cjs');
const { configured, customCachedValue } = require('./cache-handlers.cjs');
const codecSymbol = Symbol.for('prnext.cache-components-codec');
const MAX_BYTES = 2 * 1024 * 1024;

function scopeFor(name) {
  const scope = currentCacheScope();
  if (!scope || scope === true) throw new Error(`${name}() can only be called inside a 'use cache' function`);
  return scope;
}
function cacheTag(...tags) {
  const scope = scopeFor('cacheTag');
  scope.tags = new Set(validateTags([...new Set([...scope.tags, ...validateTags(tags)])]));
}
function cacheLife(profile) {
  const scope = scopeFor('cacheLife');
  const value = typeof profile === 'string' ? scope.profiles[profile] : profile;
  if (value === undefined) throw new TypeError(`Unknown cache lifetime profile: ${profile}`);
  const valid = validateLife(value);
  for (const [name, value] of Object.entries(valid)) {
    scope.life[name] = scope.explicit.has(name) ? Math.min(scope.life[name], value) : value;
    scope.explicit.add(name);
  }
}
function recordCacheDependency({ tags = [], revalidate } = {}) {
  const scope = currentCacheScope();
  if (!scope || scope === true) return;
  scope.tags = new Set(validateTags([...new Set([...scope.tags, ...validateTags(tags)])]));
  if (typeof revalidate === 'number' && Number.isFinite(revalidate) && revalidate >= 0 && !scope.explicit.has('revalidate')) scope.life.revalidate = Math.min(scope.life.revalidate, revalidate);
}
function metadata(scope, context) { return { ...scope.life, revalidate: Math.min(scope.life.revalidate, scope.life.expire), tags: [...scope.tags], paths: getCachePaths(context), ...(scope.externalCache ? { externalCache: true } : {}) }; }
function propagate(info, parent, context) {
  trackStaticDependency(info, context);
  if (!parent || parent === true) return;
  if (info.externalCache) parent.externalCache = true;
  for (const tag of info.tags) parent.tags.add(tag);
  validateTags([...parent.tags]);
  for (const name of ['stale', 'revalidate', 'expire']) if (!parent.explicit.has(name)) parent.life[name] = Math.min(parent.life[name], info[name]);
}
function envelope(info, value) {
  const header = Buffer.from(JSON.stringify(info));
  const result = Buffer.allocUnsafe(4 + header.length + value.length);
  result.writeUInt32BE(header.length); header.copy(result, 4); value.copy(result, 4 + header.length);
  return result;
}
function unpack(bytes) {
  if (bytes.length < 4 || bytes.readUInt32BE(0) > 64 * 1024 || 4 + bytes.readUInt32BE(0) > bytes.length) throw new Error('Invalid Cache Components entry');
  const end = 4 + bytes.readUInt32BE(0);
  return { metadata: JSON.parse(bytes.subarray(4, end).toString()), value: bytes.subarray(end) };
}
function serializeData(value) {
  const seen = new Set();
  function validate(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
    if (value instanceof Map) { for (const [key, item] of value) { validate(key); validate(item); } return; }
    if (value instanceof Set) { for (const item of value) validate(item); return; }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError("'use cache' only supports serializable data; class instances are not supported");
    for (const key of Object.keys(value)) validate(value[key]);
  }
  validate(value);
  return serialize(value);
}
const plainCodec = {
  async arguments(values) { const bytes = serializeData(values); return { key: bytes, values: deserialize(bytes) }; },
  async render(callback) { return serializeData(await callback()); },
  async decode(bytes) { return deserialize(bytes); },
};

async function invokeCache(id, kind, captures, args, callback, segment = '') {
  const context = optionalRequestContext();
  if (!context) throw new Error("'use cache' requires an active PRNext request or build render");
  const parent = currentCacheScope();
  if (kind === 'private' && parent && parent.kind !== 'private') throw new Error("'use cache: private' cannot be nested inside a shared cache");
  if (kind === 'private') dynamicUsage("'use cache: private'", context);
  const codec = globalThis[codecSymbol] || plainCodec;
  if (segment === 'page' && kind !== 'private' && args[0]) {
    const { searchParams: ignored, ...props } = args[0];
    args = [props, ...args.slice(1)];
  }
  const encoded = await codec.arguments([captures, args], context);
  if (segment === 'page' && kind !== 'private' && encoded.values[1][0]) encoded.values[1][0].searchParams = {
    then(_resolve, reject) { reject(new Error("searchParams cannot be read inside 'use cache'; read them outside and pass their values as arguments")); },
  };
  if (encoded.key.length > MAX_BYTES) throw new Error("'use cache' arguments exceed 2 MiB");
  const key = createHash('sha256').update(id).update(kind).update(codec === plainCodec ? ':v8:' : ':flight:').update(encoded.key).digest('hex');
  const profiles = context.cacheLife || context.manifest?.config?.cacheLife || defaults;
  const scope = { kind, profiles, life: { ...profiles.default }, explicit: new Set(), tags: new Set() };
  let producedMetadata;
  const producer = async () => runCacheScope(async () => {
    const value = await codec.render(() => callback(...encoded.values), encoded, context);
    producedMetadata = metadata(scope, context);
    return envelope(producedMetadata, Buffer.from(value));
  }, scope);
  let bytes, handlerMetadata;
  const custom = kind !== 'private' && !context.draftMode && Object.hasOwn(configured(context), kind);
  if (custom) {
    scope.externalCache = true;
    if (context.staticState) context.staticState.externalCache = true;
    bytes = await customCachedValue(key, kind, producer, { context, resolveMetadata: () => producedMetadata, onReadMetadata: value => { handlerMetadata = value; } });
  } else if (kind === 'private' || context.draftMode || !process.env.PRNEXT_CACHE_URL) {
    // Private entries are confined to this request, never persisted or shared.
    const entries = context.privateCache ||= new Map();
    if (!entries.has(key)) {
      const pending = producer();
      if (entries.size < 128) {
        entries.set(key, pending);
        void pending.then(bytes => {
          const total = (context.privateCacheBytes || 0) + bytes.length;
          if (total > 8 * 1024 * 1024) entries.delete(key); else context.privateCacheBytes = total;
        }, () => entries.delete(key));
      }
      bytes = await pending;
    } else bytes = await entries.get(key);
  } else bytes = await cachedValue(key, producer, { context, tags: [], paths: getCachePaths(context),
    signal: context.signal, resolveMetadata: () => producedMetadata, forceFresh: Boolean(context.staticState) });
  const result = unpack(bytes);
  if (handlerMetadata) Object.assign(result.metadata, handlerMetadata, { externalCache: true });
  propagate(result.metadata, parent, context);
  return codec.decode(result.value, encoded, context);
}
module.exports = { invokeCache, cacheTag, cacheLife, recordCacheDependency, codecSymbol };
