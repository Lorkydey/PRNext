'use strict';
const { createHash } = require('node:crypto');
const { dynamicUsage, staticBailout, trackStaticDependency } = require('./static-generation.cjs');
const { cacheTag, cacheLife, recordCacheDependency } = require('./use-cache.cjs');
const {
  cachedValue, cacheState, runCacheScope, inCacheScope, optionalRequestContext,
  getCachePaths, normalizeCachePath, validateTags, validateRevalidate, queueInvalidation,
} = require('./data-cache.cjs');

function unstable_cache(callback, keyParts = [], options = {}) {
  if (typeof callback !== 'function') throw new TypeError('unstable_cache requires a function');
  if (!Array.isArray(keyParts) || keyParts.some(part => typeof part !== 'string')) throw new TypeError('unstable_cache keyParts must be an array of strings');
  const tags = validateTags(options.tags);
  const revalidate = validateRevalidate(options.revalidate === Infinity ? false : options.revalidate);
  const fixedKey = JSON.stringify([callback.toString(), keyParts]);
  return async function (...args) {
    const context = optionalRequestContext();
    trackStaticDependency({ tags, revalidate, paths: getCachePaths(context) }, context);
    recordCacheDependency({ tags, revalidate });
    // Nested calls must not wait on a lease already owned by their outer call.
    // A route's explicit force-no-store setting also prevents cached reads.
    if (inCacheScope() || context?.cacheConfig?.forceNoStore || context?.draftMode) {
      return runCacheScope(() => callback.apply(this, args));
    }
    const key = createHash('sha256').update(JSON.stringify(['unstable_cache', fixedKey, args])).digest('hex');
    let produced = false;
    let result;
    const bytes = await cachedValue(key, async ({ background }) => runCacheScope(async () => {
      const value = await callback.apply(this, args);
      const serialized = Buffer.from(JSON.stringify({ value }));
      if (!background) { produced = true; result = value; }
      return serialized;
    }), { tags, paths: getCachePaths(context), revalidate, context,
      incremental: {
        encode: bytes => { const { value } = JSON.parse(bytes.toString('utf8')); return { headers: {}, status: 200, url: '', body: JSON.stringify(value) ?? 'null', ...(value === undefined ? { _rustyxUndefined: true } : {}) }; },
        decode: entry => {
          if (typeof entry.data?.body !== 'string' || Buffer.byteLength(entry.data.body) > 2 * 1024 * 1024) throw new Error('Invalid incremental cached function data');
          return Buffer.from(JSON.stringify(entry.data._rustyxUndefined ? {} : { value: JSON.parse(entry.data.body) }));
        },
      },
      forceFresh: !context || context.phase === 'pages' || Boolean(context.staticState) });
    return produced ? result : JSON.parse(bytes.toString('utf8')).value;
  };
}

function mutationContext(name, actionOnly = false) {
  if (inCacheScope()) throw new Error(`${name} cannot be called inside unstable_cache`);
  const context = optionalRequestContext();
  if (!context || (actionOnly ? context.phase !== 'action' : !['action', 'route'].includes(context.phase))) {
    throw new Error(`${name} can only be called in ${actionOnly ? 'a Server Action' : 'a Server Action or Route Handler'}, outside rendering`);
  }
  if (context.cacheState?.closed) throw new Error(`${name} cannot be called after the response headers have been sent`);
  if (context.staticState) staticBailout(`${name}()`, context);
  return context;
}

// Only the expiration window is relevant to tag invalidation. Values match
// Next's built-in cacheLife profiles; custom next.config profiles are not yet read.
const expirations = Object.freeze({ default: null, seconds: 60, minutes: 3600, hours: 86400, days: 604800, weeks: 2592000, max: 31536000 });
function revalidateTag(tag, profile) {
  const context = mutationContext('revalidateTag');
  validateTags([tag]);
  let expire;
  if (profile === undefined) expire = 0;
  else if (typeof profile === 'string') {
    const configured = context.cacheLife || context.manifest?.config?.cacheLife;
    if (configured && Object.hasOwn(configured, profile)) expire = configured[profile].expire;
    else {
      if (!Object.hasOwn(expirations, profile)) throw new TypeError(`Unknown cache lifetime profile: ${profile}`);
      expire = expirations[profile];
    }
  } else if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    expire = profile.expire ?? null;
    if (expire !== null && (typeof expire !== 'number' || !Number.isFinite(expire) || expire < 0)) throw new TypeError('revalidateTag expire must be a nonnegative number of seconds');
  } else throw new TypeError('revalidateTag requires a cache profile name or an expire option');
  queueInvalidation(context, { tags: [tag], mode: expire === 0 ? 'expire' : 'stale', ...(expire === null ? {} : { expire }) });
}
function updateTag(tag) {
  const context = mutationContext('updateTag', true);
  validateTags([tag]);
  queueInvalidation(context, { tags: [tag], mode: 'expire' });
}
function revalidatePath(path, type) {
  const context = mutationContext('revalidatePath');
  if (type !== undefined && type !== 'page' && type !== 'layout') throw new TypeError('revalidatePath type must be page or layout');
  if (typeof path === 'string' && /\[[^/]+\]/.test(path) && !type) throw new TypeError('revalidatePath requires a page or layout type for dynamic paths');
  const normalized = normalizeCachePath(path, { groups: true });
  queueInvalidation(context, { paths: [`${type || 'page'}:${normalized}`], mode: 'expire' });
}
function unstable_noStore() {
  if (inCacheScope()) return;
  if (!dynamicUsage('unstable_noStore()')) return;
  const state = cacheState();
  if (state) state.noStore = true;
}
function refresh() { cacheState(mutationContext('refresh', true)).refresh = true; }

module.exports = { unstable_cache, revalidateTag, updateTag, revalidatePath, unstable_noStore, refresh, cacheTag, cacheLife };
