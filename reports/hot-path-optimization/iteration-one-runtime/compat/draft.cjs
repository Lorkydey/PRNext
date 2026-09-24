'use strict';
const { parseCookieHeader } = require('./cookies.cjs');
const COOKIE_NAME = '__prerender_bypass';

function previewId(input) { return input.previewModeId || input.manifest?.previewModeId; }
function isDraftRequest(input) {
  if (input.staticGeneration || input.staticState || input.renderMode === 'isr' || input.isFallback) return false;
  const id = previewId(input);
  if (!id) return false;
  const header = input.headers instanceof Headers ? input.headers.get('cookie')
    : Object.entries(input.headers || {}).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
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
module.exports = { COOKIE_NAME, previewId, isDraftRequest, draftCookie };
