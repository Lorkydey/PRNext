// Route matching and navigation state do not need React or metadata rendering.
import { removeBasePath } from '../compat/paths.cjs';

// Only trusted route syntax is cached, never URLs, decoded parameters or request
// state. Bound the shared lookup's entry count and retained text/segments.
const patterns = new Map();
// Live manifest entries own their parsed syntax weakly. Large route tables must
// not churn the bounded cross-call cache once for every saved parallel slot.
// Their lifetime follows the existing manifest; no old manifest is retained.
// Re-read the pattern on each use so mutable development manifests stay live.
const routePatterns = new WeakMap();
let patternCharacters = 0, patternSegments = 0;
function compilePattern(pattern) {
  let compiled = patterns.get(pattern);
  if (compiled) return compiled;
  const segments = pattern.split('/').filter(Boolean);
  const kinds = new Uint8Array(segments.length);
  let score = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment[0] !== '[') { score += 6; continue; }
    score += segment.startsWith('[[...') ? 0 : segment.startsWith('[...') ? 1 : 3;
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
    if (optional || catchAll) {
      kinds[index] = optional ? 3 : 2;
      segments[index] = (optional || catchAll)[1];
    } else {
      const dynamic = /^\[([^\]]+)\]$/.exec(segment);
      if (dynamic) { kinds[index] = 1; segments[index] = dynamic[1]; }
    }
  }
  compiled = { segments, kinds, score, characters: pattern.length };
  if (pattern.length <= 2048 && segments.length <= 64) {
    while (patterns.size >= 1024 || patternCharacters + pattern.length > 128 * 1024 || patternSegments + segments.length > 8192) {
      const oldest = patterns.keys().next().value;
      const removed = patterns.get(oldest);
      patterns.delete(oldest);
      patternCharacters -= removed.characters;
      patternSegments -= removed.segments.length;
    }
    patterns.set(pattern, compiled);
    patternCharacters += pattern.length;
    patternSegments += segments.length;
  }
  return compiled;
}

function pathSegments(pathname) {
  const raw = pathname.split('/').filter(Boolean);
  try { return raw.map(decodeURIComponent); }
  catch { return null; }
}

function compiledRoute(route) {
  const pattern = route.pattern;
  const cached = routePatterns.get(route);
  if (cached && cached.pattern === pattern) return cached.compiled;
  const compiled = compilePattern(pattern);
  if (pattern.length <= 2048 && compiled.segments.length <= 64) routePatterns.set(route, { pattern, compiled });
  else routePatterns.delete(route);
  return compiled;
}

function matchesParts({ segments, kinds }, parts, prefix = false, params) {
  for (let index = 0; index < segments.length; index++) {
    const kind = kinds[index];
    if (kind >= 2) {
      if (kind === 2 && index >= parts.length) return false;
      if (params && index < parts.length) params[segments[index]] = parts.slice(index);
      return true;
    }
    if (index >= parts.length) return false;
    if (kind === 1) { if (params) params[segments[index]] = parts[index]; }
    else if (segments[index] !== parts[index]) return false;
  }
  return prefix || segments.length === parts.length;
}

export function matchAppPattern(pattern, pathname, prefix = false) {
  const compiled = compilePattern(pattern), parts = pathSegments(pathname);
  if (!parts) return null;
  const params = {};
  return matchesParts(compiled, parts, prefix, params) ? params : null;
}

/** Decode a request pathname once; each match still owns its parameter values. */
export function createAppMatcher(pathname) {
  const parts = pathSegments(pathname);
  return (pattern, prefix = false) => {
    const compiled = compilePattern(pattern);
    if (!parts) return null;
    const params = {};
    return matchesParts(compiled, parts, prefix, params) ? params : null;
  };
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
    const parts = pathSegments(pathname);
    if (!parts) continue;
    let route, bestScore = -1;
    for (let index = 0, length = routes.length; index < length; index++) {
      if (!(index in routes)) continue;
      const item = routes[index];
      if (item.router !== 'app' || item.kind !== 'page' || item.internal) continue;
      const compiled = compiledRoute(item);
      // The original stable sort kept the first route when scores were equal.
      // Lower-scoring routes cannot replace a match already found.
      if (compiled.score <= bestScore || !matchesParts(compiled, parts)) continue;
      route = item;
      bestScore = compiled.score;
    }
    if (route) modules.add(route.module);
  }
  return [...modules];
}
