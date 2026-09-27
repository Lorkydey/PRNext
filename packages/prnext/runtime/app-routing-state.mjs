// Route matching and navigation state do not need React or metadata rendering.
import { removeBasePath } from '../compat/paths.cjs';

export function matchAppPattern(pattern, pathname, prefix = false) {
  const expected = pattern.split('/').filter(Boolean), raw = pathname.split('/').filter(Boolean);
  let parts;
  try { parts = raw.map(decodeURIComponent); } catch { return null; }
  const params = {};
  for (let index = 0; index < expected.length; index++) {
    const segment = expected[index];
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
    if (optional || catchAll) {
      if (catchAll && index >= parts.length) return null;
      if (index < parts.length) params[(optional || catchAll)[1]] = parts.slice(index);
      return params;
    }
    const dynamic = /^\[([^\]]+)\]$/.exec(segment);
    if (index >= parts.length) return null;
    if (dynamic) params[dynamic[1]] = parts[index];
    else if (segment !== parts[index]) return null;
  }
  return prefix || expected.length === parts.length ? params : null;
}

export function readRouterState(request) {
  if (!Object.entries(request.headers || {}).some(([name, value]) => name.toLowerCase() === 'rsc' && value === '1')) return null;
  const value = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'x-prnext-router-state')?.[1];
  if (typeof value !== 'string' || value.length > 24 * 1024) return null;
  try {
    const state = JSON.parse(value.startsWith('{') ? value : decodeURIComponent(value));
    const localURL = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(value) && value.length <= 4096;
    if (!state || typeof state !== 'object' || !localURL(state.source) || !state.slots || typeof state.slots !== 'object' || Array.isArray(state.slots) || Object.keys(state.slots).length > 256) return null;
    const slots = {};
    for (const [key, slot] of Object.entries(state.slots)) {
      if (key.length > 4096 || !slot || typeof slot.branch !== 'string' || slot.branch.length > 4096 || !localURL(slot.url)) return null;
      if (slot.source !== undefined && !localURL(slot.source)) return null;
      if (slot.accessUrl !== undefined && !localURL(slot.accessUrl)) return null;
      slots[key] = { branch: slot.branch, url: slot.url, ...(slot.source ? { source: slot.source } : {}), ...(slot.accessUrl ? { accessUrl: slot.accessUrl } : {}) };
    }
    return { source: removeBasePath(new URL(state.source, 'http://prnext.local').pathname, request.basePath), slots, restore: state.restore === true, refresh: state.refresh === true };
  } catch { return null; }
}

/** Resolve saved URLs only through the trusted build manifest, never to user-provided module paths. */
export function advancedRoutingSources(request, routes) {
  const state = readRouterState(request);
  if (!state) return [];
  const modules = new Set();
  for (const saved of Object.values(state.slots)) {
    const pathname = new URL(saved.url, 'http://prnext.local').pathname;
    const route = routes.filter(item => item.router === 'app' && item.kind === 'page' && !item.internal && matchAppPattern(item.pattern, pathname))
      .sort((a, b) => score(b.pattern) - score(a.pattern))[0];
    if (route) modules.add(route.module);
  }
  return [...modules];
}

function score(pattern) {
  return pattern.split('/').filter(Boolean).reduce((sum, value) => sum + (value.startsWith('[[...') ? 0 : value.startsWith('[...') ? 1 : value.startsWith('[') ? 3 : 6), 0);
}
