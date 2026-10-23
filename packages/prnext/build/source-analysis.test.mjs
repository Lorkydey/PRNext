import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSource,sourceAnalysisStats} from './source-analysis.mjs';
test('Rust source analysis shares read-only parses and handles TS, JSX, directives and imports',()=>{
  const source=`'use client';import type {T} from 'types';import x from 'x';export type {Y} from 'other-types';export {z} from 'z';const c=<div/>;import('lazy');require('required');require(variable);`;
  const before=sourceAnalysisStats(),first=analyzeSource(source,'sample.tsx');
  assert.deepEqual(first.directives,['use client']);assert.equal(first.frameworkBoundary,true);assert.equal(first.computedRequire,true);
  assert.deepEqual(first.imports.map(item=>item.path).sort(),['lazy','required','x','z']);
  assert.equal(analyzeSource(source,'sample.tsx'),first);assert.equal(sourceAnalysisStats().hits,before.hits+1);
  assert.notEqual(analyzeSource(source+';export const n=2','sample.tsx'),first);
  assert.throws(()=>analyzeSource('export const =','broken.js'),/broken.js/);
});
test('directives inside functions and strings do not create framework boundaries',()=>{
  assert.equal(analyzeSource(`const text='use client';function f(){'use server';return 1}`,'plain.js').frameworkBoundary,false);
  assert.equal(analyzeSource(`('use client');export const n=1`,'parenthesized.js').frameworkBoundary,false);
});
