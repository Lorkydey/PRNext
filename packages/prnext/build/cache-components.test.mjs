import test from 'node:test';
import assert from 'node:assert/strict';
import { transformCacheComponents } from './cache-components.mjs';

const options = { enabled: true, projectRoot: '/app', buildId: 'one' };
test('cache compiler isolates async arguments and closures, module exports, and directives', () => {
  const source = `export default async function Page({id}){const tenant='one';async function read(value){'use cache';return tenant+value+id}return read(id)}`;
  const transformed = transformCacheComponents(source, '/app/page.tsx', options);
  assert.match(transformed, /prnext-internal:use-cache/);
  assert.match(transformed, /\[tenant, id\]/);
  assert.doesNotMatch(transformed, /['"]use cache['"]/);
  assert.notEqual(transformed, transformCacheComponents(source, '/app/page.tsx', { ...options, buildId: 'two' }));
  assert.match(transformCacheComponents(`'use cache';export async function getData(a){return a}`, '/app/lib.ts', options), /prnext-internal:use-cache/);
  assert.match(transformCacheComponents(`'use cache';const Page=async()=>1;export default Page`, '/app/page.page.tsx', { ...options, segment: 'page' }), /"page"/);
  assert.throws(() => transformCacheComponents(`'use cache';export const value=42`, '/app/lib.ts', options), /must export async functions/);
  assert.match(transformCacheComponents(`export const getData=async()=>{'use cache: private';return 1}`, '/app/lib.ts', options), /"private"/);
  assert.throws(() => transformCacheComponents(source, '/app/page.tsx', { ...options, enabled: false }), /cacheComponents:true/);
  assert.throws(() => transformCacheComponents(`'use client';export const A=async()=>{'use cache';return 1}`, '/app/client.ts', options), /server-only/);
  assert.throws(() => transformCacheComponents(`export const getData=()=>{'use cache';return 1}`, '/app/lib.ts', options), /async function/);
  assert.throws(() => transformCacheComponents(`export async function Page(){let n=0;return async()=>{'use cache';return n++}}`, '/app/lib.ts', options), /cannot mutate captured variable n/);
});

test('cache wrappers preserve undeclared arguments rather than using function arity', async () => {
  const transformed = transformCacheComponents(`export async function read(){'use cache';return arguments[0]}`, '/app/read.js', options);
  const source = transformed.replace(/import[^;]+;/, 'const _prnextCache=async(_id,_kind,captures,args,callback)=>callback(captures,args);');
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(await module.read('value'), 'value');
  assert.throws(() => transformCacheComponents(`export function outer(){return async()=>{'use cache';return arguments[0]}}`, '/app/read.js', options), /lexical arguments/);
});
