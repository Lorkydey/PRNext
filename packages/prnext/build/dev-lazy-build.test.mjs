import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build, disposeBuildSession } from './index.mjs';
import { materializeDevImport } from '../runtime/dev-lazy-imports.mjs';
import { snapshotDevelopmentBuild } from '../runtime/development.mjs';
import { discardLazyBuild } from '../runtime/dev-lazy-staging.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(fileURLToPath(new URL('../../../',import.meta.url)),'.prnext-lazy-graph-'));
  t.after(async()=>{await disposeBuildSession(root);await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const put=async(file,source)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);};
  await put('package.json','{"type":"module"}');
  await put('prnext.config.mjs','export default {experimental:{lazyDynamicImports:true}}');
  await put('app/layout.jsx','export default({children})=><html><body>{children}</body></html>');
  await put('app/page.jsx',"import Client from './client';export default()=> <Client/>");
  await put('app/client.jsx',"'use client';import {token} from './shared';export const load=()=>import('./editor');export default()=> <button>{token.value}</button>");
  await put('app/shared.js',"export const token={value:'ORIGINAL_SHARED_GRAPH'};export let count=0;export function increment(){count++}");
  await put('app/editor.jsx',"import {token,count} from './shared';import './editor.css';export {token,count};export default()=> <p>DEFERRED_GRAPH_ONLY:{count}</p>");
  await put('app/editor.css','.editor{--deferred-graph:1;color:blue}');
  return {root,put};
}

test('a deferred graph skips unrelated routes and leaves the ordinary output immutable',async t=>{
  const f=await fixture(t);
  for(let i=0;i<20;i++)await f.put(`app/route-${i}/page.jsx`,`export default()=> <p>Other route ${i}</p>`);
  const initial=await build(f.root,{dev:true,incremental:true,devSession:'graph-session'});
  const id=initial.devLazy.modules.find(item=>item.request==='./editor').id;
  const request={id,...initial.devLazy},directory='.prnext-dev/graph-session/original';
  await snapshotDevelopmentBuild(initial.outputDirectory,path.join(f.root,directory));
  // This route belonged to the preceding build. A global scan/build cannot pass
  // now, while activating the independent editor must not touch its graph.
  await f.put('app/route-19/page.jsx',"import missing from 'not-a-real-package-for-lazy-proof';export default()=>missing");
  await assert.rejects(build(f.root,{dev:true,devSession:'graph-session',devLazyRequest:request}),/not-a-real-package-for-lazy-proof/);
  const built=await build(f.root,{dev:true,incremental:true,devSession:'graph-session',devLazyRequest:request,devLazyBase:{cacheId:initial.cacheId}});
  try {
    assert.equal(built.devLazyTemporary,true);
    assert.equal(built.devLazyAssets.baseCacheId,initial.cacheId);
    assert.equal(built.routes.length,0);
    for(const directory of ['runtime','server','app-ssr','static'])await assert.rejects(stat(path.join(built.outputDirectory,directory)),{code:'ENOENT'});
    assert.deepEqual(built.devLazyAssets.files.map(file=>file.name).sort(),(await readdir(path.join(built.outputDirectory,'assets'))).sort());
    const ordinary=JSON.parse(await readFile(path.join(initial.outputDirectory,'manifest.json'),'utf8'));
    assert.equal(ordinary.cacheId,initial.cacheId,'a lazy stage never replaces the ordinary build');
    const current={directory,manifest:initial};
    const target=await materializeDevImport({root:f.root,current,id,compile:async()=>built});
    assert.ok(target.css.length);
    const text=(await Promise.all((await readdir(path.join(f.root,directory,'assets'))).filter(name=>name.endsWith('.js')).map(name=>readFile(path.join(f.root,directory,'assets',name),'utf8')))).join('\n');
    assert.match(text,/DEFERRED_GRAPH_ONLY/);
    assert.ok(text.includes(initial.devLazy.bridges.find(item=>item.file==='app/shared.js').url));
  } finally { await discardLazyBuild(f.root,built); }
  await assert.rejects(stat(built.outputDirectory),{code:'ENOENT'});
});

