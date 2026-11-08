import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {presentationFixture,presentationSecrets,presentationTable} from '../../../tests/presentation-fixture.mjs';

const section=html=>html.match(/<section data-testid="presentation">[\s\S]*?<\/section>/)?.[0];

for(const webpack of [false,true]) test(`presentation preserves SSR HTML and public boundaries (${webpack?'custom webpack fallback':'compact native compiler'})`,async()=>{
  const fixture=await presentationFixture({enabled:false,webpack});
  try {
    await fixture.write('app/TypedValue.ts',`'use presentation';export default function Value({value}:{value:number}){return <number>value}`);
    await fixture.write('app/typed/page.jsx',`import Value from'../TypedValue';export default()=> <main>Typed value: <Value value={7}/></main>`);
    const ordinary=await fixture.build();
    const seed=ordinary.prerendered.find(item=>item.path==='/next');
    const ordinaryHtml=await readFile(path.join(ordinary.outputDirectory,seed.file),'utf8');
    const ordinaryFlight=await readFile(path.join(ordinary.outputDirectory,seed.dataFile),'utf8');
    await fixture.write('prnext.config.mjs',`export default {prerender:{workers:1},${webpack?'webpack(config){return config}':''}}`);
    const compact=await fixture.build();
    const next=compact.prerendered.find(item=>item.path==='/next');
    const compactHtml=await readFile(path.join(compact.outputDirectory,next.file),'utf8');
    const compactFlight=await readFile(path.join(compact.outputDirectory,next.dataFile),'utf8');
    assert.ok(section(ordinaryHtml));
    assert.equal(section(compactHtml),section(ordinaryHtml),'the actual rendered table HTML is byte-identical');
    if(webpack){
      assert.equal(compact.presentationReport.components.find(item=>item.file==='app/Table.jsx').status,'fallback');
      assert.match(compact.presentationReport.components.find(item=>item.file==='app/Table.jsx').reason,/Custom source transforms/);
      assert.ok(!compactFlight.includes('__prnextPresentation'));
      return;
    }
    assert.ok(compactFlight.length<ordinaryFlight.length*0.65,`Flight ${compactFlight.length} vs ${ordinaryFlight.length}`);
    for(const secret of presentationSecrets) {
      assert.ok(!compactFlight.includes(secret));assert.ok(!compactHtml.includes(secret));
    }
    assert.deepEqual(compact.presentationReport.components.find(item=>item.file==='app/Table.jsx'),{file:'app/Table.jsx',status:'compact'});
    const unsupported=compact.presentationReport.components.find(item=>item.file.endsWith('Unsupported.jsx'));
    assert.equal(unsupported.status,'fallback');assert.match(unsupported.reason,/default component/);
    const fallback=compact.prerendered.find(item=>item.path==='/fallback');
    const fallbackHtml=await readFile(path.join(compact.outputDirectory,fallback.file),'utf8');
    assert.match(fallbackHtml,/data-testid="fallback">7</);
    assert.match(fallbackHtml,/Ordinary server component/);
    const typedSeed=compact.prerendered.find(item=>item.path==='/typed');
    assert.match(await readFile(path.join(compact.outputDirectory,typedSeed.file),'utf8'),/Typed value:.*7/);
    assert.match(compact.presentationReport.components.find(item=>item.file==='app/TypedValue.ts').reason,/TSTypeAssertion/);
    const computed=compact.prerendered.find(item=>item.path==='/computed');
    const computedHtml=await readFile(path.join(compact.outputDirectory,computed.file),'utf8');
    const computedFlight=await readFile(path.join(compact.outputDirectory,computed.dataFile),'utf8');
    assert.match(computedFlight,/__prnextPresentation/);
    assert.match(computedHtml,/1<\/span><b>Visible/);
    for(const secret of ['987654321','987654320','PRIVATE-AUTO-TOKEN-987'])assert.ok(!(computedHtml+computedFlight).includes(secret));
    const clientSeed=compact.prerendered.find(item=>item.path==='/client');
    assert.match(await readFile(path.join(compact.outputDirectory,clientSeed.file),'utf8'),/Client product/,'ordinary client imports keep their public props contract');
    const assets=await readdir(path.join(compact.outputDirectory,'assets'));
    for(const name of assets.filter(name=>name.endsWith('.js'))) {
      const source=await readFile(path.join(compact.outputDirectory,'assets',name),'utf8');
      for(const secret of [...presentationSecrets,'SERVER-IMPORT-IS-PRIVATE']) assert.ok(!source.includes(secret),`server value absent from ${name}`);
      assert.ok(!source.includes('createPresentationProjector'),'server projection is absent from browser assets');
    }
    const reference=Object.values(compact.app.clientModules).find(item=>compactFlight.includes(item.id)&&item.browserModule.includes(item.id)&&!ordinaryFlight.includes(item.id));
    assert.ok(reference,'the official Flight protocol contains the new component reference');
    assert.ok(await readFile(path.join(compact.outputDirectory,reference.ssrModule),'utf8'));
  } finally {await fixture.remove();}
});

