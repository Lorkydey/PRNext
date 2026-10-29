import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build,disposeBuildSession} from './index.mjs';
import {createReactCompilerTransform} from './react-compiler.mjs';
import {createSourceLocationTransform,createRefreshTransform} from './dev.mjs';
import {withSourceMaps,configureSourceMaps} from './source-maps.mjs';
import {readReactCompilerReport} from './react-compiler-report.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(files,run){
  const root=await mkdtemp(path.join(repository,'.prnext-react-compiler-build-'));
  try{
    await writeFile(path.join(root,'package.json'),'{"type":"module"}');
    for(const[name,source]of Object.entries(files)){
      const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);
    }
    await run(root);
  }finally{await disposeBuildSession(root);await rm(root,{recursive:true,force:true});}
}
async function scripts(root,folder){
  const directory=path.join(root,folder),names=await readdir(directory).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
  return(await Promise.all(names.filter(name=>/\.(?:m?js)$/.test(name)).map(name=>readFile(path.join(directory,name),'utf8')))).join('\n');
}
const memo=/react\/compiler-runtime|react\.memo_cache_sentinel|useMemoCache/;
const memoCall=/react\.memo_cache_sentinel/;
async function emittedFunction(output,folder,name){
  const source=await scripts(output,folder),match=new RegExp('function '+name+'\\([^]*?\\n}').exec(source);
  assert.ok(match,'the actual '+name+' function is emitted');return match[0];
}
const component=`export default function Counter({value}){const label='value:'+value;return <button>{label}</button>}`;

