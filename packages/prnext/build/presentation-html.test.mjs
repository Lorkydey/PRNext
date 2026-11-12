import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {transform} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {analyzePresentation} from './presentation.mjs';
import {presentationSsrModule} from './presentation-html.mjs';
import {createFusedPresentationProjector} from '../runtime/presentation.mjs';
import {escapePresentationHtml,presentationHtmlAttribute,presentationHtmlStyle} from '../runtime/presentation-html.mjs';

const require=createRequire(import.meta.url),url=code=>'data:text/javascript,'+encodeURIComponent(code);
test('importing the compiler does not pin development React before production build setup',async()=>{
  const env={...process.env};delete env.NODE_ENV;
  const script=`import assert from 'node:assert/strict';
import{createRequire}from'node:module';
const require=createRequire(import.meta.url);
const compiler=await import(${JSON.stringify(new URL('./presentation-html.mjs',import.meta.url).href)});
assert.equal(process.env.NODE_ENV,undefined);
assert.equal(require.cache[require.resolve('react')],undefined);
assert.equal(require.cache[require.resolve('react-dom/server')],undefined);
process.env.NODE_ENV='production';
const{parse}=await import('@babel/parser');
const node=parse('const x=<section><p>Safe &amp; literal</p></section>',{plugins:['jsx']}).program.body[0].declarations[0].init;
assert.equal(compiler.staticPresentationHtml(node),'<section><p>Safe &amp; literal</p></section>');
assert.ok(Object.keys(require.cache).some(file=>file.endsWith('react.production.js')));
assert.ok(Object.keys(require.cache).some(file=>file.endsWith('react-dom-server.node.production.js')));
assert.ok(!Object.keys(require.cache).some(file=>file.endsWith('react.development.js')));`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env,timeout:30000});
});
async function prepare(source){
  const a=analyzePresentation(source,'template.jsx',{automatic:true});assert.equal(a.eligible,true,a.reason);assert.ok(a.html);
  const compiled=await transform(a.client,{loader:'jsx',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment'});
  const ordinary=url(`import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};${compiled.code}`);
  const ssr=await import(url(presentationSsrModule(a,ordinary,new URL('../runtime/presentation-html.mjs',import.meta.url).href).replace("from'react'",`from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}`)));
  const display=(await import(url('export default '+a.fusedProjector))).default;
  return{a,ordinary:(await import(ordinary)).default,ssr:ssr.default,project:createFusedPresentationProjector(a.schema,a.arraySchemas,display,{minArrayEntries:a.minArrayEntries,inlineValidation:true})};
}

test('specialized HTML matches React across text adjacency, maps, escaping, nulls and static styles',async()=>{
  const sources=[
    `export default({rows,title})=><section className="a" title={title}><h2>Static &amp; safe</h2><table><tbody>{rows.map((r,i)=><tr key={i} data-name={r.name}><td>{r.name}{r.value}{r.flag} tail</td><td style={{color:'red',fontSize:12}}>{r.value/2}</td></tr>)}</tbody></table></section>`,
    `export default({groups})=><main>{groups.map((g,i)=><div key={i}><span>before </span>{g.rows.map((r,j)=><p key={j}>{r.name}{r.name}{j}</p>)}<strong>after</strong></div>)}</main>`,
    `export default({rows})=><div><section>${'<b>Static</b>'.repeat(70)}</section>{rows.map(r=>r.name)}</div>`,
  ];
  const values=['<script>" & \' </script>','é漢字😀','a\u0000b','',null,undefined,0,-0,42,false,true];
  for(const source of sources){
    const p=await prepare(source);
    for(let i=0;i<50;i++){
      const rows=Array.from({length:32+i%5},(_,j)=>({name:values[(i+j)%values.length],value:j-i,flag:j%2===0}));
      const data=p.project({rows,title:values[i%values.length],groups:[{rows},{rows}]});assert.ok(data);
      const props={__prnextPresentation:data,__prnextLiterals:p.a.literals};assert.equal(renderToString(React.createElement(p.ssr,props)),renderToString(React.createElement(p.ordinary,props)));
    }
    const fallback={__prnextOrdinary:React.createElement('p',null,'ordinary')};
    assert.equal(renderToString(React.createElement(p.ssr,fallback)),renderToString(React.createElement(p.ordinary,fallback)));
  }
});

test('HTML helpers reject opaque values without coercion and escape attributes',()=>{
  let called=0;const value={toString(){called++;return '<unsafe>'}};
  assert.throws(()=>escapePresentationHtml(value));assert.equal(called,0);
  assert.equal(presentationHtmlAttribute('className','"&<>\''),' class="&quot;&amp;&lt;&gt;&#x27;"');
  assert.equal(presentationHtmlAttribute('title',null),'');
  assert.throws(()=>escapePresentationHtml('x'.repeat(262145)),/budget/);
  assert.throws(()=>presentationHtmlStyle({get color(){called++;return'red'}}));assert.equal(called,0);
});

test('large fields retain ordinary React output and HTML assembly is bounded',async()=>{
  const p=await prepare(`export default({rows})=><section>{rows.map(row=><p key={row.id}>{row.name}</p>)}</section>`);
  const data=p.project({rows:Array.from({length:32},(_,i)=>({id:i,name:i===0?'x'.repeat(262145):'small'}))});
  const props={__prnextPresentation:data,__prnextLiterals:p.a.literals};
  assert.equal(renderToString(React.createElement(p.ssr,props)),renderToString(React.createElement(p.ordinary,props)));
  const render=(await import(url('export default '+p.a.html.writer))).default;
  assert.throws(()=>render([Array.from({length:64},(_,i)=>[String(i),'x'.repeat(70000)])],p.a.literals,escapePresentationHtml,presentationHtmlAttribute,presentationHtmlStyle),/budget/);
});
