import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {build} from './index.mjs';
import {validateProjectConfig} from './config.mjs';
import {materializeDevImport,lazyImportIdentifier} from '../runtime/dev-lazy-imports.mjs';
import {snapshotDevelopmentBuild} from '../runtime/development.mjs';
import {selectAppStyles} from '../runtime/app-style-selection.mjs';
import {createLazyDynamicImports} from './lazy-dynamic-imports.mjs';
import {withSourceMaps,configureSourceMaps} from './source-maps.mjs';
import {createRefreshTransform} from './dev.mjs';
import {SourceMap} from 'node:module';
import {build as bundleJavaScript,transform as transformJavaScript} from 'esbuild';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(t){
  const root=await mkdtemp(path.join(repository,'.prnext-lazy-import-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const files={
    'package.json':'{"type":"module"}',
    'prnext.config.mjs':'export default {experimental:{lazyDynamicImports:true}}',
    'app/layout.jsx':'export default({children})=><html><body>{children}</body></html>',
    'app/page.jsx':"import Client from './client';export default()=> <Client/>",
    'app/client.jsx':`'use client';import {useState} from 'react';import dynamic from 'next/dynamic';import {token,count,increment} from './shared';const Heavy=dynamic(()=>import('./heavy'),{ssr:false});export default function Client(){const[show,setShow]=useState(false);return <main><button onClick={()=>{increment();setShow(true)}}>Load</button><span>{count}</span>{show&&<Heavy token={token}/>}</main>}`,
    'app/shared.js':"export const token={value:'SHARED_SINGLETON'};export let count=0;export function increment(){count++}",
    'app/heavy.jsx':"import {token,count} from './shared';import './heavy.css';export default function Heavy({token:expected}){return <p data-same={token===expected}>DEFERRED_HEAVY_SENTINEL:{count}</p>}",
    'app/heavy.css':'.deferred{--lazy-only-css:1;color:rgb(1,2,3)}',
  };
  for(const [file,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);}
  return {root,put:(file,source)=>writeFile(path.join(root,file),source)};
}
async function scripts(directory){
  const names=(await readdir(path.join(directory,'assets'))).filter(file=>file.endsWith('.js'));
  return (await Promise.all(names.map(file=>readFile(path.join(directory,'assets',file),'utf8')))).join('\n');
}

test('lazyDynamicImports validates its explicit boolean configuration',()=>{
  assert.equal(validateProjectConfig({}).experimental.lazyDynamicImports,false);
  assert.equal(validateProjectConfig({experimental:{lazyDynamicImports:true}}).experimental.lazyDynamicImports,true);
  for(const value of [null,1,'true',{},[]])assert.throws(()=>validateProjectConfig({experimental:{lazyDynamicImports:value}}),/lazyDynamicImports must be a boolean/);
  assert.equal(lazyImportIdentifier('/_prnext/lazy/'+'a'.repeat(24)),'a'.repeat(24));
  for(const value of ['/a','/_prnext/lazy/../../etc/passwd','/_prnext/lazy/'+'a'.repeat(25)])assert.equal(lazyImportIdentifier(value),undefined);
});

test('client-only import really stays outside browser compilation until activation, preserving ESM bridges and CSS',async t=>{
  const f=await fixture(t),initial=await build(f.root,{dev:true,devSession:'lazy-test'});
  assert.doesNotMatch(await scripts(initial.outputDirectory),/DEFERRED_HEAVY_SENTINEL/);
  assert.equal(initial.devLazy.modules.length,1);
  const item=initial.devLazy.modules[0];
  assert.equal(item.request,'./heavy');
  assert.equal(item.importer,'app/client.jsx');
  const shared=initial.devLazy.bridges.find(item=>item.file==='app/shared.js');
  assert.ok(shared,'the original ESM module has a live-binding entry');
  const directory='.prnext-dev/lazy-test/initial';
  await snapshotDevelopmentBuild(initial.outputDirectory,path.join(f.root,directory));
  const current={directory,manifest:initial};let calls=0;
  const compile=async request=>{calls++;return build(f.root,{dev:true,devSession:'lazy-test',devLazyRequest:request});};
  await assert.rejects(materializeDevImport({root:f.root,current,id:'0'.repeat(24),compile}),/Unknown deferred/);
  assert.equal(calls,0,'unregistered requests cannot start a compilation');
  const target=await materializeDevImport({root:f.root,current,id:item.id,compile});
  assert.equal(calls,1);
  assert.ok(target.css.length);
  const text=await scripts(path.join(f.root,directory));
  assert.match(text,/DEFERRED_HEAVY_SENTINEL/);
  assert.ok(text.includes(shared.url),'deferred code references the original ESM binding URL');
  const css=(await Promise.all(target.css.map(url=>readFile(path.join(f.root,directory,'assets',path.basename(url)),'utf8')))).join('\n');
  assert.match(css,/--lazy-only-css/);
  assert.deepEqual(await materializeDevImport({root:f.root,current,id:item.id,compile}),target);
  assert.equal(calls,1,'consecutive activations reuse completed compilation');
  await f.put('app/heavy.jsx',"import {count} from './shared';export default function Heavy(){return <p>DEFERRED_UPDATED:{count}</p>}");
  const updated=await build(f.root,{dev:true,devSession:'lazy-test',devLazyActivated:[item.id]});
  assert.match(await scripts(updated.outputDirectory),/DEFERRED_UPDATED/);
  assert.ok(updated.devLazy.outputs[item.id],'activated imports participate in later Fast Refresh graphs');
});

test('production ignores the opt-in and retains ordinary dynamic chunks',async t=>{
  const f=await fixture(t),built=await build(f.root);
  assert.equal(built.devLazy,undefined);
  const text=await scripts(built.outputDirectory);
  assert.match(text,/DEFERRED_HEAVY_SENTINEL/);
  assert.doesNotMatch(text,/Unknown deferred import identifier|\/_prnext\/lazy\//);
});

test('an unresolved deferred import fails on activation and can be fixed without corrupting the initial generation',async t=>{
  const f=await fixture(t);await rm(path.join(f.root,'app/heavy.jsx'));await rm(path.join(f.root,'app/heavy.css'));
  const initial=await build(f.root,{dev:true,devSession:'lazy-missing'}),id=initial.devLazy.modules[0].id;
  const request={id,modules:initial.devLazy.modules,bridges:initial.devLazy.bridges,shared:initial.devLazy.shared};
  await assert.rejects(build(f.root,{dev:true,devSession:'lazy-missing',devLazyRequest:request}),/Could not resolve/);
  assert.doesNotMatch(await scripts(initial.outputDirectory),/DEFERRED_HEAVY_SENTINEL/);
  await f.put('app/heavy.jsx','export default function Heavy(){return <p>RECOVERED_LAZY_MODULE</p>}');
  const fixed=await build(f.root,{dev:true,devSession:'lazy-missing',devLazyRequest:request});
  assert.ok(fixed.devLazy.outputs[id]);assert.match(await scripts(fixed.outputDirectory),/RECOVERED_LAZY_MODULE/);
});

test('nested literal imports register only when their parent is activated and join subsequent update graphs',async t=>{
  const f=await fixture(t);
  await f.put('app/heavy.jsx',"export const nested=()=>import('./nested');export default function Heavy(){return <p>LAZY_PARENT</p>}");
  await f.put('app/nested.js',"export const value='NESTED_LAZY_SENTINEL';");
  const initial=await build(f.root,{dev:true,devSession:'lazy-nested'}),first=initial.devLazy.modules[0].id;
  assert.equal(initial.devLazy.modules.length,1);
  const parent=await build(f.root,{dev:true,devSession:'lazy-nested',devLazyRequest:{id:first,...initial.devLazy}});
  const nested=parent.devLazy.modules.find(item=>item.request==='./nested');
  assert.ok(nested);assert.doesNotMatch(await scripts(parent.outputDirectory),/NESTED_LAZY_SENTINEL/);
  const child=await build(f.root,{dev:true,devSession:'lazy-nested',devLazyRequest:{id:nested.id,...parent.devLazy}});
  assert.match(await scripts(child.outputDirectory),/NESTED_LAZY_SENTINEL/);
  const updated=await build(f.root,{dev:true,devSession:'lazy-nested',devLazyActivated:[first,nested.id]});
  assert.ok(updated.devLazy.outputs[first]);assert.ok(updated.devLazy.outputs[nested.id]);
});

test('shared CommonJS modules are rejected rather than silently duplicated',async t=>{
  const f=await fixture(t);
  await f.put('app/shared.cjs',"module.exports={value:'COMMON_JS_STATE'};");
  await f.put('app/client.jsx',`'use client';import shared from './shared.cjs';import dynamic from 'next/dynamic';const Heavy=dynamic(()=>import('./heavy'),{ssr:false});export default function Client(){return <div>{shared.value}<Heavy/></div>}`);
  await f.put('app/heavy.jsx',"import shared from './shared.cjs';export default function Heavy(){return <p>{shared.value}</p>}");
  const initial=await build(f.root,{dev:true,devSession:'lazy-cjs'}),id=initial.devLazy.modules[0].id;
  await assert.rejects(build(f.root,{dev:true,devSession:'lazy-cjs',devLazyRequest:{id,...initial.devLazy}}),/cannot safely reuse the shared CommonJS module/);
});

test('unsupported development backends fail explicitly while production stays compatible',async t=>{
  const f=await fixture(t);
  await f.put('prnext.config.mjs','export default {experimental:{lazyDynamicImports:true},webpack:config=>config}');
  await assert.rejects(build(f.root,{dev:true}),/native compiler without webpack hooks/);
  const production=await build(f.root);
  assert.equal(production.devLazy,undefined);
});

test('deferred resolution preserves project aliases, base paths, asset prefixes and source maps',async t=>{
  const f=await fixture(t);
  await f.put('prnext.config.mjs',`export default {basePath:'/workspace',assetPrefix:'/staticdev',experimental:{lazyDynamicImports:true},turbopack:{resolveAlias:{'@editor':'./app/heavy.jsx'}}}`);
  const client=await readFile(path.join(f.root,'app/client.jsx'),'utf8');await f.put('app/client.jsx',client.replace("import('./heavy')","import('@editor')"));
  const initial=await build(f.root,{dev:true,devSession:'lazy-alias'}),id=initial.devLazy.modules[0].id;
  assert.equal(initial.devLazy.modules[0].request,'@editor');
  const target=await build(f.root,{dev:true,devSession:'lazy-alias',devLazyRequest:{id,...initial.devLazy}});
  const output=target.devLazy.outputs[id];assert.ok(output.url.startsWith('/staticdev/_prnext/assets/'));
  assert.ok((await readdir(path.join(target.outputDirectory,'assets'))).some(file=>file.endsWith('.js.map')));
  assert.match(await scripts(target.outputDirectory),/DEFERRED_HEAVY_SENTINEL/);
  assert.ok(initial.devLazy.bridges.every(item=>item.url.startsWith('/staticdev/_prnext/assets/')));
});

test('different registered importers of one ESM target receive the same native module URL',async t=>{
  const f=await fixture(t);
  await f.put('app/second.js',"export const loadAgain=()=>import('./heavy');");
  const client=await readFile(path.join(f.root,'app/client.jsx'),'utf8');
  await f.put('app/client.jsx',client.replace("'use client';","'use client';import {loadAgain} from './second';").replace('return <main>','return <main><button onClick={()=>loadAgain()}>Other</button>'));
  const initial=await build(f.root,{dev:true,devSession:'lazy-identity'}),directory='.prnext-dev/lazy-identity/initial';
  await snapshotDevelopmentBuild(initial.outputDirectory,path.join(f.root,directory));
  const current={directory,manifest:initial};
  const compile=devLazyRequest=>build(f.root,{dev:true,devSession:'lazy-identity',devLazyRequest});
  const imports=initial.devLazy.modules.filter(item=>item.request==='./heavy');assert.equal(imports.length,2);
  const first=await materializeDevImport({root:f.root,current,id:imports[0].id,compile});
  const second=await materializeDevImport({root:f.root,current,id:imports[1].id,compile});
  assert.equal(first.native,true);assert.equal(second.native,true);assert.equal(first.url,second.url);
});

test('literal query and fragment imports keep ordinary compilation and distinct module state',async t=>{
  const f=await fixture(t);
  await f.put('app/variant.js','export const token={};export let count=0;export function increment(){count++}');
  for(const suffix of ['?','#']){
    const manifest={config:{basePath:'',assetBase:'/_prnext/assets'}};
    const lazy=createLazyDynamicImports({root:f.root,stage:path.join(f.root,'.stage'),manifest});
    const source=`export async function compare(){const[a,b,again]=await Promise.all([import('./variant.js${suffix}one'),import(\`./variant.js${suffix}two\`),import('./variant.js${suffix}one')]);a.increment();return {same:a===b,repeat:a===again,sameToken:a.token===b.token,counts:[a.count,b.count]}}`;
    await f.put('app/variants.js',source);
    const output=await bundleJavaScript({entryPoints:[path.join(f.root,'app/variants.js')],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'lazy-source-rewriting',setup(builder){builder.onLoad({filter:/\.js$/},async args=>({contents:lazy.transform(await readFile(args.path,'utf8'),args.path),loader:'js'}));}}]});
    lazy.finish();
    assert.equal(manifest.devLazy.modules.length,0,'a literal suffix stays outside the deferred registry');
    const compiled=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64')+'#'+encodeURIComponent(suffix));
    assert.deepEqual(await compiled.compare(),{same:false,repeat:true,sameToken:false,counts:[1,0]});
  }
});

