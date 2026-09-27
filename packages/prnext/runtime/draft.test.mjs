import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRequestContext, currentRequest, draftMode } from '../compat/headers.cjs';
import { unstable_cache } from '../compat/cache.cjs';
import { CapturedResponse } from './http.mjs';

const previewModeId = '0123456789abcdef0123456789abcdef';
test('Draft Mode is build-scoped, isolated, and reads do not opt static pages out of caching', async () => {
  await Promise.all([previewModeId, 'wrong', ''].map(value => runRequestContext({ previewModeId, headers: { cookie: `__prerender_bypass=${value}` } }, async () => {
    await Promise.resolve();
    assert.equal((await draftMode()).isEnabled, value === previewModeId);
    assert.equal(await draftMode(), await draftMode());
  })));
  await runRequestContext({ previewModeId, staticGeneration: { mode: 'auto' }, headers: { cookie: `__prerender_bypass=${previewModeId}` } }, async () => {
    assert.equal((await draftMode()).isEnabled, false);
    assert.equal(currentRequest().staticState.error, null);
    assert.throws(() => (currentRequest().draftProvider).enable(), { code: 'PRNEXT_DYNAMIC_SERVER_USAGE' });
  });
  await assert.rejects(draftMode(), /while handling/);
});
test('Draft Mode mutations use protected session cookies and respect render and cache scopes', async () => {
  await runRequestContext({ previewModeId, phase: 'route', mutableCookies: true, production: true }, async () => {
    const draft = await draftMode();
    draft.enable();
    assert.equal(draft.isEnabled, true);
    assert.match([...currentRequest().outgoingCookies.values()][0], /HttpOnly; Secure; SameSite=None/);
    draft.disable();
    assert.equal(draft.isEnabled, false);
    assert.match([...currentRequest().outgoingCookies.values()][0], /^__prerender_bypass=;.*Expires=Thu, 01 Jan 1970/);
    assert.equal(currentRequest().draftChanged, true);
    await assert.rejects(unstable_cache(async () => (await draftMode()).enable())(), /inside unstable_cache/);
  });
  await runRequestContext({ previewModeId, phase: 'render' }, async () => {
    assert.throws((await draftMode()).enable, /Route Handler or Server Action/);
  });
  await runRequestContext({ previewModeId, phase: 'route', mutableCookies: true, production: false }, async () => {
    (await draftMode()).enable();
    assert.match([...currentRequest().outgoingCookies.values()][0], /SameSite=Lax/);
    assert.doesNotMatch([...currentRequest().outgoingCookies.values()][0], /Secure/);
  });
});
test('Pages draft response helpers preserve cookies and reject changes after sending headers', () => {
  runRequestContext({ previewModeId, production: true }, () => {
    const response = new CapturedResponse();
    response.setHeader('set-cookie', 'other=1');
    assert.equal(response.setDraftMode({ enable: true }), response);
    assert.deepEqual(response.getHeader('set-cookie'), ['other=1', `__prerender_bypass=${previewModeId}; Path=/; HttpOnly; Secure; SameSite=None`]);
    response.clearPreviewData({ path: '/preview' });
    assert.match(response.getHeader('set-cookie')[2], /Path=\/preview; Expires=/);
    response.flushHeaders();
    assert.throws(() => response.setDraftMode({ enable: false }), /after they are sent/);
  });
});
