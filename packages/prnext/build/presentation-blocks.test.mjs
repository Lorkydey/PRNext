import test from 'node:test';
import assert from 'node:assert/strict';
import {transform} from 'esbuild';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {extractPresentationBlocks} from './presentation-blocks.mjs';
import {createFusedPresentationProjector} from '../runtime/presentation.mjs';

const require=createRequire(import.meta.url),url=x=>'data:text/javascript,'+encodeURIComponent(x),reactUrl=pathToFileURL(require.resolve('react')).href;
async function load(source,definitions=[]){
  const compiled=await transform(source,{loader:'jsx',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment'});
  return(await import(url(`import React from ${JSON.stringify(reactUrl)};${definitions.join('\n')}${compiled.code}`))).default;
}
async function compile(source){
  const extracted=extractPresentationBlocks(source,'Page.jsx');assert.ok(extracted);let transformed=extracted.source;const definitions=[];
  for(const [index,block]of extracted.blocks.entries()){
    const name=transformed.match(new RegExp('import ([\\w$]+) from "'+block.specifier+'"'))?.[1];assert.ok(name);
    transformed=transformed.replace(new RegExp('import '+name+' from "'+block.specifier+'";?'),'');
    const display=(await import(url('export default '+block.analysis.fusedProjector))).default;
    const project=createFusedPresentationProjector(block.analysis.schema,block.analysis.arraySchemas,display,{minArrayEntries:block.analysis.minArrayEntries,literals:block.analysis.literals,packet:true,inlineValidation:true});
    const template=await load(block.analysis.client);
    globalThis['__presentationBlockTest'+index]=(read,ordinary)=>{let props;try{props=read();}catch{return ordinary();}const data=project(props);return data===null?ordinary():React.createElement(template,{__prnextPresentation:data.data,__prnextLiterals:data.literals});};
    definitions.push(`const ${name}=globalThis.__presentationBlockTest${index};`);
  }
  return{extracted,original:await load(source),candidate:await load(transformed,definitions)};
}

test('extracts a checked table inside imports, async logic and interactive siblings without importing user code',()=>{
  const source=`import data from 'NEVER-EXECUTE-THIS';import Client from './Client';export default async function Page(){const rows=await data();return <main><Client/><table><tbody>{rows.map(row=><tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table><Client/></main>}`;
  const result=extractPresentationBlocks(source,'Page.jsx');assert.equal(result.blocks.length,1);assert.deepEqual(result.blocks[0].captured,['rows']);
  assert.match(result.source,/await data\(\)/);assert.match(result.source,/import Client/);assert.doesNotMatch(result.blocks[0].analysis.client,/NEVER-EXECUTE|data\(\)|Client|ordinary/);
  const moved=extractPresentationBlocks(source,'elsewhere/Page.jsx',{identity:'Page.jsx'});assert.equal(result.blocks[0].id,moved.blocks[0].id);
});

test('block fallback keeps getters, lexical mutation and surrounding evaluation order exactly once',async()=>{
  const source=`export default function Page({initial,trace}){let rows=initial;const title={get value(){trace.push('getter');rows=[{id:9,name:'Updated'}];return 'Caption'}};trace.push('before');return <main><table title={title.value}><tbody>{rows.map(row=><tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table><footer>{trace.push('after')}</footer></main>}`;
  const p=await compile(source);assert.equal(p.extracted.blocks.length,1);
  for(const component of [p.original,p.candidate]){const trace=[];const html=renderToString(React.createElement(component,{initial:Array.from({length:40},(_,id)=>({id,name:'Old'})),trace}));assert.match(html,/Updated/);assert.doesNotMatch(html,/Old/);assert.deepEqual(trace,['before','getter','after']);}
});

test('extracts build-time literal HTML without a client template and retains parameter evaluation',async()=>{
  const source=`export default function Page({unused}){return <section className="literal">${'<p>Public &amp; literal text</p>'.repeat(70)}</section>}`;
  const p=await compile(source);assert.equal(p.extracted.blocks.length,0);assert.equal(p.extracted.statics.length,1);assert.match(p.extracted.source,/dangerouslySetInnerHTML/);
  assert.equal(renderToString(React.createElement(p.original,{unused:0})),renderToString(React.createElement(p.candidate,{unused:0})));
  for(const component of[p.original,p.candidate]){let count=0;assert.throws(()=>component({get unused(){count++;throw Error('Original getter')}}),/Original getter/);assert.equal(count,1);}
});

test('client/action/cache boundaries and small or uncertain blocks retain their original path',()=>{
  const table='<table><tbody>{rows.map(row=><tr><td>{row.name}</td></tr>)}</tbody></table>';
  for(const directive of ['use client','use server','use cache','use cache: private','use cache: remote'])assert.equal(extractPresentationBlocks(`'${directive}';export default({rows})=>${table}`,'Page.jsx'),undefined);
  assert.equal(extractPresentationBlocks(`export default({rows})=>{ 'use cache';return ${table}}`,'Page.jsx'),undefined);
  assert.equal(extractPresentationBlocks(`export default({rows})=>{ 'use cache: private';return ${table}}`,'Page.jsx'),undefined);
  assert.equal(extractPresentationBlocks('export default()=> <p>Small</p>','Page.jsx'),undefined);
  assert.equal(extractPresentationBlocks('export default()=> <ul>{unknown.map(row=><li>{row.name}</li>)}</ul>','Page.jsx'),undefined);
  assert.equal(extractPresentationBlocks(`export default({rows,id})=><table key={id}><tbody>{rows.map(row=><tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table>`,'Page.jsx')?.source.includes('<table key={id}>'),true);
});

test('children inspected by custom components, callbacks, cloneElement or stored variables stay ordinary',()=>{
  const table='<table><tbody>{rows.map(row=><tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table>';
  for(const source of[
    `export default({rows})=><Inspector>${table}</Inspector>`,
    `export default({rows})=><Inspector view={${table}}/>`,
    `export default({rows})=>React.cloneElement(${table},{className:'custom'})`,
    `export default function Page({rows}){const view=${table};return <main>{view}</main>}`,
    `export default({rows})=><main>{wrapper.map(()=>${table})}</main>`,
  ])assert.equal(extractPresentationBlocks(source,'Page.jsx'),undefined,source);
});

test('TypeScript callback annotations do not become runtime captures',()=>{
  const x=extractPresentationBlocks(`import{rows}from'./data';type Row={id:string;name:string};export default async function Page(){const items=rows(64)as Row[];return <table><tbody>{items.map((row:Row)=><tr key={row.id}><td>{row.name as string}</td></tr>)}</tbody></table>}`,'Page.tsx');
  assert.equal(x.blocks.length,1);assert.deepEqual(x.blocks[0].captured,['items']);
});
