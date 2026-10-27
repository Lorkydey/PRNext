import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {recordBuildAnalysis,writeBuildAnalysis,analyzeBuild} from './analyze.mjs';
import {build} from './index.mjs';
import {validateCompilerConfig} from './compiler.mjs';

async function analysisFixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-initial-assets-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stage=path.join(root,'.prnext');await mkdir(path.join(stage,'assets'),{recursive:true});await mkdir(path.join(stage,'static'));
  const records=new Map();
  const asset=async(file,imports=[])=>{await writeFile(path.join(stage,'assets',file),'/* '+file+' */');records.set(file,{file,bytes:0,imports,modules:[]});};
  return {root,stage,records,asset};
}
const route=(pattern,id=pattern.slice(1)||'index')=>({id,pattern,kind:'page',module:`server/${id}.mjs`,client:'/_prnext/assets/entry.js'});
const record=(file,entryPoint,inputs={},imports=[])=>({[file]:{entryPoint,inputs,imports,bytes:1}});

test('webpack definitions cannot override the Cache Components hydration feature flag',async()=>{
  for(const definitions of [
    {__PRNEXT_CACHE_COMPONENTS__:'true'},
    {'typeof __PRNEXT_CACHE_COMPONENTS__':'"boolean"'},
    {__PRNEXT_CACHE_COMPONENTS__:{value:'false'}},
  ]){
    const config={webpack(config,{webpack}){config.plugins.push(new webpack.DefinePlugin(definitions));return config;}};
    await assert.rejects(validateCompilerConfig(config,process.cwd()),/DefinePlugin cannot override reserved .*__PRNEXT_CACHE_COMPONENTS__/);
  }
});

test('browser metadata preserves exact dynamic hydration IDs and explicitly required framework imports',async t=>{
  const {root,stage}=await analysisFixture(t),page=path.join(root,'pages/index.jsx'),part=path.join(root,'components/part.jsx');
  const appClient=fileURLToPath(new URL('../runtime/app-client.mjs',import.meta.url));
  const partialClient=fileURLToPath(new URL('../runtime/app-partial-client.mjs',import.meta.url));
  const flight=path.join(root,'node_modules/react-server-dom-webpack/client.browser.js');
  const output=file=>path.join(stage,'assets',file);
  const state={root,stage};
  recordBuildAnalysis(state,{absWorkingDir:root},{metafile:{inputs:{
    [page]:{imports:[{path:part,kind:'dynamic-import',original:'../components/part'}]},
    [appClient]:{imports:[{path:flight,kind:'dynamic-import',original:'react-server-dom-webpack/client.browser'},{path:partialClient,kind:'dynamic-import',original:'./app-partial-client.mjs'}]},
  },outputs:{
    ...record(output('entry.js'),page,{[page]:{bytesInOutput:1},[appClient]:{bytesInOutput:1}},[
      {path:output('part.js'),kind:'dynamic-import'},{path:output('flight.js'),kind:'dynamic-import'},{path:output('partial.js'),kind:'dynamic-import'},
    ]),
    ...record(output('part.js'),part),...record(output('flight.js'),flight),...record(output('partial.js'),partialClient),
  }}});
  const imports=state.analysis.get('entry.js').imports;
  const id='dynamic-'+createHash('sha256').update('pages/index.jsx\0../components/part').digest('hex').slice(0,20);
  assert.deepEqual(imports.find(item=>item.file==='part.js').dynamicIds,[id]);
  assert.equal(imports.find(item=>item.file==='flight.js').initial,'always');
  assert.equal(imports.find(item=>item.file==='partial.js').initial,'cache-components');
});

