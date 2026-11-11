'use strict';

const controls = require('./navigation-controls.cjs');

// Server Components may import redirect/notFound. Load the client context only
// when a client hook actually runs, since React's server build has no contexts.
function context(name) {
  const React = require('react');
  const contexts = require('./app-context.cjs');
  const value = React.useContext(contexts[name]);
  if (!value) throw new Error('App Router hooks must be used inside the PRNext App Router');
  return value;
}

function useRouter() {
  const React = require('react');
  const { AppRouterContext } = require('./next-app-router-context.cjs');
  const router = React.useContext(AppRouterContext);
  if (!router) throw new Error('App Router hooks must be used inside the PRNext App Router');
  return router;
}
function usePathname() { return context('PathnameContext').read(); }
function useSearchParams() { return context('SearchParamsContext').read(); }
function useParams() { return context('ParamsContext').read(); }
function useSelectedLayoutSegments(parallelRoutesKey = 'children') {
  const React = require('react');
  // Generic PPR cannot publish segment names whose params are still unknown.
  // The provider's getter postpones this hook only during that build phase.
  context('ParamsContext').read();
  const { LayoutContext } = require('./app-layout-context.cjs');
  const segments = React.useContext(LayoutContext);
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
