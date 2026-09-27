'use strict';
const { parseCookieHeader } = require('./cookies.cjs');
const COOKIE_NAME = '__prerender_bypass';

function previewId(input) { return input.previewModeId || input.manifest?.previewModeId; }
// Native/Pages requests carry plain header records. Do not initialize Node's
// entire Web Request implementation just to check an absent preview cookie.
function cookieHeader(headers) {
  return typeof headers?.get === 'function' ? headers.get('cookie')
    : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
}
function isDraftRequest(input) {
  if (input.staticGeneration || input.staticState || input.renderMode === 'isr' || input.isFallback) return false;
  const id = previewId(input);
  if (!id) return false;
  const header = cookieHeader(input.headers);
  if (!header || !String(header).includes(COOKIE_NAME)) return false;
  return parseCookieHeader(header).get(COOKIE_NAME)?.value === id;
}
function draftCookie(input, enabled, { path = '/', keepValue = false } = {}) {
  const id = previewId(input);
  if (!id) throw new Error('Draft Mode requires a build with a previewModeId');
  return { name: COOKIE_NAME, value: enabled || keepValue ? id : '', path, httpOnly: true,
    sameSite: input.production === false || input.manifest?.dev ? 'lax' : 'none',
    secure: !(input.production === false || input.manifest?.dev),
    ...(!enabled ? { expires: new Date(0) } : {}) };
}
module.exports = { COOKIE_NAME, previewId, isDraftRequest, draftCookie, cookieHeader };