test('analysis includes SSR-used dynamic chunks, counts shared dependencies once, and never passes uncertain initial budgets',async t=>{
  const fixture=await analysisFixture(t),{root,stage,records,asset}=fixture;
  const id='dynamic-'+'a'.repeat(20);
  await asset('entry.js',[{file:'shared.js',kind:'import-statement'},{file:'rendered.js',kind:'dynamic-import',dynamicIds:[id]},{file:'later.js',kind:'dynamic-import'}]);
  await asset('rendered.js',[{file:'shared.js',kind:'import-statement'}]);await asset('shared.js');await asset('later.js');
  const page=route('/'),payload=JSON.stringify(JSON.stringify({dynamicIds:[id]}));
  await writeFile(path.join(stage,'static/index.html'),`<script>window.__PRNEXT_DATA__=JSON.parse(${payload});</script>`);
  const manifest={buildId:'hydration',config:{},routes:[page,{...route('/request','request'),ssp:true}],prerendered:[{routeId:'index',path:'/',file:'static/index.html'}]};
  const value=await writeBuildAnalysis({root,stage,destination:stage,manifest,records});
  const initial=value.routes[0];assert.equal(value.version,2);assert.deepEqual(initial.files,['entry.js','rendered.js','shared.js']);
  assert.equal(initial.initial.status,'request-dependent','the other dynamic import may execute during hydration or later');
  const expected=initial.files.reduce((total,file)=>total+records.get(file).bytes,0);assert.equal(initial.jsBytes,expected);
  assert.equal((await analyzeBuild(root,{maxJs:10000})).ok,false,'a lower bound cannot silently satisfy an initial-JS ceiling');
  assert.deepEqual((await analyzeBuild(root,{maxJs:10000})).routes[0].budget.exceeded,['initial-unknown']);
  records.get('entry.js').imports.pop();
  const complete=await writeBuildAnalysis({root,stage,destination:stage,manifest,records});
  assert.equal(complete.routes[0].initial.status,'prerendered');
  assert.deepEqual(complete.routes[0].files,['entry.js','rendered.js','shared.js']);
});

test('App samples resolve deduplicated Flight references and include only used client boundaries plus required runtime imports',async t=>{
  const {root,stage,records,asset}=await analysisFixture(t);
  await asset('entry.js',[{file:'flight.js',kind:'dynamic-import',initial:'always'},{file:'partial.js',kind:'dynamic-import',initial:'cache-components'},{file:'used.js',kind:'dynamic-import',initial:'flight-reference'},{file:'unused.js',kind:'dynamic-import',initial:'flight-reference'}]);
  await asset('flight.js');await asset('partial.js');await asset('used.js',[{file:'shared.js',kind:'import-statement'}]);await asset('unused.js');await asset('shared.js');
  await writeFile(path.join(stage,'static/app.txt'),'2:"client-used"\n3:I["$2",["$2","/used.js"],"default"]\n0:{"tree":[]}\n');
  const manifest={buildId:'app-hydration',config:{},routes:[{...route('/app','app'),router:'app'}],app:{clientModules:{'client-used':{browserModule:'/used.js'},'client-unused':{browserModule:'/unused.js'}}},prerendered:[{routeId:'app',path:'/app',file:'static/app.html',dataFile:'static/app.txt'}]};
  const before=await writeBuildAnalysis({root,stage,destination:stage,manifest,records});
  assert.deepEqual(before.routes[0].files,['entry.js','flight.js','shared.js','used.js']);assert.equal(before.routes[0].initial.status,'prerendered');
  manifest.config.cacheComponents=true;
  const partial=await writeBuildAnalysis({root,stage,destination:stage,manifest,records});assert.ok(partial.routes[0].files.includes('partial.js'));
  await writeFile(path.join(stage,'static/app.txt'),'3:I["$missing",[],"default"]\n');
  const unknown=await writeBuildAnalysis({root,stage,destination:stage,manifest,records,routeInputs:new Map([['server/app.mjs',new Set(['app/client.jsx'])]])});
  assert.deepEqual(unknown.routes[0].initial.samplePaths,[]);
  assert.equal(unknown.routes[0].initial.status,'request-dependent','an unrecognized import row cannot be reported as a complete static graph');
  const comparison=await analyzeBuild(root,{maxJs:100});assert.equal(comparison.routes[0].deltaBytes,null);assert.equal(comparison.routes[0].comparison,'initial-unknown');
  await writeFile(path.join(stage,'static/app.txt'),'2:"client-used"\n4:T40,fake data\n2:"client-unused"\n3:I["$2",[],"default"]\n');
  const framed=await writeBuildAnalysis({root,stage,destination:stage,manifest,records});
  assert.equal(framed.routes[0].initial.status,'request-dependent','raw Flight frames may contain forged row-shaped text');
  await writeFile(path.join(stage,'static/app.txt'),'x'.repeat(16*1024*1024+1));
  const large=await writeBuildAnalysis({root,stage,destination:stage,manifest,records});assert.equal(large.routes[0].initial.status,'request-dependent','bounded diagnostics do not fail an otherwise valid build');
});

