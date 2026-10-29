import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHtmlOnly, selectHtmlOnlyRoutes, validateHtmlOnlyPrerender } from './html-only-config.mjs';

const route = (id, pattern, options = {}) => ({ id, pattern, router:'app', kind:'page', cacheConfig:{ revalidate:false }, ...options });

test('HTML-only config is explicit, bounded and accepts only clean registered-pattern syntax', () => {
  assert.deepEqual(validateHtmlOnly(), []);
  assert.deepEqual(validateHtmlOnly(['/','/blog/[slug]','/docs/**','/']), ['/','/blog/[slug]','/docs/**']);
  for (const value of [true,'/',{},new Array(129).fill('/'),[''],['//host'],['/a?x=1'],['/a#x'],['/a/../b'],['/%2e%2e/b'],['/a%2fb'],['/a\\b'],['/foo*'],['/a/**/b'],['/a/'],['/a//b'],['/%xx'],['/a b']]) assert.throws(() => validateHtmlOnly(value));
});

test('HTML-only selectors match exact dynamic patterns or whole subtrees and reject typos/unsupported routes', () => {
  const routes=[route('root','/'),route('docs','/docs'),route('deep','/docs/a'),route('other','/docs-other'),route('blog','/blog/[slug]',{cacheConfig:{revalidate:false,dynamicParams:false}})];
  assert.deepEqual([...selectHtmlOnlyRoutes(routes,['/docs/**','/blog/[slug]'])],['docs','deep','blog']);
  assert.throws(()=>selectHtmlOnlyRoutes(routes,['/typo']),/does not match/);
  assert.throws(()=>selectHtmlOnlyRoutes([route('pages','/pages',{router:'pages'})],['/pages']),/App Router/);
  assert.throws(()=>selectHtmlOnlyRoutes([route('api','/api',{kind:'api'})],['/**']),/App Router/);
});

test('HTML-only candidate validation never changes unsupported dynamic, ISR, PPR or routing semantics', () => {
  for(const config of [{dynamic:'force-dynamic'},{revalidate:0},{revalidate:60},{forceNoStore:true},{runtime:'edge'}]) assert.throws(()=>selectHtmlOnlyRoutes([route('x','/x',{cacheConfig:config})],['/x']),/fully prerendered/);
  assert.throws(()=>selectHtmlOnlyRoutes([route('x','/x')],['/x'],{cacheComponents:true}),/fully prerendered/);
  assert.throws(()=>selectHtmlOnlyRoutes([route('x','/x',{parallel:true})],['/x']),/parallel/);
  assert.throws(()=>selectHtmlOnlyRoutes([route('x','/x/[id]')],['/x/[id]']),/dynamicParams/);
});

test('HTML-only output validation refuses fallback shells and browser transport sidecars', () => {
  const selected={htmlOnly:true,pattern:'/legal'};
  validateHtmlOnlyPrerender(selected,{status:200,revalidate:false,body:'<!doctype html><html><head><title>Legal</title></head><body>Readable</body></html>'});
  for(const rendered of [{dynamic:true},{partial:{}},{revalidate:30},{status:404},{status:307},{body:'<script>alert(1)</script>'},{body:'<script/>'},{body:'<a href="javascript:bad()">Bad</a>'}]) assert.throws(()=>validateHtmlOnlyPrerender(selected,{revalidate:false,body:'<html></html>',...rendered}));
});