test('ordinary suffix entry points remain logical dependencies during framework style discovery',async t=>{
  const f=await fixture(t);
  await f.put('app/variant.js',"import './query.css';export const token={value:'QUERY_MODULE_STATE'};");
  await f.put('app/fragment.js',"import './fragment.css';export const token={value:'FRAGMENT_MODULE_STATE'};");
  await f.put('app/query.css','.query-variant{--query-style:1}');
  await f.put('app/fragment.css','.fragment-variant{--fragment-style:1}');
  await f.put('app/client.jsx',"'use client';export default function Client(){return <button onClick={()=>Promise.all([import('./variant.js?one'),import('./variant.js?two'),import('./fragment.js#one'),import('./fragment.js#two')]).then(modules=>console.log(modules.map(module=>module.token)))}>Load variants</button>}");
  for(const [dev,enabled]of [[true,true],[true,false],[false,true]]){
    await f.put('prnext.config.mjs',`export default {experimental:{lazyDynamicImports:${enabled}}}`);
    const built=await build(f.root,{dev,devSession:dev?'ordinary-suffix':undefined});
    if(dev&&enabled)assert.equal(built.devLazy.modules.length,0);
    else assert.equal(built.devLazy,undefined);
    assert.match(await scripts(built.outputDirectory),/QUERY_MODULE_STATE/);
    assert.match(await scripts(built.outputDirectory),/FRAGMENT_MODULE_STATE/);
    const route=built.routes.find(route=>route.pattern==='/');
    assert.ok(route.css.length,'qualified dynamic dependencies still contribute styles to their configured root');
    const css=(await Promise.all(route.css.map(url=>readFile(path.join(built.outputDirectory,'assets',path.basename(url)),'utf8')))).join('\n');
    assert.match(css,/--query-style/);assert.match(css,/--fragment-style/);
  }
});