test('schema changes cannot manufacture regressions or savings against legacy undercounted baselines',async t=>{
  const {root,stage,records,asset}=await analysisFixture(t);await asset('entry.js');
  const legacy={version:1,buildId:'old',totalJsBytes:1,files:[],routes:[{route:'/',files:[],jsBytes:1,gzipBytes:1,brotliBytes:1}]};
  await writeFile(path.join(root,'baseline.json'),JSON.stringify(legacy));await writeFile(path.join(stage,'build-analysis.json'),JSON.stringify(legacy));
  const report=await writeBuildAnalysis({root,stage,destination:stage,manifest:{buildId:'new',routes:[route('/')]},records});
  assert.equal(report.previous,undefined);assert.match(report.comparisonUnavailable,/accounting changed/);
  await assert.rejects(analyzeBuild(root,{baseline:'baseline.json'}),/accounting changed/);
  await assert.rejects(analyzeBuild(root,{maxIncreaseBytes:0}),/require.*baseline/);
  const invalid=structuredClone(report);invalid.routes[0].jsBytes=0;
  await writeFile(path.join(stage,'build-analysis.json'),JSON.stringify(invalid));
  await assert.rejects(analyzeBuild(root,{maxJs:1000}),/totals do not match/,'malformed byte totals cannot manufacture a passing budget');
});

test('route budgets use individual sample maxima rather than mutually exclusive chunk unions',async t=>{
  const {root,stage,records,asset}=await analysisFixture(t),a='dynamic-'+'a'.repeat(20),b='dynamic-'+'b'.repeat(20);
  await asset('entry.js',[{file:'a.js',kind:'dynamic-import',dynamicIds:[a]},{file:'b.js',kind:'dynamic-import',dynamicIds:[b]}]);
  await asset('a.js');await asset('b.js');await writeFile(path.join(stage,'assets/a.js'),'a'.repeat(2000));
  let seed=17;const noise=Array.from({length:1000},()=>String.fromCharCode(33+(seed=(seed*16807)%2147483647)%90)).join('');await writeFile(path.join(stage,'assets/b.js'),noise);
  for(const [name,id]of [['a',a],['b',b]])await writeFile(path.join(stage,`static/${name}.html`),`<script>window.__PRNEXT_DATA__=JSON.parse(${JSON.stringify(JSON.stringify({dynamicIds:[id]}))});</script>`);
  const value=await writeBuildAnalysis({root,stage,destination:stage,records,manifest:{buildId:'samples',routes:[route('/')],prerendered:['a','b'].map(name=>({routeId:'index',path:'/'+name,file:`static/${name}.html`}))}});
  const measured=value.routes[0],samples=measured.initial.samples;
  assert.deepEqual(measured.files,['a.js','b.js','entry.js']);
  assert.equal(measured.jsBytes,Math.max(...samples.map(sample=>sample.jsBytes)));
  assert.equal(measured.gzipBytes,Math.max(...samples.map(sample=>sample.gzipBytes)));
  assert.equal(samples[0].jsBytes>samples[1].jsBytes,true);assert.equal(samples[0].gzipBytes<samples[1].gzipBytes,true,'compressed maximum may belong to a different path');
  assert.equal(measured.initial.status,'request-dependent','a sibling sample cannot hide an unresolved import on this sample');
  assert.equal((await analyzeBuild(root)).routes[0].comparison,'initial-unknown');
});

