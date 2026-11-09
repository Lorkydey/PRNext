import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {presentationFixture} from '../../../tests/presentation-fixture.mjs';

test('production extracts imported/async blocks, prepares literal HTML and shares templates without private code',async()=>{
  const f=await presentationFixture({enabled:false});
  try{
    const table=`export default({rows})=><table data-testid="shared"><tbody>{rows.map(row=><tr key={row.id}><td>Hello {row.name}</td></tr>)}</tbody></table>`;
    await f.write('app/SharedA.jsx',table);await f.write('app/SharedB.jsx',table.replaceAll(/\brow\b/g,'item').replace('Hello ','Bonjour '));
    await f.write('app/imported/Part.jsx',`import 'server-only';export default function Part({rows}){const title='Visible server label';return <section><h2>{title}</h2><table data-testid="part"><tbody>{rows.map(row=><tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table></section>}`);
    await f.write('app/imported/page.jsx',`import A from'../SharedA';import B from'../SharedB';import Part from'./Part';import Counter from'../counter';import{rows as makeRows}from'../data';export default async function Page(){const rows=await Promise.resolve(makeRows(64));return <main><Counter/><table data-testid="island"><tbody>{rows.map(row=><tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table><Part rows={rows}/><A rows={rows}/><B rows={rows}/><section data-testid="literal">${'<p>Build-time &amp; public literal text</p>'.repeat(70)}</section></main>}`);
    await f.write('app/typed-blocks/page.tsx',`import type{ReactNode}from'react';import{rows}from'../data';type Row={id:string;name:string};export default async function TypedPage(){const items=rows(64)as Row[];return <table data-testid="typed-block"><tbody>{items.map((row:Row)=><tr key={row.id}><td>{row.name as string}</td></tr>)}</tbody></table>}`);
    const body=async built=>{const seed=built.prerendered.find(x=>x.path==='/imported');return{html:await readFile(path.join(built.outputDirectory,seed.file),'utf8'),flight:await readFile(path.join(built.outputDirectory,seed.dataFile),'utf8')};};
    const old=await body(await f.build());await f.write('prnext.config.mjs','export default{prerender:{workers:1}}');
    const built=await f.build(),next=await body(built);
    assert.deepEqual([...next.html.matchAll(/<table[\s\S]*?<\/table>/g)].map(x=>x[0]),[...old.html.matchAll(/<table[\s\S]*?<\/table>/g)].map(x=>x[0]));
    assert.equal(next.html.match(/<section data-testid="literal">[\s\S]*?<\/section>/)?.[0],old.html.match(/<section data-testid="literal">[\s\S]*?<\/section>/)?.[0]);
    assert.match(next.flight,/__prnextPresentation/);assert.match(next.flight,/dangerouslySetInnerHTML/);
    const report=built.presentationReport.components,a=report.find(x=>x.file==='app/SharedA.jsx'),b=report.find(x=>x.file==='app/SharedB.jsx');
    assert.equal(a.templateId,b.templateId);assert.equal(a.sharedSources,2);assert.equal(a.ssr,true);assert.equal(a.fused,true);
    const page=report.find(x=>x.file==='app/imported/page.jsx');assert.equal(page.status,'partial');assert.ok(page.blocks>=1);assert.equal(page.staticBlocks.length,1);
    assert.equal(report.find(x=>x.file==='app/imported/Part.jsx').status,'partial');
    assert.equal(report.find(x=>x.file==='app/typed-blocks/page.tsx')?.status,'partial','type annotations are erased, not captured as runtime props');
    for(const file of(await readdir(path.join(built.outputDirectory,'assets'))).filter(n=>n.endsWith('.js'))){
      const js=await readFile(path.join(built.outputDirectory,'assets',file),'utf8');assert.doesNotMatch(js,/createFusedPresentationProjector|escapePresentationHtml|Visible server label|makeRows\(64\)/);
    }
  }finally{await f.remove();}
});
