'use strict';

const RedirectType = Object.freeze({ push: 'push', replace: 'replace' });
function redirectError(url, type, status) {
  if (typeof url !== 'string' || /[\r\n]/.test(url)) throw new TypeError('Invalid redirect destination');
  if (type !== 'push' && type !== 'replace') throw new TypeError('Invalid redirect type');
  const error = new Error('NEXT_REDIRECT');
  error.digest = `NEXT_REDIRECT;${type};${url};${status};`;
  return error;
}
function redirect(url, type = RedirectType.replace) { throw redirectError(url, type, 307); }
function permanentRedirect(url, type = RedirectType.replace) { throw redirectError(url, type, 308); }
function notFound() {
  const error = new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  error.digest = 'NEXT_HTTP_ERROR_FALLBACK;404';
  throw error;
}
function unstable_rethrow(error) {
  if (typeof error?.digest === 'string' &&
      (error.digest.startsWith('NEXT_REDIRECT;') || error.digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;'))) throw error;
}

module.exports.redirect = redirect;
module.exports.permanentRedirect = permanentRedirect;
module.exports.notFound = notFound;
module.exports.RedirectType = RedirectType;
module.exports.unstable_rethrow = unstable_rethrow;