test('resolved query and fragment suffixes in deferred targets and dependencies fail before shared bridge reuse',async t=>{
  for(const variant of ['dependency-query','dependency-fragment','target-alias','dependency-alias'])await t.test(variant,async t=>{
    const f=await fixture(t);
    if(variant==='target-alias'){
      await f.put('prnext.config.mjs',"export default {experimental:{lazyDynamicImports:true},turbopack:{resolveAlias:{'@editor':'./app/heavy.jsx?one'}}}");
      const client=await readFile(path.join(f.root,'app/client.jsx'),'utf8');
      await f.put('app/client.jsx',client.replace("import('./heavy')","import('@editor')"));
    }else{
      const request=variant==='dependency-alias'?'@variant':`./shared.js${variant==='dependency-fragment'?'#':'?'}one`;
      if(variant==='dependency-alias')await f.put('prnext.config.mjs',"export default {experimental:{lazyDynamicImports:true},turbopack:{resolveAlias:{'@variant':'./app/shared.js?one'}}}");
      await f.put('app/heavy.jsx',`import {token} from ${JSON.stringify(request)};export default function Heavy(){return <p>{token.value}:QUALIFIED_DEFERRED_MODULE</p>}`);
    }
    const initial=await build(f.root,{dev:true,devSession:'lazy-suffix'}),id=initial.devLazy.modules[0].id;
    assert.ok(initial.devLazy.bridges.some(item=>item.file==='app/shared.js'),'the unqualified ESM identity already has a bridge');
    await assert.rejects(build(f.root,{dev:true,devSession:'lazy-suffix',devLazyRequest:{id,...initial.devLazy}}),/lazyDynamicImports cannot safely defer a module with a query or fragment suffix.*Disable experimental\.lazyDynamicImports/);
    assert.doesNotMatch(await scripts(initial.outputDirectory),/QUALIFIED_DEFERRED_MODULE/);
  });
});