test('Pages Compiler optimizes browser components while preserving the entire server graph',async()=>{
  await fixture({
    'next.config.mjs':'export default {reactCompiler:true}',
    'components/Counter.jsx':component,
    'pages/index.jsx':`import Counter from '../components/Counter.jsx';export const getServerSideProps=()=>({props:{value:3}});export default function Page(props){return <Counter value={props.value}/>}`,
    'pages/api/render.jsx':`export default function ApiComponent(){'use memo';return <p>API unchanged</p>}`,
    'pages/_document.jsx':`export default function Document(){'use memo';return <html><body/></html>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    assert.doesNotMatch(await scripts(result.outputDirectory,'server'),memo);
    assert.match(await emittedFunction(result.outputDirectory,'assets','Counter'),memoCall);
    const api=result.routes.find(route=>route.pattern==='/api/render');
    assert.doesNotMatch(await readFile(path.join(result.outputDirectory,api.module),'utf8'),memo);
    assert.doesNotMatch(JSON.stringify(result.config),/reactCompiler|compilationMode|panicThreshold/,'build-only settings do not leak into the runtime contract');
    const report=await readReactCompilerReport(result.outputDirectory,{buildId:result.buildId});
    assert.equal(report.summary.optimized,2,'Page and Counter each count once');
    assert.deepEqual(report.files.find(file=>file.file==='components/Counter.jsx').functions[0].targets,['browser']);
    assert.ok(report.files.every(file=>!file.file.includes('api/')&&!file.file.includes('_document')),'excluded server modules never enter the emitted optimization report');
    assert.doesNotMatch(JSON.stringify(result.config),/observed-transforms|cacheReuses|memoSlots/,'developer reporting is not part of the public runtime contract');
  });
});

test('App Compiler optimizes Client Component SSR/browser and leaves RSC/routes/actions untouched',async()=>{
  await fixture({
    'next.config.mjs':'export default {reactCompiler:true}',
    'app/layout.jsx':'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/page.jsx':`import Counter from './Counter.jsx';export default function Page(){return <Counter value={7}/>}`,
    'app/Counter.jsx':`'use client';import {Action} from './actions.js';${component.replace('<button>','<button onClick={()=>Action()}>')}`,
    'app/actions.js':`'use server';export async function Action(){return 'server-action'}`,
    'app/api/route.js':`export function GET(){return new Response('unchanged')}`,
    'app/edge/page.jsx':`import Counter from '../Counter.jsx';export const runtime='edge';export default function EdgePage(){return <Counter value={9}/>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    assert.match(await scripts(result.outputDirectory,'app-ssr'),/react\/compiler-runtime/);
    assert.match(await emittedFunction(result.outputDirectory,'assets','Counter'),memoCall);
    assert.doesNotMatch(await scripts(result.outputDirectory,'server'),memo,'Server Components and handlers never import the client memo runtime');
    assert.ok(Object.keys(result.app.actions).length,'the excluded server-action module is reached and emitted');
    assert.match(await scripts(result.outputDirectory,'app-ssr-edge'),/useMemoCache/,'Edge Client Component SSR uses the same compiled code');
    const report=await readReactCompilerReport(result.outputDirectory,{buildId:result.buildId});
    const counter=report.files.find(file=>file.file==='app/Counter.jsx').functions.filter(fn=>fn.name==='Counter');
    assert.equal(counter.length,1,'SSR/browser graphs do not inflate the component count');
    assert.deepEqual(counter[0].targets,['browser','edge','node']);
    assert.equal(counter[0].status,'optimized');
  });
});

test('Pages API, Document and data-loader dependencies can call JSX utilities outside React',async()=>{
  await fixture({
    'next.config.mjs':'export default {reactCompiler:true}',
    'lib/invoice.jsx':`import {renderToStaticMarkup} from 'react-dom/server';export function InvoiceHTML({total}){return renderToStaticMarkup(<p>Total {total}</p>)}`,
    'components/Shared.jsx':`export function Shared({value}){return <strong>{value}</strong>}`,
    'pages/index.jsx':`import {InvoiceHTML} from '../lib/invoice.jsx';import {Shared} from '../components/Shared.jsx';export function getServerSideProps(){return {props:{invoice:InvoiceHTML({total:7})}}}export default function Page({invoice}){return <main><Shared value="page"/><span dangerouslySetInnerHTML={{__html:invoice}}/></main>}`,
    'pages/api/invoice.jsx':`import {InvoiceHTML} from '../../lib/invoice.jsx';import {Shared} from '../../components/Shared.jsx';import {renderToStaticMarkup} from 'react-dom/server';export default function handler(_req,res){res.json({invoice:InvoiceHTML({total:9}),shared:renderToStaticMarkup(Shared({value:'api'}))})}`,
    'pages/_document.jsx':`import {InvoiceHTML} from '../lib/invoice.jsx';export default function Document(){return <html><body dangerouslySetInnerHTML={{__html:InvoiceHTML({total:11})}}/></html>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    assert.doesNotMatch(await scripts(result.outputDirectory,'server'),memo);
    assert.match(await emittedFunction(result.outputDirectory,'assets','Shared'),memoCall,'the shared component is still compiled in the browser');
    const page=await import(pathToFileURL(path.join(result.outputDirectory,result.routes.find(route=>route.pattern==='/').module)).href);
    const data=await page.getServerSideProps();
    assert.match(data.props.invoice,/<p[^>]*>Total 7<\/p>/);
    assert.match(renderToStaticMarkup(createElement(page.default,data.props)),/page/,'actual server rendering succeeds');
    assert.match(renderToStaticMarkup(page.Document()),/Total 11/,'Document dependency executes outside React');
    const api=await import(pathToFileURL(path.join(result.outputDirectory,result.routes.find(route=>route.pattern==='/api/invoice').module)).href);
    let response;await api.default({}, {json(value){response=value;}});
    assert.match(response.invoice,/<p[^>]*>Total 9<\/p>/);
    assert.match(response.shared,/>api<\/strong>/,'the shared component remains callable from the API');
  });
});

test('incremental config changes invalidate compiled graphs without editing component source',async()=>{
  await fixture({'next.config.mjs':'export default {reactCompiler:true}','pages/index.jsx':component},async root=>{
    const options={dev:true,incremental:true};
    const enabled=await build(root,options);assert.match(await emittedFunction(enabled.outputDirectory,'assets','Counter'),memoCall);
    assert.equal((await readReactCompilerReport(enabled.outputDirectory)).summary.optimized,1);
    await writeFile(path.join(root,'next.config.mjs'),`export default {reactCompiler:{compilationMode:'annotation'}}`);
    const annotation=await build(root,options);assert.doesNotMatch(await emittedFunction(annotation.outputDirectory,'assets','Counter'),memoCall);
    assert.equal((await readReactCompilerReport(annotation.outputDirectory)).summary.optimized,0);
    await writeFile(path.join(root,'next.config.mjs'),'export default {reactCompiler:false}');
    const disabled=await build(root,options);assert.doesNotMatch(await emittedFunction(disabled.outputDirectory,'assets','Counter'),memoCall);
    assert.equal((await readReactCompilerReport(disabled.outputDirectory)).enabled,false);
    await writeFile(path.join(root,'next.config.mjs'),'export default {reactCompiler:true}');
    const reenabled=await build(root,options);assert.match(await emittedFunction(reenabled.outputDirectory,'assets','Counter'),memoCall);
    assert.equal((await readReactCompilerReport(reenabled.outputDirectory)).summary.optimized,1);
    const warm=await build(root,options),report=await readReactCompilerReport(warm.outputDirectory,{buildId:warm.buildId});
    assert.equal(report.summary.optimized,1,'an unchanged incremental graph keeps cached compiler decisions visible');
    assert.ok(report.summary.cacheReuses>=1,'warm transforms replay their stored events');
  });
});

test('custom loaders feed React Compiler through both turbopack and webpack graph bridges',async()=>{
  for(const backend of ['turbopack','webpack'])await fixture({
    'next.config.mjs':backend==='webpack'
      ?`export default {reactCompiler:true,webpack(config){config.module.rules.push({test:/Counter\\.jsx$/,use:['./replace-loader.cjs']});return config}}`
      :`export default {reactCompiler:true,turbopack:{rules:{'Counter.jsx':{loaders:['./replace-loader.cjs'],as:'*.jsx'}}}}`,
    'replace-loader.cjs':`module.exports=source=>source.replace('__FIXTURE_JSX__','<button>{label}</button>')`,
    'components/Counter.jsx':`export default function Counter({value}){const label='value:'+value;return __FIXTURE_JSX__}`,
    'pages/index.jsx':`import Counter from '../components/Counter.jsx';export default function Page(){'use no memo';return <Counter value={3}/>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    const server=await scripts(result.outputDirectory,'server');
    assert.doesNotMatch(server,/__FIXTURE_JSX__/,backend+' loader executes before the framework transform');
    assert.doesNotMatch(server,memo,backend+' server loader output stays original');
    assert.match(await emittedFunction(result.outputDirectory,'assets','Counter'),memoCall,backend+' browser receives compiled loader output');
    const warm=await build(root,{dev:true,incremental:true});
    const report=await readReactCompilerReport(warm.outputDirectory,{buildId:warm.buildId});
    const optimized=report.files.find(file=>file.file==='components/Counter.jsx')?.functions.find(fn=>fn.name==='Counter');
    if(optimized)assert.equal(optimized.status,'optimized',backend+' cached loader/graph reports actual optimization');
    else assert.ok(report.graphs.some(graph=>graph.unobservedInputs>0),backend+' opaque graph reuse is disclosed instead of inventing component totals');
  });
});

test('authored MDX loader output enters the component compiler on both graph backends',async()=>{
  for(const backend of ['turbopack','webpack'])await fixture({
    'next.config.mjs':backend==='webpack'
      ?`export default {reactCompiler:true,webpack(config){config.module.rules.push({test:/\\.mdx$/,use:['./mdx-loader.cjs']});return config}}`
      :`export default {reactCompiler:true,turbopack:{rules:{'*.mdx':{loaders:['./mdx-loader.cjs'],as:'*.jsx'}}}}`,
    'mdx-loader.cjs':`module.exports=source=>'export default function Article({value}){const title='+JSON.stringify(source.trim())+'+value;return <article>{title}</article>}'`,
    'components/Article.mdx':'# Authored MDX',
    'pages/index.jsx':`import Article from '../components/Article.mdx';export default function Page(){'use no memo';return <Article value={3}/>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    const server=await scripts(result.outputDirectory,'server');
    assert.match(server,/Authored MDX/,backend+' loader converts the authored document into a component');
    assert.doesNotMatch(server,memo,backend+' server component stays original');
    assert.match(await emittedFunction(result.outputDirectory,'assets','Article'),memoCall,backend+' browser optimizes the same component');
  });
});

test('compiler-generated JSX retains original inspector locations before Fast Refresh',async()=>{
  await fixture({},async root=>{
    const file=path.join(root,'Counter.jsx');
    const source=`export default function Counter({value}) {\n  const label='value:'+value;\n  return <main><button>{label}</button></main>;\n}\n`;
    await writeFile(file,source);
    await withSourceMaps(async()=>{
      configureSourceMaps(true);
      const compiled=await createReactCompilerTransform(root,true,{dev:true})(source,file);
      assert.match(compiled,memo);
      const located=await createSourceLocationTransform(root)(compiled,file);
      assert.match(located,/data-prnext-source="Counter.jsx:3:10"/);
      assert.match(located,/data-prnext-source="Counter.jsx:3:16"/);
      const refreshed=await createRefreshTransform(root)(located,file);
      assert.match(refreshed,/__prnextRegisterModule/);
      assert.match(refreshed,/data-prnext-source="Counter.jsx:3:10"/);
      assert.equal((refreshed.match(/data-prnext-source=/g)||[]).length,2);
    });
  });
});

test('ordinary mts/cts hook helpers compile in Pages browser and isolated App client graphs',async()=>{
  await fixture({
    'next.config.mjs':'export default {reactCompiler:true}',
    'components/useMts.mts':`import {useState} from 'react';export function useMts(value:number){const [state]=useState<number>(value);return {label:'MTS:'+state}}`,
    'components/useCts.cts':`import {useState} from 'react';export function useCts(value:number){const [state]=useState<number>(value);return {label:'CTS:'+state}}`,
    'components/Lazy.jsx':`export default function Lazy({value}){return <span>lazy-typed-value:{value}</span>}`,
    'components/dynamicHelpers.mts':`import dynamic from 'next/dynamic';const Lazy:any=dynamic(()=>import('./Lazy.jsx'),{ssr:false});export default Lazy;`,
    'components/Helpers.jsx':`'use client';import {useMts} from './useMts.mts';import {useCts} from './useCts.cts';import Lazy from './dynamicHelpers.mts';export default function Helpers(){'use no memo';const mts=useMts(2),cts=useCts(3);return <><p>{mts.label} {cts.label}</p><Lazy value={5}/></>}`,
    'pages/index.jsx':`import Helpers from '../components/Helpers.jsx';export default function Page(){'use no memo';return <Helpers/>}`,
    'app/layout.jsx':'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/client/page.jsx':`import Helpers from '../../components/Helpers.jsx';export default function Page(){return <Helpers/>}`,
    'app/edge/page.jsx':`import Helpers from '../../components/Helpers.jsx';export const runtime='edge';export default function Page(){return <Helpers/>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    for(const name of ['useMts','useCts']){
      assert.match(await emittedFunction(result.outputDirectory,'assets',name),memoCall,name+' browser helper is actually optimized');
      assert.match(await emittedFunction(result.outputDirectory,'app-ssr',name),memoCall,name+' App SSR helper is actually optimized');
      assert.match(await emittedFunction(result.outputDirectory,'app-ssr-edge',name),memoCall,name+' Edge SSR helper is actually optimized');
    }
    assert.match(await scripts(result.outputDirectory,'assets'),/lazy-typed-value/,'typed dynamic() helper reaches its lazy browser component');
    assert.doesNotMatch(await scripts(result.outputDirectory,'server'),memo,'Pages server and RSC helpers remain original');
    const page=await import(pathToFileURL(path.join(result.outputDirectory,result.routes.find(route=>route.pattern==='/').module)).href);
    assert.match(renderToStaticMarkup(createElement(page.default)),/MTS:2 CTS:3/);
    await writeFile(path.join(root,'components/useMts.mts'),`'use client';export function useMts(value:number){return {label:String(value)}}`);
    await assert.rejects(build(root,{dev:true,incremental:true}),/React server\/client directives are not supported/);
  });
});

test('decorated mts/cts utilities retain native compilation when React Compiler is enabled',async()=>{
  await fixture({
    'next.config.mjs':'export default {reactCompiler:true}',
    'components/decorated.mts':`function decorate(value:any){return value};@decorate class MtsValue{answer=17};export const mtsValue=new MtsValue().answer;`,
    'components/decorated.cts':`function decorate(value:any){return value};@decorate class CtsValue{answer=23};export const ctsValue=new CtsValue().answer;`,
    'components/Decorated.jsx':`'use client';import {mtsValue} from './decorated.mts';import {ctsValue} from './decorated.cts';export default function Decorated(){return <p>decorated:{mtsValue+ctsValue}</p>}`,
    'pages/index.jsx':`import Decorated from '../components/Decorated.jsx';export default function Page(){return <Decorated/>}`,
    'app/layout.jsx':'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/client/page.jsx':`import Decorated from '../../components/Decorated.jsx';export default function Page(){return <Decorated/>}`,
    'app/edge/page.jsx':`import Decorated from '../../components/Decorated.jsx';export const runtime='edge';export default function Page(){return <Decorated/>}`,
  },async root=>{
    const result=await build(root,{dev:true,incremental:true});
    assert.match(await emittedFunction(result.outputDirectory,'assets','Decorated'),memoCall,'the importing browser component remains memoized');
    assert.match(await emittedFunction(result.outputDirectory,'app-ssr','Decorated'),memoCall,'the importing App SSR component remains memoized');
    assert.match(await emittedFunction(result.outputDirectory,'app-ssr-edge','Decorated'),memoCall,'the importing Edge SSR component remains memoized');
    const page=await import(pathToFileURL(path.join(result.outputDirectory,result.routes.find(route=>route.pattern==='/').module)).href);
    assert.match(renderToStaticMarkup(createElement(page.default)),/decorated:40/,'native decorated utilities execute in the actual server render');
    let client;
    for(const boundary of Object.values(result.app.clientModules)){
      const candidate=await import(pathToFileURL(path.join(result.outputDirectory,boundary.ssrModule)).href);
      if(candidate.default?.name==='Decorated')client=candidate;
    }
    assert.ok(client,'the actual Decorated client boundary is emitted');
    assert.match(renderToStaticMarkup(createElement(client.default)),/decorated:40/,'compiled App client SSR calls the original decorated utilities');
  });
});
