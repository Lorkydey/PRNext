'use strict';

const controls = require('./navigation-controls.cjs');
const { currentRequest } = require('./headers.cjs');
function clientHook(name) {
  return function () { throw new Error(`${name} is a Client Component hook. Add "use client" to the component that calls it.`); };
}
module.exports.useRouter = clientHook('useRouter');
module.exports.usePathname = clientHook('usePathname');
module.exports.useSearchParams = clientHook('useSearchParams');
module.exports.useParams = clientHook('useParams');
module.exports.useSelectedLayoutSegment = clientHook('useSelectedLayoutSegment');
module.exports.useSelectedLayoutSegments = clientHook('useSelectedLayoutSegments');
module.exports.redirect = function redirect(url, type) {
  if (type == null) {
    let action = false;
    try { action = Boolean(currentRequest().action); } catch { /* Calls outside a request keep the render default. */ }
    type = action ? controls.RedirectType.push : controls.RedirectType.replace;
  }
  return controls.redirect(url, type);
};
module.exports.permanentRedirect = controls.permanentRedirect;
module.exports.notFound = controls.notFound;
module.exports.RedirectType = controls.RedirectType;
module.exports.unstable_rethrow = controls.unstable_rethrow;
