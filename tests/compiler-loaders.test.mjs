import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appFixture, repositoryRoot, startServer } from './support.mjs';
const exec=promisify(execFile);
test('webpack callback and async loaders preserve React boundaries, Edge validation and tracked incremental reuse',async()=>{
  const f=await appFixture();let server;
  try {
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(f.root,name),{recursive:true,force:true});
    const files={
      'next.config.mjs':`export default {webpack(config,{isServer,nextRuntime,webpack}){config.resolve.alias.message=config.context+'/message.txt';config.module.rules.push({test:/\\.txt$/,use:[{loader:'./text-loader.cjs',options:{prefix:'loaded'}}]},{test:/\\.svg$/,use:['./component-loader.cjs']});config.plugins.push(new webpack.DefinePlugin({BUILD_LABEL:JSON.stringify(isServer?'server-'+nextRuntime:'browser')}),new webpack.EnvironmentPlugin({COMPAT_PLUGIN_LABEL:'environment-default'}),new webpack.BannerPlugin('Rustyx asset plugin test'),{apply(compiler){compiler.hooks.thisCompilation.tap('ExtraAsset',compilation=>{compilation.hooks.processAssets.tapPromise({name:'ExtraAsset',stage:webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL},async()=>{compilation.emitAsset('plugin/'+compiler.options.name+'.txt',new webpack.sources.RawSource('emitted via webpack'));});});}});return config}}`,
      'text-loader.cjs':`const fs=require('node:fs'),path=require('node:path');module.exports=function(source){const done=this.async();const {prefix}=this.getOptions({type:'object',properties:{prefix:{type:'string'}},additionalProperties:false});const dependency=path.join(this.rootContext,'suffix.txt');this.addDependency(dependency);fs.appendFileSync(path.join(this.rootContext,'loader-runs.log'),this.resourcePath+'\\n');this.emitFile('loader/asset.txt','emitted');setImmediate(()=>done(null,'export default '+JSON.stringify(prefix+':'+source.trim()+':'+fs.readFileSync(dependency,'utf8').trim())))}`,
      'component-loader.cjs':`module.exports=function(){return '\"use client\";import{useState}from\"react\";export default function Icon(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}>SVG {n}</button>}'}`,
      'message.txt':'hello','suffix.txt':'first','icon.svg':'<svg/>',
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx':`import message from'message';import Icon from'../icon.svg';export default()=> <><h1>{message}</h1><p>{BUILD_LABEL}</p><Icon/></>`,
      'app/edge/route.js':`import message from'message';export const runtime='edge';export function GET(){return Response.json({message,label:BUILD_LABEL,runtime:process.env.NEXT_RUNTIME,environment:process.env.COMPAT_PLUGIN_LABEL,metaEnvironment:import.meta.env.COMPAT_PLUGIN_LABEL})}`,
      'pages/legacy.jsx':`import message from'message';export default()=> <h1>{message}</h1>`,
    };
    for(const [name,source] of Object.entries(files)){const file=path.join(f.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    const build=()=>exec(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',f.root],{maxBuffer:4*1024*1024});
    await build();
    const first=await readFile(path.join(f.root,'loader-runs.log'),'utf8');
    await build();assert.equal(await readFile(path.join(f.root,'loader-runs.log'),'utf8'),first,'unchanged loaders are reused across compiler processes');
    await writeFile(path.join(f.root,'suffix.txt'),'second');await build();
    assert.ok((await readFile(path.join(f.root,'loader-runs.log'),'utf8')).length>first.length);
    server=await startServer(f.root);
    for(const route of ['/','/legacy']){const response=await fetch(server.url+route);assert.equal(response.status,200);assert.match(await response.text(),/loaded:hello:second/);}
    const edge=await fetch(server.url+'/edge');assert.equal(edge.status,200,server.output());
    assert.deepEqual(await edge.json(),{message:'loaded:hello:second',label:'server-edge',runtime:'edge',environment:'environment-default',metaEnvironment:'environment-default'});
    assert.equal(await(await fetch(server.url+'/_rustyx/assets/loader/asset.txt')).text(),'emitted');
    for(const target of ['node','browser','edge'])assert.equal(await(await fetch(server.url+'/_rustyx/assets/plugin/'+target+'.txt')).text(),'emitted via webpack');
    const manifest=await readFile(path.join(f.root,'.rustyx/manifest.json'),'utf8');
    await writeFile(path.join(f.root,'next.config.mjs'),files['next.config.mjs'].replace('return config',`config.plugins.push({apply(compiler){compiler.hooks.make.tapAsync('FailedPlugin',(_compilation,done)=>done(new Error('Intentional graph plugin failure')));}});return config`));
    await assert.rejects(build(),/Intentional graph plugin failure/);
    assert.equal(await readFile(path.join(f.root,'.rustyx/manifest.json'),'utf8'),manifest,'failed plugins leave the last valid build intact');
  }finally{await server?.close();await f.remove();}
});

test('Turbopack glob rules use the same loader pipeline without a webpack callback',async()=>{
  const f=await appFixture();let server;
  try{
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(f.root,name),{recursive:true,force:true});
    await mkdir(path.join(f.root,'pages'));
    await writeFile(path.join(f.root,'next.config.mjs'),`export default {turbopack:{rules:{'*.note':{loaders:['./note-loader.cjs'],as:'*.js'}}}}`);
    await writeFile(path.join(f.root,'note-loader.cjs'),`module.exports=source=>'export default '+JSON.stringify(source.trim())`);
    await writeFile(path.join(f.root,'message.note'),'Turbopack loader contract');
    await writeFile(path.join(f.root,'pages/index.jsx'),`import message from'../message.note';export default()=> <h1>{message}</h1>`);
    await exec(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',f.root]);
    server=await startServer(f.root);assert.match(await(await fetch(server.url)).text(),/Turbopack loader contract/);
  }finally{await server?.close();await f.remove()}
});
