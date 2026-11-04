import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSuccessfulActionBody, assertRevokedActionResponse } from './action-response.mjs';

test('a complete action root accepts an undefined result and a refreshed tree', () => {
  assert.doesNotThrow(() => assertSuccessfulActionBody(Buffer.from('1:I["client",[],"default"]\n0:{"tree":"$1","actionResult":"$undefined","actionError":"$undefined"}\n')));
});

test('revoked mutation evidence requires explicit authentication denial, never an idempotent no-op success',()=>{
  const options={status:200,origin:'https://127.0.0.1:4433',signInPath:'/en/sign-in'};
  assert.doesNotThrow(()=>assertRevokedActionResponse({...options,body:Buffer.from('0:{"actionResult":{"error":"authentication"}}\n')}));
  for(const outcome of [{saved:true,replayed:true},{saved:true},{error:'failed'},null]){
    assert.throws(()=>assertRevokedActionResponse({...options,body:Buffer.from('0:'+JSON.stringify({actionResult:outcome})+'\n')}),/authentication/);
  }
  assert.doesNotThrow(()=>assertRevokedActionResponse({...options,status:307,headers:{location:'/en/sign-in'}}));
  assert.doesNotThrow(()=>assertRevokedActionResponse({...options,body:Buffer.from('0:{"actionRedirect":{"url":"/en/sign-in"}}\n')}));
  assert.throws(()=>assertRevokedActionResponse({...options,body:Buffer.from('0:{"actionRedirect":{"url":"/en/sign-in"}}\n1:E{"digest":"failed"}\n')}),/rendering failure/);
  for(const location of [undefined,'https://attacker.test/en/sign-in','/en/dashboard'])assert.throws(()=>assertRevokedActionResponse({...options,status:307,headers:{location}}));
});

test('action errors, referenced failures, redirects and unknown roots are never success', () => {
  for (const body of ['', '0:{"tree":"$1","actionError":{"message":"failed"}}\n', '0:{"tree":"$1","actionError":"$2"}\n', '0:{"tree":"$1","actionRedirect":{"url":"/other"}}\n', '0:{"tree":"$1"}\n1:E{"digest":"failure"}\n', '0:E{"digest":"failure"}\n', '0:{}\n', '0:[]\n']) {
    assert.throws(() => assertSuccessfulActionBody(Buffer.from(body)));
  }
});
