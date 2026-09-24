import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { CapturedResponse } from './http.mjs';

test('legacy Preview Mode authenticates data, expires, clears both cookies and separates builds', () => {
  const manifest = { previewModeId: 'preview-build', previewModeEncryptionKey: randomBytes(32).toString('hex') };
  const issue = (data, options) => runRequestContext({ manifest, production: false }, () => {
    const response = new CapturedResponse(); response.setPreviewData(data, options);
    assert.match(response.getHeader('cache-control'), /private.*no-store/);
    return response.getHeader('set-cookie');
  });
  const cookies = issue({ message: 'PRIVATE_PREVIEW', version: 2 }, { path: '/draft', maxAge: 60 });
  assert.equal(cookies.length, 2); assert.ok(cookies.every(value => /HttpOnly/.test(value) && /Path=\/draft/.test(value) && /Max-Age=60/.test(value)));
  assert.ok(cookies.every(value => !value.includes('PRIVATE_PREVIEW')));
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  const read = (header, build = manifest) => runRequestContext({ manifest: build, headers: { cookie: header } }, () => currentRequest().previewData);
  assert.deepEqual(read(cookie), { message: 'PRIVATE_PREVIEW', version: 2 });
  assert.equal(read(cookie + 'x'), false);
  assert.equal(read(cookie, { ...manifest, previewModeEncryptionKey: randomBytes(32).toString('hex') }), false);
  assert.equal(read(issue({ old: true }, { maxAge: 0 }).map(value => value.split(';')[0]).join('; ')), false);
  assert.throws(() => issue('x'.repeat(2048)), /2 KiB/);
  runRequestContext({ manifest }, () => { const response = new CapturedResponse(); response.clearPreviewData(); assert.equal(response.getHeader('set-cookie').length, 2); });
});