test('real Pages and App builds retain honest initial chunk accounting after prerendering',async t=>{
  const repository=fileURLToPath(new URL('../../../',import.meta.url));
  const root=await mkdtemp(path.join(repository,'.prnext-initial-build-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const files={
    'package.json':'{"type":"module","private":true}',
    'postcss.config.json':'{"plugins":[]}',
    'pages/rendered.jsx':`import dynamic from 'next/dynamic';const View=dynamic(()=>import('../components/rendered'));export default function Page(){return <View/>}`,
    'pages/client-only.jsx':`import dynamic from 'next/dynamic';const View=dynamic(()=>import('../components/client-only'),{ssr:false});export default function Page(){return <View/>}`,
    'components/rendered.jsx':`export default()=> <h1>Initial SSR dynamic marker</h1>`,
    'components/client-only.jsx':`const href=window.location.href;export default()=> <p>Only client hydration {href}</p>`,
    'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
    'app/app/page.jsx':`import Counter from './counter';export default()=> <Counter/>`,
    'app/app/counter.jsx':`'use client';import{useState}from'react';export default function Counter(){const[n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>}`,
  };
  for(const [name,source]of Object.entries(files)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
  const manifest=await build(root),analysis=JSON.parse(await readFile(path.join(manifest.outputDirectory,'build-analysis.json'),'utf8'));
  const pages=analysis.routes.find(route=>route.route==='/rendered'),client=analysis.routes.find(route=>route.route==='/client-only'),app=analysis.routes.find(route=>route.route==='/app');
  const dynamicChunk=analysis.files.find(file=>file.modules.some(module=>module.file==='components/rendered.jsx'));
  assert.ok(pages.files.includes(dynamicChunk.file),'SSR dynamic chunk is part of initial hydration');assert.equal(pages.initial.status,'prerendered');
  assert.equal(client.initial.status,'request-dependent','ssr:false timing is not inferred from the server document');
  assert.equal(app.initial.status,'prerendered');
  const partial=analysis.files.find(file=>file.modules.some(module=>module.file.includes('/runtime/app-partial-model.mjs')));
  assert.equal(partial,undefined,'ordinary App build entirely prunes the PPR model/parser feature graph');
  const initialSource=(await Promise.all(app.files.map(file=>readFile(path.join(manifest.outputDirectory,'assets',file),'utf8')))).join('\n');
  assert.doesNotMatch(initialSource,/x-prnext-prefetch-known/,'ordinary App builds also prune the PPR request controller and its segment-cache operations');
  const flight=analysis.files.find(file=>file.modules.some(module=>module.file.includes('react-server-dom-webpack-client.browser.production')));
  assert.ok(flight&&app.files.includes(flight.file),'always-awaited Flight adapter is counted');
  await writeFile(path.join(root,'next.config.mjs'),`export default {webpack(config){config.plugins.push({apply(){}});return config}}`);
  const webpack=await build(root),bridge=JSON.parse(await readFile(path.join(webpack.outputDirectory,'build-analysis.json'),'utf8'));
  assert.ok(bridge.files.some(file=>file.initialIncomplete),'webpack bridge explicitly identifies its partial graph metadata');
  assert.ok(bridge.routes.every(route=>route.initial.status==='request-dependent'),'missing webpack runtime/shared chunk edges cannot produce false exact totals');
  assert.equal((await analyzeBuild(root,{maxJs:10000})).ok,false);
});

test('App bootstrap reports one controlled startup error and preserves its original rejected promise',async()=>{
  const {bootstrapApp}=await import('../runtime/app-client.mjs');
  const document=Object.getOwnPropertyDescriptor(globalThis,'document'),report=console.error,errors=[];
  const failure=new Error('Startup dependency unavailable');
  Object.defineProperty(globalThis,'document',{configurable:true,get(){throw failure;}});
  console.error=(...args)=>errors.push(args);
  try{
    const first=bootstrapApp({}),second=bootstrapApp({});
    assert.strictEqual(first,second,'failed startup is retained without an implicit retry');
    await assert.rejects(first,error=>error===failure,'explicit consumers still receive the original failure');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(errors.length,1);assert.equal(errors[0][0],'[PRNext] App startup failed:');assert.strictEqual(errors[0][1],failure);
  }finally{console.error=report;if(document)Object.defineProperty(globalThis,'document',document);else delete globalThis.document;}
});
