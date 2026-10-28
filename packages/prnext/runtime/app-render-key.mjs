// Local counters can repeat in independent prerender processes. Cached Flight
// must not give different documents the same error/navigation reset identity.
export function renderKeyFor(request, id) {
  return JSON.stringify([new URL(request.originalUrl || request.url || 'http://localhost/').pathname, id]);
}
