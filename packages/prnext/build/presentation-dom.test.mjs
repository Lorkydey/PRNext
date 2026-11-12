import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {transform} from 'esbuild';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {analyzePresentation} from './presentation.mjs';
import {extractPresentationBlocks} from './presentation-blocks.mjs';
import {createFusedPresentationProjector} from '../runtime/presentation.mjs';
import {inflatePresentationPacket} from '../../../tests/presentation-packet-support.mjs';
import {renderPresentationDisplay} from '../runtime/presentation-display.mjs';
import {renderPresentationReact} from '../runtime/presentation-dom.mjs';

const require=createRequire(import.meta.url),module=source=>'data:text/javascript,'+encodeURIComponent(source);
async function load(source){
  const result=await transform(source,{loader:'jsx',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment'});
  return(await import(module(`import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};${result.code}`))).default;
}
async function prepare(source){
  const a=analyzePresentation(source,'Source.jsx',{automatic:true});assert.ok(a.eligible,a.reason);assert.ok(a.dom,'Must exercise the specialized path');
  const make=async(flat)=>createFusedPresentationProjector(a.schema,a.arraySchemas,(await import(module('export default '+(flat?a.flatProjector:a.fusedProjector)))).default,{minArrayEntries:a.minArrayEntries,inlineValidation:true,literals:a.literals,packet:true,flatModel:flat});
  return{a,flat:await make(true),legacy:await make(false),original:await load(source),writer:(await import(module('export default '+a.domWriter))).default};
}

test('flat producer and direct SSR match actual React across nested lists, branch privacy, styles and literal SVG',async()=>{
  const sources=[
    `export default({rows})=><section style={{color:'red'}}>{rows.map(r=><p key={r.id} title={r.name}>{r.name}{r.number}{r.flag?<b>Visible</b>:<i>{r.alternate}</i>}{r.flag&&<em>Extra</em>}</p>)}</section>`,
    `export default({groups})=><div>{groups.map(g=><section key={g.id}>{g.rows.map(r=><p key={r.id}>{r.name}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M 1 2 L 3 4" strokeWidth={2} fillRule="evenodd"/></svg></p>)}</section>)}</div>`,
    `export default({rows})=><ul>{rows.map(r=><li key={r.id}>{r.flag?<span style={{color:'blue'}}>Public</span>:<span style={{color:'red'}}>Hidden label</span>}{r.flag?<b>{r.name}</b>:null}</li>)}</ul>`,
  ];
  const strings=['< & \" </script>','é漢字😀','',null,undefined,'a\u0000b','a\r\nb'];
  for(const source of sources){
    const p=await prepare(source);
    for(let turn=0;turn<20;turn++){
      const rows=Array.from({length:64},(_,id)=>({id,name:strings[(id+turn)%strings.length],number:(id-turn)/7,flag:(id+turn)%2===0,alternate:'Alternative',unused:'PRIVATE-NEVER'}));
      const props={rows,groups:[{id:'a',rows},{id:'b',rows}]};
      const flat=p.flat(props),legacy=p.legacy(props);assert.ok(flat);assert.ok(legacy);
      assert.deepEqual(inflatePresentationPacket(flat.data,p.a.layout),legacy.data);
      const rendered=renderPresentationDisplay(p.a.dom,flat.data,flat.literals,p.writer),generic=renderPresentationDisplay(p.a.dom,flat.data,flat.literals);
      assert.deepEqual(rendered,generic);
      const actual=renderToString(React.createElement(p.a.dom.root[1],{...rendered.props,dangerouslySetInnerHTML:{__html:rendered.html}}));
      assert.equal(actual,renderToString(React.createElement(p.original,props)));
      assert.equal(renderToString(renderPresentationReact(p.a.dom,flat.data,flat.literals)),actual,'ordinary React recovery has exactly the same markup');
      assert.doesNotMatch(JSON.stringify(flat),/PRIVATE-NEVER/);
    }
  }
});

test('inactive conditional regions never serialize their data or literals',async()=>{
  const p=await prepare(`export default({rows})=><section>{rows.map(r=><p key={r.id}>{r.flag?<b>Public</b>:<i style={{color:'PRIVATE-STYLE'}} data-note="PRIVATE-ATTRIBUTE">PRIVATE-LITERAL{r.secret}</i>}</p>)}</section>`);
  const result=p.flat({rows:Array.from({length:64},(_,id)=>({id,flag:true,secret:'PRIVATE-DATA'}))});
  assert.ok(result);assert.doesNotMatch(JSON.stringify(result)+p.a.domClient,/PRIVATE-/);
});

test('equal host branches transfer displayed choices without disclosing a private selector',async()=>{
  const p=await prepare(`export default({rows})=><section>{rows.map(r=><p key={r.id}>{r.privateFlag?<b>{r.first}</b>:<b>{r.second}</b>}</p>)}</section>`);
  const make=privateFlag=>p.flat({rows:Array.from({length:64},(_,id)=>({id,privateFlag,first:'Same',second:'Same'}))});
  assert.deepEqual(make(true),make(false));
  const wrapped=analyzePresentation(`export default({rows})=><section>{rows.map(r=><p key={r.id}>{r.flag?<><b>{r.name}</b></>:<b>{r.name}</b>}</p>)}</section>`,'Source.jsx',{automatic:true});
  assert.equal(wrapped.eligible,false,'transparent fragments cannot establish observable branch identity');
});

test('helper analysis uses lexical bindings, retains arguments and never executes modules',()=>{
  const table=expression=>`<ul>{rows.map(r=><li key={r.id}>{${expression}}</li>)}</ul>`;
  const positive=extractPresentationBlocks(`import 'server-only';function label(value){return value+' €'}export default async function Page({rows}){return ${table('label(r.price)')}}`,'Page.jsx');
  assert.equal(positive?.blocks.length,1);assert.deepEqual(positive.blocks[0].captured,['rows']);assert.doesNotMatch(positive.blocks[0].analysis.domClient,/label\(|server-only/);
  for(const helper of[`function label(value){return 'Dropped'}`,`function label(value){sideEffect();return value}`,`function label(value){return label(value)}`,`async function label(value){return value}`])assert.equal(extractPresentationBlocks(helper+`export default({rows})=>${table('label(r.price)')}`,'Page.jsx'),undefined);
  const shadow=`function label(value){return value+'!'}export default({rows})=><ul>{rows.map(label=><li>{label(1)}</li>)}</ul>`;
  assert.equal(extractPresentationBlocks(shadow,'Page.jsx'),undefined);
  const tdz=`export default function Page({rows}){return ${table('label(r.price)')};const label=value=>value+'!';}`;
  assert.equal(extractPresentationBlocks(tdz,'Page.jsx'),undefined);
});

test('resource SVG and unstable HTML ownership retain normal React',()=>{
  for(const svg of['<svg><use href="#icon"/></svg>','<svg onLoad={r.callback}><path d="M0 0"/></svg>','<svg><foreignObject><div>HTML</div></foreignObject></svg>','<svg><path d={r.path}/></svg>']){
    const a=analyzePresentation(`export default({rows})=><ul>{rows.map(r=><li key={r.id}>{r.name}${svg}</li>)}</ul>`,'Source.jsx',{automatic:true});assert.equal(a.eligible,false);
  }
  const bad=analyzePresentation('export default({rows})=><table>{rows.map(r=><tr key={r.id}><td>{r.name}</td></tr>)}</table>','Source.jsx',{automatic:true});assert.equal(bad.eligible,true);assert.equal(bad.dom,undefined);
});

test('SVG paint admission keeps literal colors and rejects resource servers or CSS indirection',()=>{
  const check=paint=>analyzePresentation(`export default({rows})=><ul>{rows.map(r=><li key={r.id}>{r.name}<svg><path fill={${JSON.stringify(paint)}} stroke={${JSON.stringify(paint)}} d="M0 0"/></svg></li>)}</ul>`,'Source.jsx',{automatic:true});
  for(const paint of ['none','currentColor','#abc','#12345678','rgb(10 20 30 / 50%)','color(display-p3 1 0 0)'])assert.equal(check(paint).eligible,true,paint);
  for(const paint of ['url(https://example.test/paint.svg#p)','URL(#paint)','var(--paint)','env(paint)','context-fill','u\\72l(#paint)','url/**/(#paint)','light-dark(red, url(#paint))'])assert.equal(check(paint).eligible,false,paint);
});
