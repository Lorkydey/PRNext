'use strict';
const { parseCookieHeader } = require('./cookies.cjs');
const { isDraftRequest, previewId, draftCookie } = require('./draft.cjs');
const NAME = '__next_preview_data';
function key(input) {
  const value = input.previewModeEncryptionKey || input.manifest?.previewModeEncryptionKey;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Preview Mode requires a build with an encryption key');
  return Buffer.from(value, 'hex');
}
function readPreviewData(input) {
  if (!isDraftRequest(input)) return false;
  const headers = input.headers instanceof Headers ? input.headers : new Headers(input.headers || {});
  const token = parseCookieHeader(headers.get('cookie')).get(NAME)?.value;
  if (!token) return {};
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
  try {
    const { createDecipheriv } = require('node:crypto');
    const data = Buffer.from(token, 'base64url');
    if (data.toString('base64url') !== token) return false;
    if (data.length < 29) return false;
    const cipher = createDecipheriv('aes-256-gcm', key(input), data.subarray(0, 12));
    cipher.setAAD(Buffer.from(previewId(input))); cipher.setAuthTag(data.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    if (payload.v !== 1 || !Object.hasOwn(payload, 'data') || (payload.expires !== null && (!Number.isFinite(payload.expires) || payload.expires <= Date.now()))) return false;
    return payload.data;
  } catch { return false; }
}
function previewCookies(input, data, { maxAge, path = '/' } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || /[;\r\n\0]/.test(path)) throw new TypeError('Preview cookie path must be an absolute cookie path');
  if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 2147483647)) throw new TypeError('Preview maxAge must be a nonnegative integer number of seconds');
  const json = JSON.stringify({ v: 1, data, expires: maxAge === undefined ? null : Date.now() + maxAge * 1000 });
  if (data === undefined || Buffer.byteLength(json) > 2048) throw new TypeError('Preview data must be JSON serializable and fit in its 2 KiB cookie');
  const { randomBytes, createCipheriv } = require('node:crypto');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(input), iv);
  cipher.setAAD(Buffer.from(previewId(input)));
  const body = Buffer.concat([cipher.update(json), cipher.final()]);
  const value = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  if (value.length > 2048) throw new TypeError('Encrypted preview data exceeds its 2 KiB cookie');
  const bypass = { ...draftCookie(input, true, { path }), ...(maxAge === undefined ? {} : { maxAge }) };
  return [bypass, { ...bypass, name: NAME, value }];
}
module.exports = { NAME, readPreviewData, previewCookies };