test('activated CSS survives parallel slot style selection and subsequent stylesheet edits',async t=>{
  const f=await fixture(t);
  await f.put('app/layout.jsx','export default({children,modal})=><html><body>{children}{modal}</body></html>');
  await mkdir(path.join(f.root,'app/@modal'),{recursive:true});await f.put('app/@modal/default.jsx','export default()=>null');
  const initial=await build(f.root,{dev:true,devSession:'lazy-parallel'}),id=initial.devLazy.modules[0].id;
  for(const revision of [1,2]){
    await f.put('app/heavy.css',`.deferred{--lazy-only-css:${revision}}`);
    const updated=await build(f.root,{dev:true,devSession:'lazy-parallel',devLazyActivated:[id]});
    const route=updated.routes.find(route=>route.pattern==='/'),expected=updated.devLazy.outputs[id].css;
    assert.ok(expected.length);assert.ok(Array.isArray(route.cssScopes));
    const model={...route,routing:{slots:{main:{branch:'__slot_main'}}}};selectAppStyles(model);
    for(const css of expected)assert.ok(model.css.includes(css),'parallel scope filtering retains the active deferred stylesheet');
    const css=(await Promise.all(expected.map(url=>readFile(path.join(updated.outputDirectory,'assets',path.basename(url)),'utf8')))).join('\n');
    assert.ok(css.includes(`--lazy-only-css: ${revision}`)||css.includes(`--lazy-only-css:${revision}`));
  }
});

