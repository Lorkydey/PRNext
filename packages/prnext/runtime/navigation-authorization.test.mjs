import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationAuthorization } from '../compat/navigation-authorization.cjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';

const signature = (cookie, names, extra = {}) => runRequestContext({ headers: { cookie, ...extra } }, () => navigationAuthorization(currentRequest(), 'private-test-key', names));
test('credential identity is opaque, canonical and can isolate auth cookies from preferences', () => {
  assert.equal(signature('session=one; theme=dark'), signature('theme=dark; session=one'));
  assert.equal(signature('session=one; theme=dark', ['session']), signature('theme=light; session=one', ['session']));
  assert.notEqual(signature('session=one', ['session']), signature('session=two', ['session']));
  assert.notEqual(signature('', [], { authorization: 'Bearer a' }), signature('', [], { authorization: 'Bearer b' }));
  assert.match(signature('session=private'), /^[a-f0-9]{64}$/);
  runRequestContext({ staticGeneration: { partial: true } }, () => assert.equal(navigationAuthorization(currentRequest(), 'key'), undefined));
});
