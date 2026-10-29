import {assertHtmlOnlyDocument} from '../runtime/html-only.mjs';
const MAX_PATTERNS = 128;

export function validateHtmlOnly(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PATTERNS) throw new TypeError('htmlOnly must be an array of at most 128 App route patterns.');
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.length > 512 || !pattern.startsWith('/') || pattern.startsWith('//') ||
        /[\s\\?#\u0000-\u001f\u007f]/.test(pattern) || /%(?![\da-f]{2})/i.test(pattern)) throw new TypeError('htmlOnly entries must be clean absolute route patterns without queries, fragments, whitespace or backslashes.');
    const pathname = pattern.endsWith('/**') ? pattern.slice(0, -3) || '/' : pattern;
    if (pathname.includes('*') || (pathname !== '/' && pathname.endsWith('/')) || pathname.slice(1).includes('//')) throw new TypeError('htmlOnly supports exact registered route patterns and a final /** subtree suffix only.');
    for (const segment of pathname.split('/').slice(1)) {
      let decoded;
      try { decoded = decodeURIComponent(segment); } catch { throw new TypeError('htmlOnly patterns must use valid URL encoding.'); }
      if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) throw new TypeError('htmlOnly patterns cannot contain dot segments or encoded path separators.');
    }
  }
  return [...new Set(value)];
}

export function matchesHtmlOnly(pattern, routePattern) {
  if (!pattern.endsWith('/**')) return pattern === routePattern;
  const prefix = pattern.slice(0, -3);
  return !prefix || routePattern === prefix || routePattern.startsWith(prefix + '/');
}

export function selectHtmlOnlyRoutes(routes, patterns, { cacheComponents = false } = {}) {
  const selected = new Set();
  for (const pattern of validateHtmlOnly(patterns)) {
    const matches = routes.filter(route => !route.internal && matchesHtmlOnly(pattern, route.pattern));
    if (!matches.length) throw new Error(`htmlOnly pattern ${JSON.stringify(pattern)} does not match a registered route.`);
    for (const route of matches) {
      if (route.router !== 'app' || route.kind !== 'page') throw new Error(`htmlOnly route ${route.pattern} must be an App Router page; Pages Router and Route Handlers are not supported.`);
      const config = route.cacheConfig || {};
      if (cacheComponents || config.runtime === 'edge' || config.dynamic === 'force-dynamic' || config.forceNoStore || (config.revalidate !== undefined && config.revalidate !== false)) {
        throw new Error(`htmlOnly route ${route.pattern} must be fully prerendered without Edge, Cache Components/PPR, dynamic rendering or ISR.`);
      }
      if (route.parallel || route.interception) throw new Error(`htmlOnly route ${route.pattern} does not support parallel or intercepted routing.`);
      if (route.pattern.includes('[') && config.dynamicParams !== false) throw new Error(`htmlOnly route ${route.pattern} requires dynamicParams: false and complete generateStaticParams results.`);
      selected.add(route.id);
    }
  }
  return selected;
}

export function validateHtmlOnlyPrerender(route, rendered) {
  if (!route.htmlOnly) return;
  if (rendered.dynamic || rendered.partial || rendered.revalidate !== false || (rendered.status ?? 200) !== 200) {
    throw new Error(`htmlOnly route ${route.pattern} must produce a complete successful static HTML document without dynamic data, partial rendering, redirects or ISR.`);
  }
  const html = Buffer.isBuffer(rendered.body) ? rendered.body.toString('utf8') : rendered.body;
  assertHtmlOnlyDocument(html, route.pattern);
}
