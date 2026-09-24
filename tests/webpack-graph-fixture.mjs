import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {appFixture,repositoryRoot} from './support.mjs';

export async function webpackGraphFixture(){
  const fixture=await appFixture();
  try{
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(fixture.root,name),{recursive:true,force:true});
    const files={
      'next.config.mjs':`import path from 'node:path';export default {webpack(config,{webpack}){config.plugins.push(new webpack.NormalModuleReplacementPlugin(/replace-message\\.js$/,path.join(config.context,'replacement.js')),new webpack.ProvidePlugin({GRAPH_NUMBER:path.join(config.context,'number.cjs')}),{apply(compiler){compiler.hooks.compilation.tap('RealGraph',compilation=>{compilation.emitAsset('before-entry-'+compiler.options.name+'-'+compiler.options.optimization.minimize+'.js',new webpack.sources.RawSource('/* independent asset */'));compilation.hooks.optimizeModules.tap('RealGraph',modules=>{if(![...modules].some(m=>m.resource))throw new Error('Expected real application modules')});compilation.hooks.processAssets.tap({name:'RewriteBundles',stage:webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE+1},()=>{for(const asset of compilation.getAssets()){if(/\\.m?js$/.test(asset.name))compilation.updateAsset(asset.name,new webpack.sources.ConcatSource(asset.source,'\\n/* GRAPH_PLUGIN_ASSET */'));}});});}});return config}}`,
      'replacement.js':`export default 'Replaced by graph plugin'`,
      'number.cjs':`module.exports=7`,
      'components/counter.module.css':`.counter{color:rgb(12,34,56);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E")}`,
      'components/lazy.jsx':`export default()=> <p data-testid="lazy">Lazy chunk works</p>`,
      'components/counter.jsx':`'use client';import{useState,useId}from'react';import dynamic from'next/dynamic';import styles from'./counter.module.css';const Lazy=dynamic(()=>import('./lazy'));export default function Counter(){const[n,set]=useState(0),id=useId();return <><label data-testid="id-label" htmlFor={id}>Identity</label><input data-testid="id-input" id={id}/><button className={styles.counter} onClick={()=>set(n+1)}>Count {n}</button>{n>0&&<Lazy/>}</>}`,
      'pages/legacy.jsx':`import Link from'next/link';import Counter from'../components/counter';import message from'../replace-message.js';export default function Legacy(){return <><h1>{message} {GRAPH_NUMBER}</h1><Counter/><Link href="/other">Other legacy page</Link></>}`,
      'pages/other.jsx':`import Link from'next/link';export default()=> <><h1>Other legacy</h1><Link href="/legacy">Back</Link></>`,
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx':`import Link from'next/link';import{cookies}from'next/headers';import Counter from'../components/counter';import message from'../replace-message.js';import{rename}from'./actions';export default async function Page(){return <><h1>{message} {GRAPH_NUMBER}</h1><p data-testid="visitor">{(await cookies()).get('visitor')?.value||'guest'}</p><Counter/><form action={rename}><button>Rename</button></form><Link href="/next">Other app page</Link></>}`,
      'app/actions.js':`'use server';import{cookies}from'next/headers';export async function rename(){(await cookies()).set('visitor','graph action')}`,
      'app/next/page.jsx':`import Link from'next/link';export default()=> <><h1>Other app</h1><Link href="/">Back</Link></>`,
      'app/static-id/page.jsx':`import Counter from'../../components/counter';export default()=> <><h1>Static identity</h1><Counter/></>`,
      'app/edge/route.js':`export const runtime='edge';import message from'../../replace-message.js';export const GET=()=>Response.json({message,number:GRAPH_NUMBER})`,
    };
    for(const [name,source]of Object.entries(files)){const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    return {...fixture,build:async()=>{
      await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',fixture.root],{maxBuffer:8*1024*1024});
      return JSON.parse(await readFile(path.join(fixture.root,'.rustyx/manifest.json'),'utf8'));
    }};
  }catch(error){await fixture.remove();throw error;}
}
