import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {build as bundle} from 'esbuild';
import {applicationEntry} from './framework-imports.mjs';
import {build} from './index.mjs';

async function fixture(run){
 const root=await mkdtemp(path.resolve('.prnext-boundary-test-'));
 try{await run(root,async(file,source)=>{const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,source);});}
 finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

test('unsupported TypeScript extensions reject framework directives but preserve ordinary helpers',async()=>fixture(async(root,write)=>{
 const compile=file=>bundle({absWorkingDir:root,entryPoints:[file],bundle:true,write:false,logLevel:'silent',plugins:[{name:'boundary-test',setup:builder=>applicationEntry(builder)}]});
 for(const extension of ['mts','cts']){
  for(const source of ["'use server';export async function save(){return 'SERVER_ONLY_MARKER'}","'use client';export const component=1;","export async function save(){'use server';return 'INLINE_SERVER_MARKER'}"]){
   await write('entry.'+extension,source);await assert.rejects(compile('entry.'+extension),/React server\/client directives are not supported.*Rename this file to \.ts or \.tsx/s);
  }
  await write('value.'+extension,'export const value:number=42;');
  await write('entry.'+extension,`import{value}from'./value.${extension}';export const result=value;export const message='use server';`);
  const result=await compile('entry.'+extension);assert.match(result.outputFiles[0].text,/42/);
 }
 await write('value.cts','module.exports={value:42};');
 await write('entry.cts',"const{value}=require('./value.cts');exports.result=value;function ordinary(){'use client';return value}");
 assert.match((await compile('entry.cts')).outputFiles[0].text,/42/);
 await write('entry.mts',"function decorate(value:any){return value};@decorate class Value{answer=42};export const value=new Value();");
 assert.match((await compile('entry.mts')).outputFiles[0].text,/42/);
}));

test('App and Pages cannot publish untransformed server modules in mts/cts files',async()=>fixture(async(root,write)=>{
 await write('package.json','{"type":"module"}');await write('postcss.config.json','{"plugins":[]}');
 await write('app/layout.jsx','export default({children})=><html><body>{children}</body></html>');
 await write('app/page.jsx','export default()=> <p>Last good build</p>');
 await build(root);await write('.prnext/last-good-proof','preserved');
 for(const extension of ['mts','cts']){
  await write('app/actions.'+extension,"'use server';const secret='SERVER_ONLY_MARKER';export async function save(){return secret}");
  await write('app/client.jsx',`'use client';import{save}from'./actions.${extension}';export default()=> <form action={save}><button>Save</button></form>`);
  await write('app/page.jsx',"import Client from'./client';export default()=> <Client/>");
  await assert.rejects(build(root),/React server\/client directives are not supported/);
  await assert.rejects(build(root,{dev:true}),/React server\/client directives are not supported/);
  assert.equal(await readFile(path.join(root,'.prnext/last-good-proof'),'utf8'),'preserved');
  await write('app/page.jsx','export default()=> <p>Last good build</p>');
  await write('pages/legacy.jsx',`import{save}from'../app/actions.${extension}';export default()=> <button onClick={()=>save()}>Save</button>`);
  await assert.rejects(build(root),/React server\/client directives are not supported/);
  await rm(path.join(root,'pages'),{recursive:true});
 }
 assert.equal((await readdir(root)).some(name=>name.startsWith('.prnext-build-')),false);
}));

test('a custom TypeScript loader cannot bypass unsupported framework boundary checks',async()=>fixture(async(root,write)=>{
 await write('package.json','{"type":"module"}');await write('postcss.config.json','{"plugins":[]}');
 await write('prnext.config.mjs',"export default{webpack(config){config.module.rules.push({test:/\\.mts$/,use:['boundary-loader']});return config}}");
 await write('node_modules/boundary-loader/package.json','{"name":"boundary-loader","main":"index.cjs"}');
 await write('node_modules/boundary-loader/index.cjs',`module.exports=source=>source.includes('RAW_DIRECTIVE_MARKER')?source.replace("'use server';",''):"'use server';\\n"+source`);
 await write('app/layout.jsx','export default({children})=><html><body>{children}</body></html>');
 await write('app/page.jsx',"import Client from'./client';export default()=> <Client/>");
 await write('app/client.jsx',"'use client';import{save}from'./actions.mts';export default()=> <form action={save}><button>Save</button></form>");
 await write('app/actions.mts',"export async function save(){return 'LOADER_SERVER_MARKER'}");
 await assert.rejects(build(root),/React server\/client directives are not supported/);
 await write('app/actions.mts',"'use server';export async function save(){return 'RAW_DIRECTIVE_MARKER'}");
 await assert.rejects(build(root),/React server\/client directives are not supported/);
}));
