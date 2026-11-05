import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationAuthorization, developmentNavigationSecret } from '../compat/navigation-authorization.cjs';
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
test('development navigation uses a separate purpose key and isolates restarted private sessions',()=>{
  const actionKey=Buffer.alloc(32,7).toString('base64'),secret=developmentNavigationSecret(actionKey);
  assert.match(secret,/^[a-f0-9]{64}$/);assert.notEqual(secret,actionKey);assert.equal(developmentNavigationSecret(actionKey),secret);
  assert.notEqual(developmentNavigationSecret(Buffer.alloc(32,8).toString('base64')),secret);
  assert.equal(developmentNavigationSecret(undefined),undefined);assert.equal(developmentNavigationSecret(''),undefined);
  runRequestContext({headers:{cookie:'session=one'}},()=>assert.notEqual(navigationAuthorization(currentRequest(),secret,['session']),navigationAuthorization(currentRequest(),actionKey,['session'])));
});
