import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {transformNextCompiler,normalizeNextCompiler} from './next-compiler.mjs';
import {withSourceMaps,configureSourceMaps,extractSourceMap} from './source-maps.mjs';
const root=path.resolve('.'),file=path.join(root,'next-compiler-fixture.jsx');
const transform=(source,compiler,extra={})=>transformNextCompiler(source,file,{root,config:{compiler:normalizeNextCompiler(compiler)},target:'browser',...extra});

test('console stripping honors excluded methods, lexical bindings and development',async()=>{
  const source='console.log("remove");console.error("retain");function f(console){console.log("local")}';
  const output=await transform(source,{removeConsole:{exclude:['error']}});
  assert.doesNotMatch(output,/"remove"/);assert.match(output,/console.error/);assert.match(output,/"local"/);
  assert.equal(await transform(source,{removeConsole:true},{dev:true}),source);
});
test('server definitions never become browser replacements and shadowed roots stay local',async()=>{
  const source='export const flag=FLAG;export const secret=SERVER_ONLY;function f(FLAG){return FLAG}';
  const options={define:{FLAG:true},defineServer:{SERVER_ONLY:'private-value'}};
  const browser=await transform(source,options),server=await transform(source,options,{target:'node'});
  assert.match(browser,/flag = true/);assert.doesNotMatch(browser,/private-value/);assert.match(browser,/return FLAG/);assert.match(server,/secret = "private-value"/);
});
test('styled-components IDs match SSR and browser without requiring a user Babel config',async()=>{
  const source='import styled from "styled-components";export const Box=styled.div`color:red;`;';
  const a=await transform(source,{styledComponents:true}),b=await transform(source,{styledComponents:true},{target:'node'});
  assert.match(a,/componentId:/);assert.equal(a,b);assert.doesNotMatch(a,/displayName:/);
  assert.match(await transform(source,{styledComponents:true},{dev:true}),/displayName:/);
});
test('Emotion serializes styles and development labels remain configurable',async()=>{
  const source='import {css} from "@emotion/react";export const color=css`color:red;`;';
  const output=await transform(source,{emotion:{autoLabel:'always',labelFormat:'[local]'}});
  assert.match(output,/label:color/);assert.doesNotMatch(output,/css`color:red/);
});
test('property removal strips selected JSX attributes only',async()=>{
  const output=await transform('export const C=()=> <button data-test-id="x" aria-label="Keep" title="Keep"/>;',{reactRemoveProperties:{properties:['^data-test']}});
  assert.doesNotMatch(output,/data-test-id/);assert.match(output,/aria-label="Keep"/);assert.match(output,/title="Keep"/);
});
test('styled-jsx emits a shared scope for style and matching elements',async()=>{
  const output=await transform('export const C=()=> <div><p>text</p><style jsx>{`p{color:red}`}</style></div>;',{styledJsx:true});
  const id=/id=\{"(\d+)"\}/.exec(output)?.[1];assert.ok(id);assert.match(output,new RegExp('p\\.jsx-'+id));assert.match(output,new RegExp('className=\\{"jsx-'+id));
});
test('styled-jsx Lightning CSS preserves dynamic interpolations while minifying static declarations',async()=>{
  const source='export function C({color}){return <div className="dynamic"><style jsx>{`.dynamic { color: ${color}; margin: 0px 0px 0px 0px; }`}</style></div>}';
  const output=await transform(source,{styledJsx:{useLightningcss:true}});
  assert.match(output,/color/);assert.match(output,/\.dynamic/);assert.doesNotMatch(output,/0px 0px 0px 0px/);assert.match(output,/dynamic/);
});
test('Relay compiles a named GraphQL operation to its generated artifact',async()=>{
  const output=await transform('import {graphql} from "relay-runtime";export const query=graphql`query CompatibilityQuery { viewer { id } }`;',{relay:{src:'.',artifactDirectory:'__generated__',language:'javascript',eagerEsModules:true}});
  assert.match(output,/CompatibilityQuery\.graphql/);assert.doesNotMatch(output,/graphql`/);
});
test('compiler source maps retain original source and locations',async()=>withSourceMaps(async()=>{
  configureSourceMaps(true);const source='console.log("gone");\nexport const result=3;';
  const output=await transform(source,{removeConsole:true});const parsed=extractSourceMap(output);
  assert.ok(parsed.map);assert.ok(parsed.map.sourcesContent.includes(source));assert.match(parsed.code,/result = 3/);
}));
test('unsupported compiler options and reserved definitions fail before compilation',()=>{
  for(const input of[{unknown:true},{define:{'process.env.NEXT_RUNTIME':'other'}},{styledComponents:{unknown:true}},{emotion:{autoLabel:'sometimes'}},{relay:{src:'src',language:'other'}},{runAfterProductionCompile:true}])assert.throws(()=>normalizeNextCompiler(input));
});
