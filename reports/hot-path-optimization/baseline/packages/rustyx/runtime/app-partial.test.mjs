import test from 'node:test';
import assert from 'node:assert/strict';
import { prerenderPartialHtml } from './app-partial.mjs';

test('partial prerender deadline includes unresolved promises while preparing collection props',async()=>{
  const model={router:{},tree:new Map([['pending',new Promise(()=>{})]])};
  await assert.rejects(prerenderPartialHtml(model,{}, {timeoutMs:20}), /Partial prerender timed out/);
});
