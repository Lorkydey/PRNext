// Opt-in oracle: PRNEXT_NEXT_REFERENCE=/absolute/path/to/node_modules/next npm run test:next-compat
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { appFixture, startServer, repositoryRoot } from './support.mjs';

const referenceVersion = '16.3.5';
async function nextServer(cli, root) {
  const socket = createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port; await new Promise(resolve=>socket.close(resolve));
  const child = spawn(process.execPath,[cli,'start',root,'--port',String(port),'--hostname','127.0.0.1'], {cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
  let output='';child.stdout.on('data',data=>{output=(output+data).slice(-16000)});child.stderr.on('data',data=>{output=(output+data).slice(-16000)});
  const close = async()=> {if(child.exitCode!==null || child.signalCode)return;await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')});};
  const url=`http://127.0.0.1:${port}`;
  try {
    for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(output);try{await fetch(url+'/plain.txt');return{url,close}}catch{await delay(50)}}
    throw new Error('Next reference did not start: '+output);
  }catch(error){await close();throw error}
}

test(`Next ${referenceVersion} and PRNext satisfy the same import, rendering, navigation and API contract`, {timeout:180000}, async()=>{
  assert.ok(process.env.PRNEXT_NEXT_REFERENCE,'Set PRNEXT_NEXT_REFERENCE to an installed next@16.3.5 package directory');
  const reference=path.resolve(process.env.PRNEXT_NEXT_REFERENCE);
  assert.equal(JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,referenceVersion);
  const f=await appFixture();let next,rust,browser;
  try{
    for(const name of ['app','pages','public','components','proxy.ts','tsconfig.json','next-env.d.ts'])await rm(path.join(f.root,name),{recursive:true,force:true});
    await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'prnext-next-contract',private:true,type:'module',dependencies:{next:referenceVersion,react:'19.3.0','react-dom':'19.3.0'}}));
    const files={
      'next.config.mjs':`export default {generateBuildId:()=> 'next-compat',redirects:async()=>[{source:'/old',destination:'/item/one',permanent:false}],rewrites:async()=>[{source:'/alias',destination:'/legacy?value=rewritten'}],webpack(config,{webpack}){config.module.rules.push({test:/\\.contract$/,use:['./contract-loader.cjs']});config.resolve.alias['contract-choice$']=[config.context+'/missing-contract.js',config.context+'/contract-value.js'];config.resolve.alias['contract-disabled']=false;config.plugins.push(new webpack.DefinePlugin({CONTRACT_FLAGS:{value:JSON.stringify('nested definition')}}));return config}}`,
      'contract-loader.cjs':`module.exports=function(){const done=this.async();this.importModule('./contract-value.js').then(value=>done(null,'export default '+JSON.stringify(value.default)),done)}`,
      'contract-value.js':`export default 'compiled dependency'`,
      'value.contract':'loader input',
      'app/layout.jsx':`import Counter from './counter';export const metadata={title:'Compatibility contract'};export default({children})=><html><body><Counter/>{children}</body></html>`,
      'app/counter.jsx':`'use client';import{useState}from'react';import{useRouter}from'next/compat/router';export default function Counter(){const[n,set]=useState(0);const router=useRouter();return <><p data-testid="compat-router">{router?.pathname||'no-pages-router'}</p><button onClick={()=>set(n+1)}>counter {n}</button></>}`,
      'app/page.jsx':`import Link from'next/link';export default()=> <main><h1>Contract home</h1><Link href='/item/one'>Item one</Link></main>`,
      'app/item/[id]/page.jsx':`import Link from'next/link';export function generateStaticParams(){return[{id:'one'}]}export default async({params})=><main><h1>Item {(await params).id}</h1><Link href='/'>Home</Link></main>`,
      'pages/legacy.jsx':`import Counter from'../app/counter';export const getServerSideProps=async({query})=>({props:{value:query.value||'plain'}});export default({value})=><><h1>Legacy {value}</h1><Counter/></>`,
      'pages/api/value.js':`import compiled from'../../value.contract';import choice from'contract-choice';import disabled from'contract-disabled';export default(req,res)=>{res.setHeader('x-contract','api');res.status(201).json({method:req.method,body:req.body,compiled,choice,disabled:Object.keys(disabled),flag:CONTRACT_FLAGS.value})}`,
      'pages/api/preview.js':`export default(req,res)=>{if(req.query.enable==='1')res.setPreviewData({value:'draft'});res.json({preview:req.preview===true,data:req.previewData||false})}`,
      'public/plain.txt':'contract public file',
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(f.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)}
    await symlink(reference,path.join(f.root,'node_modules/next'),'dir');
    // The reference is linked, so its server requires React beside that package.
    // Share the same real React files with the fixture to avoid duplicate dispatchers.
    for (const name of ['react','react-dom']) {
      const source=path.join(path.dirname(reference),name);
      assert.equal(JSON.parse(await readFile(path.join(source,'package.json'),'utf8')).version,'19.3.0');
      await rm(path.join(f.root,'node_modules',name),{recursive:true});
      await symlink(source,path.join(f.root,'node_modules',name),'dir');
    }
    const cli=path.join(reference,'dist/bin/next');
    await promisify(execFile)(process.execPath,[cli,'build',f.root,'--webpack'],{cwd:f.root,maxBuffer:4*1024*1024,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
    next=await nextServer(cli,f.root);
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',f.root],{maxBuffer:4*1024*1024});
    rust=await startServer(f.root);
    browser=await chromium.launch();
    const results=[];
    for(const server of [next,rust]){
      const result={};
      for(const url of ['/','/item/one','/legacy','/alias']){const response=await fetch(server.url+url);const html=await response.text();result[url]={status:response.status,heading:html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1].replace(/<!--.*?-->/gs,'')}}
      const redirect=await fetch(server.url+'/old',{redirect:'manual'});result.redirect={status:redirect.status,location:redirect.headers.get('location')};
      result.public=await(await fetch(server.url+'/plain.txt')).text();
      const api=await fetch(server.url+'/api/value',{method:'POST',headers:{'content-type':'application/json'},body:'{"value":42}'});result.api={status:api.status,header:api.headers.get('x-contract'),body:await api.json()};
      const enable=await fetch(server.url+'/api/preview?enable=1');const cookie=enable.headers.getSetCookie().map(line=>line.split(';')[0]).join('; ');result.preview=await(await fetch(server.url+'/api/preview',{headers:{cookie}})).json();
      const page=await browser.newPage();const errors=[];let documents=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.resourceType()==='document')documents++});
      await page.goto(server.url);await page.getByRole('button',{name:'counter 0'}).click();await page.getByRole('link',{name:'Item one'}).click();await page.getByRole('heading',{name:'Item one'}).waitFor();
      result.browser={title:await page.title(),counter:await page.getByRole('button').textContent(),documents,compat:await page.getByTestId('compat-router').textContent(),errors};
      await page.goto(server.url+'/legacy');result.legacyCompat=await page.getByTestId('compat-router').textContent();
      await page.close();results.push(result);
    }
    assert.deepEqual(results[1],results[0]);
    assert.equal(results[1].browser.counter,'counter 1');assert.equal(results[1].browser.documents,1);assert.deepEqual(results[1].browser.errors,[]);
    assert.deepEqual(results[1].preview,{preview:true,data:{value:'draft'}});
    assert.equal(results[1].api.body.compiled,'compiled dependency');assert.equal(results[1].api.body.choice,'compiled dependency');assert.deepEqual(results[1].api.body.disabled,[]);assert.equal(results[1].api.body.flag,'nested definition');
    assert.equal(results[1].browser.compat,'no-pages-router');assert.equal(results[1].legacyCompat,'/legacy');
  }finally{await browser?.close();await rust?.close();await next?.close();await f.remove()}
});

