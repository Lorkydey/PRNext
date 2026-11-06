import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedTransform,cachedAsyncTransform,cachedValidatedTransform,transformCacheStats} from './transform-cache.mjs';
import {createRefreshTransform} from './dev.mjs';
import {transformCacheComponents} from './cache-components.mjs';
import {stripServerCode} from './transform.mjs';
import {transformDynamicImports} from './dynamic.mjs';

test('transform reuse excludes server secrets and invalidates source, target and module identity',()=>{
  const source="import secret from './database';export async function getServerSideProps(){return {props:{secret}}};export default()=>null";
  const before=transformCacheStats();
  const output=stripServerCode(source,'page.jsx');
  assert.doesNotMatch(output,/secret|database|getServerSideProps/);
  assert.equal(stripServerCode(source,'page.jsx'),output);
  assert.equal(transformCacheStats().hits,before.hits+1);
  assert.match(stripServerCode(source.replace('()=>null','()=>42'),'page.jsx'),/42/);
  const dynamic="import dynamic from 'next/dynamic';export default dynamic(()=>import('./component'),{ssr:false})";
  const browser=transformDynamicImports(dynamic,'/project/page.jsx',{projectRoot:'/project',mode:'browser'});
  assert.match(browser,/import\(/);
  assert.doesNotMatch(transformDynamicImports(dynamic,'/project/page.jsx',{projectRoot:'/project',mode:'server'}),/import\(/);
  assert.throws(()=>transformDynamicImports(dynamic,'/project/page.jsx',{projectRoot:'/project',mode:'rsc'}),/ssr: false/);
  assert.notEqual(transformDynamicImports(dynamic,'/project/other.jsx',{projectRoot:'/project',mode:'browser'}),browser);
});

test('transform cache bounds payload, entries and oversized results without retaining failures',()=>{
  for(let index=0;index<300;index++)cachedTransform('budget',String(index),[],()=>'x'.repeat(8192));
  assert.ok(transformCacheStats().entries<=256);assert.ok(transformCacheStats().bytes<=2*1024*1024);
  let calls=0;
  for(let index=0;index<2;index++)cachedTransform('oversize','',[],()=>{calls++;return 'x'.repeat(128*1024);});
  assert.equal(calls,2);
  assert.throws(()=>cachedTransform('retry','',[],()=>{throw new Error('failure');}),/failure/);
  assert.equal(cachedTransform('retry','',[],()=>'recovered'),'recovered');
});

test('Fast Refresh reuse crosses build instances and cache transforms include build identity and policy',async()=>{
  const source='export default function Counter(){return <button>Original</button>}';
  const first=await createRefreshTransform('/project')(source,'/project/counter.jsx');
  const before=transformCacheStats();
  assert.equal(await createRefreshTransform('/project')(source,'/project/counter.jsx'),first);
  assert.equal(transformCacheStats().hits,before.hits+1);
  assert.notEqual(await createRefreshTransform('/project')(source.replace('Original','Changed'),'/project/counter.jsx'),first);
  const cached="export async function data(){'use cache';return 42}";
  const options={projectRoot:'/project',enabled:true,mode:'rsc',buildId:'one'};
  const output=transformCacheComponents(cached,'/project/data.js',options);
  assert.equal(transformCacheComponents(cached,'/project/data.js',options),output);
  assert.notEqual(transformCacheComponents(cached,'/project/data.js',{...options,buildId:'two'}),output);
  assert.throws(()=>transformCacheComponents(cached,'/project/data.js',{...options,enabled:false}),/cacheComponents/);
  await assert.rejects(cachedAsyncTransform('async-failure','',[],async()=>{throw new Error('retry');}),/retry/);
  assert.equal(await cachedAsyncTransform('async-failure','',[],async()=>'ok'),'ok');
});

test('typed replay rejects malformed cached facts and never retains invalid fresh records',()=>{
  const valid=value=>{const parsed=JSON.parse(value);return parsed.version===1&&typeof parsed.value==='boolean';};
  cachedTransform('typed-fixture','same-source',[],()=>'{"version":0,"value":true}');
  let calls=0;
  assert.equal(cachedValidatedTransform('typed-fixture','same-source',[],valid,()=>{calls++;return '{"version":1,"value":false}';}),'{"version":1,"value":false}');
  assert.equal(cachedValidatedTransform('typed-fixture','same-source',[],valid,()=>{throw Error('unexpected reparse');}),'{"version":1,"value":false}');
  assert.equal(calls,1);
  assert.throws(()=>cachedValidatedTransform('typed-bad','same-source',[],valid,()=>'{"value":true}'),/Invalid typed compiler cache result/);
  assert.equal(cachedValidatedTransform('typed-bad','same-source',[],valid,()=>'{"version":1,"value":true}'),'{"version":1,"value":true}');
});
