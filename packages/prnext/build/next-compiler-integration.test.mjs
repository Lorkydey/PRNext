import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from './index.mjs';
import {closeIncrementalCompiler} from './incremental.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
test('compiler options reach Pages and App graphs, isolate server defines and run the production hook once',async()=>{
  const root=await mkdtemp(path.join(repo,'.prnext-compiler-options-'));
  try{
    const files={
      'package.json':'{"type":"module"}',
      'prnext.config.mjs':`import{appendFile}from'node:fs/promises';import path from'node:path';export default{prerender:{workers:1},compiler:{removeConsole:true,reactRemoveProperties:{properties:['^data-remove$']},define:{PUBLIC_VALUE:'public-compiled-value'},defineServer:{SERVER_VALUE:'server-compiled-marker'},async runAfterProductionCompile(context){await appendFile(path.join(context.projectDir,'hooks.jsonl'),JSON.stringify(context)+'\\n')}}}`,
      'app/layout.jsx':`export default({children})=><html><head/><body>{children}</body></html>`,
      'app/page.jsx':`import Client from'./client';export default()=> <><h1>{SERVER_VALUE}</h1><Client/></>`,
      'app/client.jsx':`'use client';import{useState}from'react';export default function Client(){const[n,set]=useState(0);console.log('removed-client-console-marker');return <button data-remove='remove-me' aria-label='Preserved' onClick={()=>set(n+1)}>{PUBLIC_VALUE} {n}</button>}`,
      'pages/legacy.jsx':`export function getStaticProps(){return{props:{value:SERVER_VALUE}}}export default function Page({value}){console.log('removed-pages-console-marker');return <p data-remove='remove-me'>{PUBLIC_VALUE} {value}</p>}`,
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)}
    const built=await build(root);
    const hooks=(await readFile(path.join(root,'hooks.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(hooks.length,1);assert.equal(hooks[0].projectDir,root);assert.ok(path.basename(hooks[0].distDir).startsWith('.prnext-build-'));
    for(const route of ['/','/legacy']){const entry=built.prerendered.find(x=>x.path===route);assert.ok(entry);const html=await readFile(path.join(built.outputDirectory,entry.file),'utf8');assert.match(html,/public-compiled-value/);assert.match(html,/server-compiled-marker/);assert.doesNotMatch(html,/data-remove/)}
    const assets=await readdir(path.join(built.outputDirectory,'assets'));let js='';for(const file of assets.filter(x=>x.endsWith('.js')))js+=await readFile(path.join(built.outputDirectory,'assets',file),'utf8');
    assert.match(js,/public-compiled-value/);assert.doesNotMatch(js,/server-compiled-marker|removed-client-console-marker|removed-pages-console-marker/);
    await build(root,{dev:true,incremental:true});assert.equal((await readFile(path.join(root,'hooks.jsonl'),'utf8')).trim().split('\n').length,1,'development must not run the production callback');
    const configFile=path.join(root,'prnext.config.mjs');await writeFile(configFile,(await readFile(configFile,'utf8')).replace('public-compiled-value','updated-compiled-value'));
    const rebuilt=await build(root,{dev:true,incremental:true}),route=rebuilt.routes.find(x=>x.pattern==='/legacy');
    const output=await readFile(path.join(rebuilt.outputDirectory,'assets',path.basename(route.client)),'utf8');assert.match(output,/updated-compiled-value/);assert.doesNotMatch(output,/public-compiled-value/);
  }finally{await closeIncrementalCompiler(root);await rm(root,{recursive:true,force:true})}
});
test('styled-jsx is detected without compiler configuration and its SSR runtime is embedded',async()=>{
  const root=await mkdtemp(path.join(repo,'.prnext-auto-styled-jsx-'));
  try{await mkdir(path.join(root,'pages'));await writeFile(path.join(root,'package.json'),'{}');await writeFile(path.join(root,'pages/index.jsx'),`export default()=> <main><p>Automatic CSS</p><style jsx>{'p{color:rgb(1,2,3)}'}</style></main>`);const built=await build(root);assert.equal(built.config.styledJsx,true);const html=await readFile(path.join(built.outputDirectory,built.prerendered.find(x=>x.path==='/').file),'utf8');assert.match(html,/p\.jsx-/);assert.match(html,/color:rgb\(1,2,3\)/);assert.doesNotMatch(await readFile(path.join(built.outputDirectory,'compat/styled-jsx.cjs'),'utf8'),/require\(["']styled-jsx/);}finally{await rm(root,{recursive:true,force:true})}
});
