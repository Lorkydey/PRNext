/** Shared browser route matching; importing this never loads either router. */
export function matchPagePattern(pattern, pathname) {
  let segments;
  try { segments = pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent); }
  catch { return null; }
  if (segments.length === 1 && !segments[0]) segments = [];
  if (segments.some(segment => !segment || /[/\\\0]/.test(segment) || segment === '.' || segment === '..')) return null;
  const parts = pattern === '/' ? [] : pattern.split('/').slice(1), params = Object.create(null), rank = [];
  let index = 0;
  for (const part of parts) {
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(part);
    const catchall = /^\[\.\.\.([^\]]+)\]$/.exec(part);
    const parameter = /^\[([^\]]+)\]$/.exec(part);
    if (optional || catchall) {
      if (catchall && index === segments.length) return null;
      if (index !== segments.length) params[(optional || catchall)[1]] = segments.slice(index);
      index = segments.length; rank.push(optional ? 0 : 1);
    } else if (parameter) {
      if (index === segments.length) return null;
      params[parameter[1]] = segments[index++]; rank.push(2);
    } else {
      if (segments[index++] !== part) return null;
      rank.push(3);
    }
  }
  return index === segments.length ? { params, rank } : null;
}

export function isHtmlDocumentRoute(routes, pathname) {
  let winner;
  for (const route of routes || []) {
    const match = matchPagePattern(route.pattern, pathname);
    if (!match) continue;
    const rank = winner && (() => {
      for (let index = 0; index < Math.max(match.rank.length, winner.rank.length); index++) {
        const difference = (match.rank[index] ?? 4) - (winner.rank[index] ?? 4);
        if (difference) return difference;
      }
      return 0;
    })();
    if (!winner || rank > 0) winner = { ...match, route };
  }
  return winner?.route.htmlOnly === true;
}
