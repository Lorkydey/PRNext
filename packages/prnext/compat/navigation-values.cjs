'use strict';

// Route params contain only scalar strings and string arrays. Do not walk
// arbitrary application data or React/Flight values to stabilize navigation.
function equalParams(previous, next) {
  if (previous === next) return true;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return false;
  const a = Object.getOwnPropertyDescriptors(previous), b = Object.getOwnPropertyDescriptors(next);
  const keys = Object.keys(a);
  if (keys.length > 128 || keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key) || !Object.hasOwn(a[key], 'value') || !Object.hasOwn(b[key], 'value')) return false;
    const left = a[key].value, right = b[key].value;
    if (left === right) continue;
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length > 128) return false;
    for (let i = 0; i < left.length; i++) if (typeof left[i] !== 'string' || left[i] !== right[i]) return false;
  }
  return true;
}
module.exports = { equalParams };