test(`Next ${referenceVersion} and PRNext agree on Pages locale rendering and domain routing`, {timeout:180000}, async()=>{
  const {i18nFixture}=await import('./i18n-fixture.mjs');
  const {request}=await import('node:http');
  const reference=path.resolve(process.env.PRNEXT_NEXT_REFERENCE || 'missing');
  assert.equal(JSON.parse(await readFile(path.join(reference,'package.json'),'utf8')).version,referenceVersion);
  const f=await i18nFixture();let next,rust;
  const hostRequest=(url,host)=>new Promise((resolve,reject)=>request(url,{headers:{host}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString()}))}).on('error',reject).end());
  try{
    for(const name of ['tsconfig.json','next-env.d.ts'])await rm(path.join(f.root,name),{force:true});
    await symlink(reference,path.join(f.root,'node_modules/next'),'dir');
    for(const name of ['react','react-dom']){await rm(path.join(f.root,'node_modules',name),{recursive:true});await symlink(path.join(path.dirname(reference),name),path.join(f.root,'node_modules',name),'dir')}
    const cli=path.join(reference,'dist/bin/next');
    await promisify(execFile)(process.execPath,[cli,'build',f.root,'--webpack'],{cwd:f.root,maxBuffer:4*1024*1024,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
    next=await nextServer(cli,f.root);await f.build();rust=await startServer(f.root);
    const bootstrap = html => {
      const nextData=/<script\b(?=[^>]*id="__NEXT_DATA__")[^>]*>([\s\S]*?)<\/script>/.exec(html);
      if(nextData)return JSON.parse(nextData[1]);
      const rustData=/window\.__PRNEXT_DATA__=JSON\.parse\(("(?:\\.|[^"\\])*")\)/.exec(html);assert.ok(rustData,html.slice(0,2000));
      const value=JSON.parse(JSON.parse(rustData[1]));return {...value.router,props:{pageProps:value.props}};
    };
    const results=[];
    for(const server of [next,rust]){
      const result={};
      for(const path of ['/','/fr','/nl/article/one','/fr/article/unknown','/fr/missing','/fr/server']){
        const response=await fetch(server.url+path);const html=await response.text();
        const data=bootstrap(html);
        result[path]={status:response.status,locale:data.locale,defaultLocale:data.defaultLocale,props:data.props.pageProps,heading:html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1].replace(/<!--.*?-->/gs,'')};
      }
      const domain=await hostRequest(server.url+'/server','fr.test');
      const data=bootstrap(domain.text);
      result.domain={status:domain.status,locale:domain.headers['x-locale'],path:domain.headers['x-pathname'],props:data.props.pageProps,defaultLocale:data.defaultLocale};
      const redirect=await fetch(server.url,{headers:{'accept-language':'fr-BE;q=0.9,en;q=0.5'},redirect:'manual'});result.redirect={status:redirect.status,location:redirect.headers.get('location')};
      results.push(result);
    }
    assert.deepEqual(results[1],results[0]);
  }finally{await rust?.close();await next?.close();await f.remove()}
});
