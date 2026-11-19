'use strict';

const controls = require('./navigation-controls.cjs');

// Server Components may import redirect/notFound. Load the client context only
// when a client hook actually runs, since React's server build has no contexts.
// Cache module references, never values from the current React render.
let useContext;
let contexts;
let routerContext;
let layoutContext;
function context(name) {
  useContext ??= require('react').useContext;
  contexts ??= require('./app-context.cjs');
  const value = useContext(contexts[name]);
  if (!value) throw new Error('App Router hooks must be used inside the PRNext App Router');
  return value;
}

function useRouter() {
  useContext ??= require('react').useContext;
  routerContext ??= require('./next-app-router-context.cjs').AppRouterContext;
  const router = useContext(routerContext);
  if (!router) throw new Error('App Router hooks must be used inside the PRNext App Router');
  return router;
}
function usePathname() { return context('PathnameContext').read(); }
function useSearchParams() { return context('SearchParamsContext').read(); }
function useParams() { return context('ParamsContext').read(); }
function useSelectedLayoutSegments(parallelRoutesKey = 'children') {
  // Generic PPR cannot publish segment names whose params are still unknown.
  // The provider's getter postpones this hook only during that build phase.
  context('ParamsContext').read();
  layoutContext ??= require('./app-layout-context.cjs').LayoutContext;
  const segments = useContext(layoutContext);
  return segments[parallelRoutesKey] || [];
}
function useSelectedLayoutSegment(parallelRoutesKey = 'children') {
  const segments = useSelectedLayoutSegments(parallelRoutesKey);
  return (parallelRoutesKey === 'children' ? segments[0] : segments.at(-1)) ?? null;
}

class ReadonlyURLSearchParams extends URLSearchParams {
  append() { throw new TypeError('ReadonlyURLSearchParams cannot be modified'); }
  delete() { throw new TypeError('ReadonlyURLSearchParams cannot be modified'); }
  set() { throw new TypeError('ReadonlyURLSearchParams cannot be modified'); }
  sort() { throw new TypeError('ReadonlyURLSearchParams cannot be modified'); }
}

module.exports.useRouter = useRouter;
module.exports.usePathname = usePathname;
module.exports.useSearchParams = useSearchParams;
module.exports.useParams = useParams;
module.exports.useSelectedLayoutSegment = useSelectedLayoutSegment;
module.exports.useSelectedLayoutSegments = useSelectedLayoutSegments;
module.exports.ReadonlyURLSearchParams = ReadonlyURLSearchParams;
module.exports.redirect = controls.redirect;
module.exports.permanentRedirect = controls.permanentRedirect;
module.exports.notFound = controls.notFound;
module.exports.RedirectType = controls.RedirectType;
module.exports.unstable_rethrow = controls.unstable_rethrow;
module.exports.useServerInsertedHTML = function(callback) { return require('./server-inserted-html.cjs').useServerInsertedHTML(callback); };
