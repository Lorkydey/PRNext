import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {analyzePresentation} from './presentation.mjs';
import {createPresentationProjector,createAutomaticPresentationProjector} from '../runtime/presentation.mjs';

const automatic = source => analyzePresentation(source,'component.jsx',{automatic:true});
const require = createRequire(import.meta.url);
async function load(source) {
  const compiled = await transform(source,{loader:'jsx',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment'});
  return (await import('data:text/javascript,'+encodeURIComponent(`import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};\n${compiled.code}`))).default;
}
async function prepare(source) {
  const analysis = automatic(source);
  assert.equal(analysis.eligible,true,analysis.reason);
  const display=(await import('data:text/javascript,'+encodeURIComponent('export default '+analysis.displayProjector))).default;
  return {analysis,original:await load(source),client:await load(analysis.client),project:createAutomaticPresentationProjector(createPresentationProjector(analysis.schema,{minArrayEntries:analysis.minArrayEntries}),display)};
}
const html=(component,props)=>renderToStaticMarkup(React.createElement(component,props));

test('unmarked components use server-evaluated public display slots, never raw arithmetic/branch inputs',async()=>{
  const source=`export default function Table({rows}){return <table><tbody>{rows.map(row=><tr key={row.id}><td>{row.revenue-row.privateCost}</td><td>{row.privateFlag?'Public':'Public'}</td><td>{row.privateBoolean}</td><td title={row.privateBoolean}>{typeof row.privateToken}</td></tr>)}</tbody></table>}`;
  const {analysis,original,client,project}=await prepare(source);
  const rows=Array.from({length:40},(_,id)=>({id,revenue:123456789,privateCost:123456788,privateToken:'PRIVATE-INPUT-987',privateFlag:true,privateBoolean:true,unused:'PRIVATE-UNUSED'}));
  const data=project({rows});assert.ok(data);
  assert.equal(html(original,{rows}),html(client,{__prnextPresentation:data}));
  assert.doesNotMatch(JSON.stringify(data),/12345678|PRIVATE|true|false/);
  assert.doesNotMatch(analysis.client,/privateCost|privateFlag|privateBoolean|privateToken|revenue|typeof/);
  assert.equal(analysis.automatic,true);
});

test('differential display rendering covers deterministic scalar, numeric, string and boolean cases',async()=>{
  const sources=[
    `export default({rows})=><ul>{rows.map((row,i)=><li key={i} data-name={row.name} title={row.flag}>{row.name}{row.value}{row.flag}</li>)}</ul>`,
    `export default({rows})=><ul>{rows.map((row,i)=><li key={i}>{row.value*2+1}{row.value/row.divisor}{!row.flag}{row.flag?'Yes':'No'}{typeof row.name}</li>)}</ul>`,
    `export default({groups})=><section style={{color:'red',fontSize:12}}>{groups.map(({rows},i)=><div key={i}>{rows.map((row,j)=><p key={j} aria-label={row.flag}>{row.name}{j+1}</p>)}</div>)}</section>`,
  ];
  const strings=['< & $ </script>','é漢字😀','',null,undefined,'a\u0000b'];
  let checked=0;
  for(const source of sources){
    const {original,client,project}=await prepare(source);
    for(let iteration=0;iteration<100;iteration++){
      const rows=Array.from({length:32+iteration%9},(_,index)=>({name:strings[(index+iteration)%strings.length],value:(index-iteration)*0.25,divisor:1+(index%4),flag:(index+iteration)%2===0}));
      const props={rows,groups:[{rows},{rows}],private:'NEVER'};
      const data=project(props);assert.ok(data);
      assert.equal(html(client,{__prnextPresentation:data}),html(original,props));
      checked+=rows.length;
    }
  }
  assert.ok(checked>10000);
});

test('small lists retain ordinary rendering and bounded rejection cannot poison the next request',async()=>{
  const {project}=await prepare(`export default({rows})=><ul>{rows.map((row,i)=><li key={i}>{row.name}</li>)}</ul>`);
  assert.equal(project({rows:Array.from({length:31},()=>({name:'Small'}))}),null);
  assert.ok(project({rows:Array.from({length:32},()=>({name:'Large'}))}));
  const rows=Array.from({length:32},()=>({name:'Visible'}));
  let calls=0;Object.defineProperty(rows[0],'name',{get(){calls++;throw new Error('Private getter')}});
  assert.equal(project({rows}),null);assert.equal(calls,0);
  assert.equal(project({rows:Array.from({length:20001},()=>({name:'Oversize'}))}),null);
  assert.ok(project({rows:Array.from({length:32},()=>({name:'Healthy'}))}));
  const descriptor=Object.getOwnPropertyDescriptor(Array.prototype,'map');
  const ordinaryRows=Array.from({length:32},()=>({name:'Public'}));let result;
  try{
    Object.defineProperty(Array.prototype,'map',{configurable:true,get(){calls++;throw new Error('Application map getter')}});
    result=project({rows:ordinaryRows});
  }finally{Object.defineProperty(Array.prototype,'map',descriptor);}
  assert.equal(result,null);assert.equal(calls,0);
});

test('automatic templates preserve generated-name collisions and erase private literals in expressions',async()=>{
  const {analysis,original,client,project}=await prepare(`export default({rows})=><ul>{rows.map((__prnext_display_1,__prnext_display_0)=><li key={__prnext_display_0}>{__prnext_display_1.name==='PRIVATE-CODE-LITERAL'?'Public':'Other'}</li>)}</ul>`);
  const rows=Array.from({length:32},()=>({name:'PRIVATE-CODE-LITERAL'}));
  const data=project({rows});assert.ok(data);
  assert.equal(html(original,{rows}),html(client,{__prnextPresentation:data}));
  assert.doesNotMatch(JSON.stringify(data)+analysis.client,/PRIVATE-CODE-LITERAL|\.name/);
});

test('unused destructured properties and empty object patterns preserve getter and throw semantics',async()=>{
  const {project}=await prepare(`export default({rows,unused})=><ul>{rows.map(({name,privateGetter},i)=><li key={i}>{name}</li>)}</ul>`);
  let calls=0;
  const rows=Array.from({length:32},()=>({name:'Public'}));
  const props={rows,get unused(){calls++;return 'Unused'}};
  assert.equal(project(props),null);assert.equal(calls,0);
  Object.defineProperty(rows[0],'privateGetter',{get(){calls++;throw new Error('Must run only in original component')}});
  assert.equal(project({rows}),null);assert.equal(calls,0);
  const empty=await prepare(`export default({rows})=><ul>{rows.map(({},i)=><li key={i}>Static</li>)}</ul>`);
  assert.equal(empty.project({rows:Array(32).fill(null)}),null);
  assert.throws(()=>html(empty.original,{rows:[null]}),TypeError);
  assert.ok(empty.project({rows:Array.from({length:32},()=>({secret:'Unused'}))}));
});

for(const [name,code]of [
  ['URLs',`<a href={row.privateUrl}>{row.name}</a>`],
  ['ignored HTML properties',`<div suppressHydrationWarning={row.privateFlag}>{row.name}</div>`],
  ['unverified boolean attributes',`<div hidden={row.privateFlag}>{row.name}</div>`],
  ['dynamic styles',`<div style={{color:row.privateColor}}>{row.name}</div>`],
  ['conditional JSX',`row.flag?<b>Yes</b>:<i>No</i>`],
])test(`automatic analysis retains ordinary rendering for ${name}`,()=>{
  const result=automatic(`export default({rows})=><section>{rows.map(row=>${code})}</section>`);
  assert.equal(result.eligible,false);assert.ok(result.reason);
});
