'use strict';
const defaults = Object.freeze({
  default: { stale: 300, revalidate: 900, expire: 4294967294 },
  seconds: { stale: 30, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3600 },
  hours: { stale: 300, revalidate: 3600, expire: 86400 },
  days: { stale: 300, revalidate: 86400, expire: 604800 },
  weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
  max: { stale: 300, revalidate: 2592000, expire: 31536000 },
});
function validateLife(input, { partial = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('cacheLife requires a profile name or { stale, revalidate, expire }');
  const result = {};
  for (const key of Object.keys(input)) {
    if (!['stale', 'revalidate', 'expire'].includes(key)) throw new TypeError(`Unknown cacheLife option: ${key}`);
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4294967294) throw new TypeError(`cacheLife ${key} must be a nonnegative finite number of seconds`);
    result[key] = value;
  }
  if (!Object.keys(result).length || !partial && Object.keys(result).length !== 3) throw new TypeError('cacheLife profiles must specify their lifetime');
  if (result.expire !== undefined && result.revalidate !== undefined && result.expire < result.revalidate) throw new TypeError('cacheLife expire must be at least revalidate');
  return result;
}
function profiles(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('cacheLife configuration must be an object of profiles');
  const result = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { ...value }]));
  for (const [key, value] of Object.entries(input)) {
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid cacheLife profile name');
    result[key] = { ...(result[key] || defaults.default), ...validateLife(value) };
    validateLife(result[key], { partial: false });
  }
  return result;
}
module.exports = { defaults, validateLife, profiles };