test('compiler disposal retains the ordinary recovery path for deferred activation',async t=>{
  const f=await fixture(t),initial=await build(f.root,{dev:true,devSession:'recycle-session'});
  const id=initial.devLazy.modules[0].id;
  await disposeBuildSession(f.root);
  const fallback=await build(f.root,{dev:true,devSession:'recycle-session',devLazyRequest:{id,...initial.devLazy},devLazyBase:{cacheId:initial.cacheId}});
  assert.equal(fallback.devLazyTemporary,undefined);
  assert.ok(fallback.devLazy.outputs[id]);
  assert.equal(fallback.outputDirectory,initial.outputDirectory);
});

test('deferred Sass callbacks see project env values without leaking them to the caller',async t=>{
  const f=await fixture(t),key='PRNEXT_LAZY_SASS_PRIVATE_TEST';
  assert.equal(process.env[key],undefined);
  await f.put('.env.test',key+'=blue\n');
  await f.put('.env.development',key+'=red\n');
  await f.put('prnext.config.mjs',`export default {experimental:{lazyDynamicImports:true},sassOptions:{additionalData:source=>'$flag: '+(process.env.${key}||'red')+';\\n'+source}}`);
  await f.put('app/base.scss','.base{color:$flag}');
  await f.put('app/client.jsx',"'use client';import './base.scss';export const load=()=>import('./editor');export default()=> <button>Editor</button>");
  await f.put('app/editor.jsx',"import './editor.scss';export default()=> <p>Deferred Sass</p>");
  await f.put('app/editor.scss','.editor{color:$flag}');
  const initial=await build(f.root,{dev:true,envMode:'test',devSession:'sass-env'});
  assert.equal(process.env[key],undefined);
  const id=initial.devLazy.modules[0].id;
  const built=await build(f.root,{dev:true,devSession:'sass-env',devLazyRequest:{id,...initial.devLazy},devLazyBase:{cacheId:initial.cacheId}});
  try {
    assert.equal(built.devLazyTemporary,true);
    const css=await Promise.all(built.devLazyAssets.files.filter(file=>file.name.endsWith('.css')).map(file=>readFile(path.join(built.outputDirectory,'assets',file.name),'utf8')));
    assert.ok(css.length);
    assert.match(css.join('\n'),/color:\s*(?:blue|#00f)/);
    assert.doesNotMatch(css.join('\n'),/color:\s*red/);
    assert.equal(process.env[key],undefined);
  } finally { await discardLazyBuild(f.root,built); }
});

test('failed deferred compilation removes only its private stage',async t=>{
  const f=await fixture(t),initial=await build(f.root,{dev:true,devSession:'failed-session'});
  const id=initial.devLazy.modules[0].id,before=(await readdir(f.root)).sort();
  await f.put('app/editor.jsx',"import missing from 'not-a-real-editor-package';export default()=>missing");
  await assert.rejects(build(f.root,{dev:true,devSession:'failed-session',devLazyRequest:{id,...initial.devLazy},devLazyBase:{cacheId:initial.cacheId}}),/not-a-real-editor-package/);
  assert.deepEqual((await readdir(f.root)).sort(),before);
  assert.equal(JSON.parse(await readFile(path.join(initial.outputDirectory,'manifest.json'),'utf8')).cacheId,initial.cacheId);
});

test('deferred stage cleanup refuses unrelated directories and is idempotent',async t=>{
  const f=await fixture(t),owned=path.join(f.root,'.prnext-build-'+randomUUID());
  await mkdir(owned);
  await assert.rejects(discardLazyBuild(f.root,{devLazyTemporary:true,outputDirectory:path.join(f.root,'app')}),/Invalid deferred staging/);
  await assert.rejects(discardLazyBuild(f.root,{devLazyTemporary:true,outputDirectory:path.dirname(f.root)}),/Invalid deferred staging/);
  await discardLazyBuild(f.root,{outputDirectory:path.join(f.root,'app')});
  await discardLazyBuild(f.root,{devLazyTemporary:true,outputDirectory:owned});
  await discardLazyBuild(f.root,{devLazyTemporary:true,outputDirectory:owned});
  assert.ok((await stat(path.join(f.root,'app'))).isDirectory());
});
