import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePresentation} from './presentation.mjs';
import {validateProjectConfig} from './config.mjs';
import {createPresentationProjector, projectPresentationProps} from '../runtime/presentation.mjs';

const analyze = body => analyzePresentation(`'use presentation';export default ${body}`);
const table = analyze(`function Table({rows, title, unused}) {return <section><h2>{title}</h2><p>{rows.length}</p><table><tbody>{rows.map((row,index)=><tr key={row.id}><td>{index+1}</td><td>{row.name}</td><td>{row.price*2}</td><td>{row.owner.label}</td></tr>)}</tbody></table></section>}`);

test('automatic presentation is enabled by default with a validated global opt-out and legacy alias', () => {
  assert.equal(validateProjectConfig({}).presentationComponents, true);
  assert.equal(validateProjectConfig({presentationComponents:false}).presentationComponents, false);
  assert.equal(validateProjectConfig({experimental:{presentationComponents:false}}).presentationComponents, false);
  assert.equal(validateProjectConfig({experimental:{presentationComponents:true}}).presentationComponents, true);
  assert.throws(()=>validateProjectConfig({presentationComponents:true,experimental:{presentationComponents:false}}),/conflicting/);
  for (const value of [null, 1, 'true', {}, []]) {
    assert.throws(() => validateProjectConfig({presentationComponents:value}), /presentationComponents/);
    assert.throws(() => validateProjectConfig({experimental:{presentationComponents:value}}), /presentationComponents/);
  }
  assert.equal(analyzePresentation(`// use presentation\nexport default()=>null`), null);
  assert.equal(analyzePresentation(`const message='use presentation';export default()=>null`), null);
});

test('infers only used display fields, including nested rows, keys, and array length', () => {
  assert.equal(table.eligible, true, table.reason);
  assert.deepEqual(table.schema, {kind:'object', fields:{rows:{kind:'array',item:{kind:'object',fields:{id:{kind:'scalar'},name:{kind:'scalar'},price:{kind:'scalar'},owner:{kind:'object',fields:{label:{kind:'scalar'}}}}}},title:{kind:'scalar'}}});
  const rows=[{id:1,name:'A < & $',price:5,owner:{label:'Public',password:'PRIVATE-NESTED'},password:'PRIVATE-ROW'}];
  const props={rows,title:'Hello',unused:'PRIVATE-UNUSED',token:'PRIVATE-TOP'};
  const projected=projectPresentationProps(props,table.schema);
  assert.deepEqual(projected,[[[1,'A < & $',5,['Public']]],'Hello']);
  assert.doesNotMatch(JSON.stringify(projected),/PRIVATE/);
  assert.equal(props.rows,rows);
  assert.notEqual(projected[0],rows);
  assert.match(table.client,/__prnextPresentation/);
  assert.doesNotMatch(table.client,/row\.name|row\.owner|rows\.map/);
});

test('client generation includes only checked code, erasing comments and type imports', () => {
  const result=analyzePresentation(`'use presentation';import type {PrivateType} from './database';type Props={name:string};export default function Card({name}:Props){/* PRIVATE-COMMENT */return <p>{name}</p>}`, 'card.tsx');
  assert.equal(result.eligible,true,result.reason);
  assert.doesNotMatch(result.client,/PRIVATE-COMMENT|database|PrivateType|use presentation/);
  assert.match(result.client,/export default function Card/);
});

test('unverified syntax and non-JSX TypeScript assertions keep ordinary compilation',()=>{
  const assertion=analyzePresentation(`'use presentation';export default function Value({value}:{value:number}){return <number>value}`, 'value.ts');
  assert.equal(assertion.eligible,false);assert.match(assertion.reason,/TSTypeAssertion/);
  const unverified=analyzePresentation(`'use presentation';export default()=> <`, 'invalid.jsx');
  assert.equal(unverified.eligible,false);assert.ok(unverified.reason);
  assert.equal(analyzePresentation(`'use presentation';${' '.repeat(262144)}`).eligible,false);
});

for (const [reason, code] of [
  ['server import', `import 'server-only';export default()=> <p/>`],
  ['private constant', `const secret='SECRET';export default()=> <p>{secret}</p>`],
  ['another export', `export const helper=1;export default()=> <p/>`],
  ['async', `export default async()=> <p/>`],
  ['hooks', `export default()=> <p>{useState(0)}</p>`],
  ['environment', `export default()=> <p>{process.env.SECRET}</p>`],
  ['randomness', `export default()=> <p>{Math.random()}</p>`],
  ['fetch', `export default()=> <p>{fetch('/')}</p>`],
  ['custom component', `export default()=> <Card/>`],
  ['custom element', `export default()=> <custom-card/>`],
  ['script', `export default()=> <script>dangerous</script>`],
  ['stateful control', `export default({name})=> <input defaultValue={name}/>`],
  ['event', `export default({save})=> <button onClick={save}/>`],
  ['ref', `export default({element})=> <div ref={element}/>`],
  ['raw html', `export default({html})=> <div dangerouslySetInnerHTML={{__html:html}}/>`],
  ['spread', `export default(props)=> <div {...props}/>`],
  ['computed access', `export default({row,field})=> <p>{row[field]}</p>`],
  ['prototype', `export default({row})=> <p>{row.constructor}</p>`],
  ['assignment', `export default({row})=> <p>{row.name='changed'}</p>`],
  ['default parameter', `export default({name='fallback'})=> <p>{name}</p>`],
  ['rest', `export default({...props})=> <p>{props.name}</p>`],
  ['object and scalar', `export default({row})=> <p>{row}{row.name}</p>`],
  ['scalar and object', `export default({row})=> <p>{row.name}{row}</p>`],
  ['map array capture', `export default({rows})=> <div>{rows.map((row,index,all)=><p>{all.length}</p>)}</div>`],
  ['multiple statements', `export default({name})=> {const x=name;return <p>{x}</p>}`],
  ['mixed boundary', `'use client';export default()=> <p/>`],
  ['conditional private value', `export default({allowed,secret})=> <p>{allowed?secret:'Hidden'}</p>`],
  ['short-circuit private value', `export default({secret})=> <p>{secret&&'Present'}</p>`],
  ['custom JSX runtime', `/** @jsxImportSource private-runtime */export default()=> <p/>`],
]) {
  test(`preserves ordinary rendering for ${reason}`, () => {
    const result=analyzePresentation(`'use presentation';${code}`);
    assert.equal(result.eligible,false);
    assert.ok(result.reason);
  });
}

