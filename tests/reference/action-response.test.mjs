import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSuccessfulActionBody } from './action-response.mjs';

test('a complete action root accepts an undefined result and a refreshed tree', () => {
  assert.doesNotThrow(() => assertSuccessfulActionBody(Buffer.from('1:I["client",[],"default"]\n0:{"tree":"$1","actionResult":"$undefined","actionError":"$undefined"}\n')));
});

test('action errors, referenced failures, redirects and unknown roots are never success', () => {
  for (const body of ['', '0:{"tree":"$1","actionError":{"message":"failed"}}\n', '0:{"tree":"$1","actionError":"$2"}\n', '0:{"tree":"$1","actionRedirect":{"url":"/other"}}\n', '0:{"tree":"$1"}\n1:E{"digest":"failure"}\n', '0:E{"digest":"failure"}\n', '0:{}\n', '0:[]\n']) {
    assert.throws(() => assertSuccessfulActionBody(Buffer.from(body)));
  }
});