test('a per-directory custom JSX runtime retains byte-identical ordinary HTML',async()=>{
  const fixture=await presentationFixture({enabled:false});
  try{
    await fixture.write('node_modules/custom-jsx/package.json','{"name":"custom-jsx","version":"1.0.0","type":"module","exports":{"./jsx-runtime":"./jsx-runtime.js"}}');
    await fixture.write('node_modules/custom-jsx/jsx-runtime.js',`import{jsx as base,jsxs as bases,Fragment}from'react/jsx-runtime';export{Fragment};export function jsx(type,props,key){return base(type,typeof type==='string'?{...props,'data-custom-jsx':'yes'}:props,key)}export function jsxs(type,props,key){return bases(type,typeof type==='string'?{...props,'data-custom-jsx':'yes'}:props,key)}`);
    await fixture.write('app/scoped/tsconfig.json','{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"custom-jsx"}}');
    await fixture.write('app/scoped/Table.jsx',presentationTable);
    await fixture.write('app/scoped/page.jsx',`import Table from'./Table';import{rows}from'../data';export default()=> <Table rows={rows(2)} title="Scoped"/>`);
    const table=async built=>{const seed=built.prerendered.find(item=>item.path==='/scoped');return(await readFile(path.join(built.outputDirectory,seed.file),'utf8')).match(/<table[^>]*>[\s\S]*?<\/table>/)?.[0];};
    const ordinary=await table(await fixture.build());assert.match(ordinary,/data-custom-jsx/);
    await fixture.write('prnext.config.mjs','export default{experimental:{presentationComponents:true},prerender:{workers:1}}');
    const candidate=await fixture.build();assert.equal(await table(candidate),ordinary);
    assert.match(candidate.presentationReport.components.find(item=>item.file==='app/scoped/Table.jsx').reason,/Per-directory/);
  }finally{await fixture.remove();}
});

test('development and HTML-only builds keep ordinary rendering with explicit diagnostic reasons',async()=>{
  const fixture=await presentationFixture();
  try{
    const dev=await fixture.build({dev:true});
    assert.equal(dev.presentationReport.components.find(item=>item.file==='app/Table.jsx').status,'fallback');
    assert.match(dev.presentationReport.components.find(item=>item.file==='app/Table.jsx').reason,/Development/);
    await fixture.write('app/layout.jsx','export default({children})=><html><body>{children}</body></html>');
    await fixture.write('app/next/page.jsx',`import Table from'../Table';import{rows}from'../data';export default()=> <Table rows={rows(3)} title="HTML only"/>`);
    await fixture.configure("htmlOnly:['/next']");
    const htmlOnly=await fixture.build();
    assert.match(htmlOnly.presentationReport.components.find(item=>item.file==='app/Table.jsx').reason,/HTML-only/);
    const seed=htmlOnly.prerendered.find(item=>item.path==='/next');
    assert.equal(seed.dataFile,undefined);
    assert.doesNotMatch(await readFile(path.join(htmlOnly.outputDirectory,seed.file),'utf8'),/<script/);
  }finally{await fixture.remove();}
});

test('a component shared with Edge keeps the ordinary Edge graph',async()=>{
  const fixture=await presentationFixture();
  try{
    await fixture.write('app/edge/page.jsx',`import Table from'../Table';import{rows}from'../data';export const runtime='edge';export default()=> <Table rows={rows(3,'Edge owner')} title="Edge presentation"/>`);
    const result=await fixture.build();
    const route=result.routes.find(item=>item.pattern==='/edge');
    const module=await readFile(path.join(result.outputDirectory,route.module.replace(/\.mjs$/,'.edge.js')),'utf8');
    assert.match(module,/Edge owner/);
    assert.ok(!module.includes('__prnextPresentation'));
    assert.equal(result.presentationReport.components.find(item=>item.file==='app/Table.jsx').edgeFallback,true);
    assert.equal(result.presentationReport.components.find(item=>item.file==='app/Table.jsx').status,'compact');
  }finally{await fixture.remove();}
});