test('deferred import rewriting and Fast Refresh retain original source locations',async()=>withSourceMaps(async()=>{
  configureSourceMaps(true);
  const file=path.join(repository,'components/lazy-mapping-fixture.tsx');
  const source=`export const load=()=>import('./editor');\n\nexport default function Example(){\n  throw new Error('LAZY_ORIGINAL_LOCATION');\n}`;
  const lazy=createLazyDynamicImports({root:repository.replace(/[\\/]$/,''),stage:path.join(repository,'.lazy-mapping-stage'),manifest:{config:{basePath:'',assetBase:'/_prnext/assets'}}});
  let rewritten=lazy.transform(source,file);rewritten=await createRefreshTransform(repository)(rewritten,file);
  const built=await transformJavaScript(rewritten,{loader:'tsx',sourcefile:file,sourcemap:'external',minify:true});
  const offset=built.code.indexOf('LAZY_ORIGINAL_LOCATION');assert.ok(offset>=0);
  const lines=built.code.slice(0,offset).split('\n'),mapped=new SourceMap(JSON.parse(built.map)).findEntry(lines.length-1,lines.at(-1).length);
  const normalize=value=>process.platform==='win32'?value.replaceAll('\\','/').toLowerCase():value;
  assert.equal(normalize(mapped.originalSource),normalize(file));assert.equal(mapped.originalLine,3);
}));
