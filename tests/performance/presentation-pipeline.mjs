import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {transform} from 'esbuild';
import {analyzePresentation} from '../../packages/prnext/build/presentation.mjs';
import {presentationSsrModule} from '../../packages/prnext/build/presentation-html.mjs';
import {createPresentationProjector,createAutomaticPresentationProjector,createFusedPresentationProjector} from '../../packages/prnext/runtime/presentation.mjs';

const require=createRequire(import.meta.url),url=source=>'data:text/javascript,'+encodeURIComponent(source);
const source=`export default({rows,title})=><section data-testid="benchmark"><h2>{title}</h2><table><tbody>{rows.map((row,index)=><tr key={row.id}><td>{index+1}</td><td>{row.name}</td><td>{row.price-row.discount}</td><td>{row.available?'Available':'Sold'}</td></tr>)}</tbody></table></section>`;
const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
function window(run,duration){
  for(let i=0;i<20;i++)run();
  const start=performance.now();let count=0;
  while(performance.now()-start<duration){run();count++;}
  const elapsedMs=performance.now()-start;return{count,elapsedMs,perSecond:count*1000/elapsedMs};
}
export async function presentationPipelineBenchmark(output){
  const a=analyzePresentation(source,'Table.jsx',{automatic:true});assert.equal(a.eligible,true,a.reason);assert.ok(a.html);
  const display=(await import(url('export default '+a.displayProjector))).default,fusedDisplay=(await import(url('export default '+a.fusedProjector))).default;
  const old=createAutomaticPresentationProjector(createPresentationProjector(a.schema,{minArrayEntries:a.minArrayEntries}),display);
  const fused=createFusedPresentationProjector(a.schema,a.arraySchemas,fusedDisplay,{minArrayEntries:a.minArrayEntries,inlineValidation:true});
  const packet=createFusedPresentationProjector(a.schema,a.arraySchemas,fusedDisplay,{minArrayEntries:a.minArrayEntries,literals:a.literals,packet:true,inlineValidation:true});
  const props={title:'Visible products',rows:Array.from({length:1000},(_,id)=>({id:'row-'+id,name:'Product '+id,price:id+10,discount:1,available:id%2===0,private:'NEVER-SERIALIZED'}))};
  assert.deepEqual(fused(props),old(props));
  const compiled=await transform(a.client,{loader:'jsx',format:'esm',jsx:'transform',jsxFactory:'React.createElement',jsxFragment:'React.Fragment'});
  const ordinaryUrl=url(`import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};${compiled.code}`),ordinary=(await import(ordinaryUrl)).default;
  const optimized=(await import(url(presentationSsrModule(a,ordinaryUrl,new URL('../../packages/prnext/runtime/presentation-html.mjs',import.meta.url).href).replace("from'react'",`from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}`)))).default;
  const value=packet(props),data={__prnextPresentation:value.data,__prnextLiterals:value.literals};
  const html=renderToString(React.createElement(ordinary,data));assert.equal(renderToString(React.createElement(optimized,data)),html);assert.ok(!html.includes('NEVER-SERIALIZED'));
  const scenarios=[{name:'projection',before:()=>old(props),after:()=>fused(props),duration:500},{name:'ssr',before:()=>renderToString(React.createElement(ordinary,data)),after:()=>renderToString(React.createElement(optimized,data)),duration:700}];
  const results=[];
  for(const scenario of scenarios){
    const samples=[];
    for(let pair=0;pair<3;pair++)for(const kind of pair%2?['after','before']:['before','after']){globalThis.gc?.();samples.push({pair,kind,...window(scenario[kind],scenario.duration)});}
    const before=samples.filter(x=>x.kind==='before').map(x=>x.perSecond),after=samples.filter(x=>x.kind==='after').map(x=>x.perSecond);
    results.push({name:scenario.name,beforeMedian:median(before),afterMedian:median(after),ratio:median(after)/median(before),samples});
  }
  const result={passed:true,kind:'controlled-microbenchmark',rows:1000,node:process.version,platform:process.platform,arch:process.arch,pairs:3,htmlSha256:createHash('sha256').update(html).digest('hex'),htmlBytes:Buffer.byteLength(html),results,limits:['Algorithm-only comparison on the same checked template; not a release-versus-release HTTP benchmark.','Shared development PC, no CPU affinity, no universal application/browser multiplier.']};
  await writeFile(output,JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,3,'Usage: node --expose-gc tests/performance/presentation-pipeline.mjs output.json');
  const result=await presentationPipelineBenchmark(process.argv[2]);console.log(JSON.stringify({passed:result.passed,results:result.results.map(({name,ratio})=>({name,ratio}))}));
}