test('supports nested maps, simple row destructuring, static styles and conditional display', () => {
  const result=analyze(`({groups,enabled})=><section style={{color:'red'}}><p>{enabled?'Enabled':'Disabled'}</p>{groups.map(({id,rows})=><div key={id}>{rows.map(({name},index)=><p key={index}>{name}</p>)}</div>)}</section>`);
  assert.equal(result.eligible,true,result.reason);
  const output=projectPresentationProps({enabled:true,groups:[{id:'g',secret:'private',rows:[{name:'Public',secret:'private'}]}]},result.schema);
  assert.deepEqual(output,[[['g',[['Public']]]],true]);
});

test('boolean display choices never transport a private truthy value as a condition',()=>{
  const result=analyze(`({available})=><p>{available?'Available':'Sold'}</p>`);
  assert.equal(result.eligible,true,result.reason);
  assert.deepEqual(projectPresentationProps({available:true},result.schema),[true]);
  assert.equal(projectPresentationProps({available:'PRIVATE-TRUTHY-VALUE'},result.schema),null);
});

test('unused map rows are discarded without exposing row values', () => {
  const result=analyze(`({rows,unused})=><ul>{rows.map((row,index)=><li key={index}>{index}</li>)}</ul>`);
  assert.equal(result.eligible,true,result.reason);
  assert.deepEqual(projectPresentationProps({rows:[{secret:1},()=>1],unused:'private'},result.schema),[[null,null]]);
});

test('packed expressions preserve nested scopes, aliases, shorthand records and generated-name collisions',async()=>{
  const result=analyze(`({groups,__prnext_presentation})=>groups.map(({id,rows})=>rows.map((row,__prnext_presentation_)=>({id,label:id+':'+row.name+':'+__prnext_presentation+':'+__prnext_presentation_})))`);
  assert.equal(result.eligible,true,result.reason);
  const data=projectPresentationProps({groups:[{id:'g',secret:'private',rows:[{name:'Public',secret:'private'}]}],__prnext_presentation:'Root'},result.schema);
  const module=await import('data:text/javascript,'+encodeURIComponent(result.client));
  assert.deepEqual(module.default({__prnextPresentation:data}),[[{id:'g',label:'g:Public:Root:0'}]]);
  assert.doesNotMatch(JSON.stringify(data),/private/);
});

test('unused getters are never invoked; used getters and proxies fall back without invocation', () => {
  let calls=0;
  const props={rows:[],title:'OK',get token(){calls++;throw new Error('private')}};
  assert.deepEqual(projectPresentationProps(props,table.schema),[[],'OK']);
  assert.equal(calls,0);
  Object.defineProperty(props,'title',{get(){calls++;return 'OK'}});
  assert.equal(projectPresentationProps(props,table.schema),null);
  assert.equal(calls,0);
  assert.equal(projectPresentationProps(new Proxy({}, {getOwnPropertyDescriptor(){calls++;throw new Error('trap')}}),table.schema),null);
  assert.equal(calls,0);
});

test('opaque, exceptional and oversized data retain the ordinary React path', () => {
  const scalar=analyze(`({value})=><p>{value}</p>`).schema;
  for(const value of [NaN,Infinity,-Infinity,1n,Symbol(),()=>1,new Date(),[],{},new String('x')]) assert.equal(projectPresentationProps({value},scalar),null);
  for(const value of [undefined,null,true,false,0,-0,123,'$1','</script>']) assert.ok(Object.is(projectPresentationProps({value},scalar)[0],value));
  assert.equal(projectPresentationProps(Object.create(null),scalar),null);
  const rows=analyze(`({rows})=><ul>{rows.map(row=><li>{row}</li>)}</ul>`).schema;
  const overridden=[1];overridden.map=()=>[];
  const accessor=[1];Object.defineProperty(accessor,0,{get(){throw new Error('getter')}});
  for(const value of [new Array(1),overridden,Array(20001).fill(1),accessor]) assert.equal(projectPresentationProps({rows:value},rows),null);
  const cycle={};cycle.name=cycle;
  const cycleSchema=analyze(`({row})=><p>{row.name}</p>`).schema;
  assert.equal(projectPresentationProps({row:cycle},cycleSchema),null);
  const inherited=analyze(`props=><p>{typeof props.toString}</p>`).schema;
  assert.equal(projectPresentationProps({},inherited),null);
});

test('projector work is bounded across all rows, and schemas are compiled once', () => {
  const project=createPresentationProjector(table.schema);
  const row={id:1,name:'OK',price:1,owner:{label:'Public'}};
  assert.equal(project({rows:Array(20000).fill(row),title:'OK'}),null,'100,000-node budget applies to the whole request');
  assert.equal(project({rows:[row],title:'OK'})[0][0][1],'OK','a rejected request cannot poison the next one');
});
