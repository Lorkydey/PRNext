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
test('immutable summaries identify nested actions, JavaScript JSX, runtime TypeScript and CommonJS exports',()=>{
  const analysis=analyzeSource(`'use client';export const {x:renamed,...rest}=input;export const [head,...tail]=items;export declare const declared:number;export interface Shape{};export type Alias=number;export type {TypeOnly} from 'types';export {type T,renamed as 'named-export'};export enum Kind{First};export namespace Space{export const inner=1};export * from './star';export * as namedStar from './namespace';function action(){'use server';return 1};export default function Page(){return <main/>}`,'summary.tsx');
  assert.equal(analysis.hasServerDirective,true);
  assert.deepEqual([...analysis.runtimeExports].sort(),['renamed','rest','head','tail','named-export','Kind','Space','namedStar','default'].sort());
  assert.deepEqual(analysis.exportStars,['./star']);
  assert.throws(()=>analysis.runtimeExports.push('poison'),TypeError);assert.throws(()=>analysis.directives[0]='poison',TypeError);assert.throws(()=>analysis.imports[0].path='poison',TypeError);
  assert.equal(analyzeSource(`export default ()=> <main/>`,'jsx-page.js').runtimeExports[0],'default');
  assert.equal(analyzeSource(`const x=<number>1;export {x}`,'assertion.ts').runtimeExports[0],'x');
  const cjs=analyzeSource(`module['exports']={default:1,plain:1,['computed']:2,...other};exports.named=1;module.exports.extra=2;Object.defineProperty(exports,'getter',{get(){return 1}});Object.defineProperty(exports,'__esModule',{value:true});exports[unknown]=1;`,'summary.cjs');
  assert.deepEqual([...cjs.runtimeExports].sort(),['default','plain','computed','named','extra','getter'].sort());
  assert.equal(analyzeSource(`const text='use server';function f(){('use server');}`,'not-actions.js').hasServerDirective,false);
});
test('summary cache bounds count and retained bytes and invalidates content changes',()=>{
  const first=analyzeSource('export const original=1','evicted.js');
  for(let i=0;i<70;i++)analyzeSource(`export const name${i}=1`,`eviction-${i}.js`);
  assert.ok(sourceAnalysisStats().entries<=64);assert.ok(sourceAnalysisStats().bytes<=16*1024*1024);
  assert.notEqual(analyzeSource('export const original=1','evicted.js'),first);
  assert.deepEqual(analyzeSource('export const replacement=1','evicted.js').runtimeExports,['replacement']);
});
