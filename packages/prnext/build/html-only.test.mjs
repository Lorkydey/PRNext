import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {htmlOnlyFixture} from '../../../tests/html-only-fixture.mjs';

for(const webpack of [false,true]) test(`HTML-only ${webpack?'webpack':'esbuild'} build emits complete styled static documents without browser payloads`,{timeout:180000},async()=>{
  const fixture=await htmlOnlyFixture({webpack});
  try{
    const{manifest}=await fixture.build();
    const selected=manifest.routes.filter(route=>route.htmlOnly);
    const analysis=JSON.parse(await readFile(path.join(fixture.root,'.prnext/build-analysis.json'),'utf8'));
    assert.equal(selected.length,3);
    for(const route of selected){
      assert.equal(route.client,undefined);assert.equal(route.ssg,true);assert.equal(route.fallback,false);
      const measured=analysis.routes.find(item=>item.route===route.pattern);
      assert.deepEqual(measured.files,[]);assert.equal(measured.jsBytes,0);
      assert.equal(measured.initial.status,'prerendered','No Flight sidecar is intentional, not unknown initial-JS coverage');
      const seeds=manifest.prerendered.filter(seed=>seed.routeId===route.id);assert.ok(seeds.length);
      for(const seed of seeds){
        assert.equal(seed.dataFile,undefined);assert.equal(seed.revalidate,false);
        const html=await readFile(path.join(fixture.root,'.prnext',seed.file),'utf8');
        assert.doesNotMatch(html,/<script\b|__PRNEXT_(?:FLIGHT|DATA|PPR)/i);
        assert.match(html,/<link rel="stylesheet"/);assert.match(html,/<link rel="preload" as="font"/);
        if(route.pattern==='/legal'){assert.match(html,/<title>Legal document<\/title>/);assert.match(html,/rel="canonical" href="https:\/\/example.test\/legal"/);assert.match(html,/Fully resolved content/);assert.doesNotMatch(html,/data-testid="pending"/);}
      }
    }
    const runtime=manifest.routes.find(route=>route.pattern==='/interactive').client;
    const runtimeSource=await readFile(path.join(fixture.root,'.prnext/assets',path.basename(runtime)),'utf8');
    assert.match(runtimeSource,/htmlOnlyRoutes/);
    assert.ok((await readdir(path.join(fixture.root,'.prnext/static'))).filter(file=>file.endsWith('.txt')).length>0,'hydrated routes retain their ordinary Flight sidecars');
  }finally{await fixture.remove();}
});

test('HTML-only real builds reject transitive interactivity, actions, executable markup, SSR and ISR',{timeout:180000},async t=>{
  const fixture=await htmlOnlyFixture();
  try{
    const variants=[
      ['transitive client',`import Client from'./wrapper';export default()=> <Client/>`,/htmlOnly.*Client Component/],
      ['server action',`import{save}from'./actions';export default()=> <form action={save}><button>Save</button></form>`,/htmlOnly.*Server Action/],
      ['framework Link',`import Link from'next/link';export default()=> <Link href="/other">Other</Link>`,/htmlOnly.*interactive framework/],
      ['script tag',`export default()=> <script src="/bad.js"/>`,/htmlOnly.*script/],
      ['raw handler',`export default()=> <div dangerouslySetInnerHTML={{__html:'<img src="x" onerror="bad()">'}}/>`,/htmlOnly.*interactive attribute/],
      ['SSR',`export const dynamic='force-dynamic';export default()=> <h1>SSR</h1>`,/htmlOnly.*fully prerendered/],
      ['ISR',`export const revalidate=60;export default()=> <h1>ISR</h1>`,/htmlOnly.*fully prerendered/],
    ];
    await fixture.write('app/legal/wrapper.jsx',`export{default}from'../interactive/client'`);
    await fixture.write('app/legal/actions.js',`'use server';export async function save(){return'done'}`);
    for(const[name,source,error]of variants)await t.test(name,async()=>{await fixture.write('app/legal/page.jsx',source);await assert.rejects(fixture.build(),error);});
    await t.test('incomplete generated parameters',async()=>{
      await fixture.write('app/legal/page.jsx',`export default()=> <h1>Static</h1>`);
      await fixture.write('app/guide/[slug]/page.jsx',`export const dynamicParams=false;export function generateStaticParams(){return[{}]}export default()=> <h1>Invalid parameters</h1>`);
      await assert.rejects(fixture.build(),/htmlOnly.*nonempty complete generateStaticParams/);
    });
  }finally{await fixture.remove();}
});

test('HTML-only export keeps HTML/CSS/fonts and omits Flight files for selected paths',{timeout:180000},async()=>{
  const fixture=await htmlOnlyFixture({output:'export'});
  try{
    await fixture.build();
    const html=await readFile(path.join(fixture.root,'out/docs/legal.html'),'utf8');assert.doesNotMatch(html,/<script\b|__PRNEXT_FLIGHT/i);assert.match(html,/Fully resolved content/);
    const exists=async file=>readFile(file).then(()=>true,()=>false);
    assert.equal(await exists(path.join(fixture.root,'out/docs/_prnext/flight/legal/index.txt')),false);
  }finally{await fixture.remove();}
});
