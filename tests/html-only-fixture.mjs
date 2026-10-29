import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';
import { fontBytes } from './font-fixture.mjs';

export async function htmlOnlyFixture({ output, webpack = false } = {}) {
  const fixture = await appFixture();
  const write = async (name, content) => { const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content); };
  const config = extra => `export default{basePath:'/docs',htmlOnly:['/legal','/other','/guide/[slug]'],prerender:{workers:1}${output==='export'?'':",async rewrites(){return[{source:'/masked',destination:'/legal'}]}"}${webpack?',webpack(config){return config}':''}${output?`,output:${JSON.stringify(output)}`:''}${extra?','+extra:''}}`;
  try {
    for (const name of ['app','pages','components','lib','proxy.ts']) await rm(path.join(fixture.root,name),{recursive:true,force:true});
    for (const [name,source] of Object.entries({
      'prnext.config.mjs':config(),
      'fonts/local.ttf':await fontBytes(),
      'fonts/shared.js':`import localFont from 'next/font/local';export const body=localFont({src:'./local.ttf',preload:true,adjustFontFallback:false});`,
      'app/layout.jsx':`import './layout.css';import{body}from'../fonts/shared';export const metadata={title:'Static document',description:'Preserved metadata'};export default function Layout({children}){return <html lang="en"><head/><body className={body.className}>{children}</body></html>}`,
      'app/layout.css':'body{margin:24px;background:rgb(10,20,30);color:white}.tone{color:rgb(22,110,77)}',
      'app/page.jsx':`export default function Page(){return <h1>Home</h1>}`,
      'app/legal/page.jsx':`import{Suspense}from'react';export const metadata={title:'Legal document',description:'Legal description',alternates:{canonical:'https://example.test/legal'}};async function Content(){await new Promise(resolve=>setTimeout(resolve,80));return <p data-testid="resolved">Fully resolved content</p>}export default function Page(){return <main><h1 className="tone">Legal document</h1><Suspense fallback={<p data-testid="pending">Pending</p>}><Content/></Suspense><a href="/docs/other">Other document</a><a href="/docs/interactive">Interactive</a></main>}`,
      'app/other/page.jsx':`export default function Page(){return <main><h1 className="tone">Other document</h1><a href="/docs/legal">Legal document</a></main>}`,
      'app/guide/[slug]/page.jsx':`export const dynamicParams=false;export function generateStaticParams(){return[{slug:'first'}]}export async function generateMetadata({params}){return{title:'Guide '+(await params).slug}}export default async function Page({params}){return <h1 className="tone">Guide {(await params).slug}</h1>}`,
      'app/guide/edit/page.jsx':`import Client from'../../interactive/client';export default function Page(){return <Client/>}`,
      'app/interactive/page.jsx':`import Client from'./client';export default function Page(){return <Client/>}`,
      'app/interactive/client.jsx':`'use client';import{useState,useEffect}from'react';import Link from'next/link';export default function Client(){const[count,set]=useState(0);useEffect(()=>{window.__interactiveReady=true},[]);return <main><h1>Interactive page</h1><button onClick={()=>set(count+1)}>Count {count}</button><Link href="/legal" prefetch={true}>Legal HTML</Link><Link href="/guide/first" prefetch={true}>Guide HTML</Link><Link href="/guide/edit" prefetch={false}>Edit hydrated</Link><Link href="/masked" prefetch={false}>Masked HTML</Link></main>}`,
    })) await write(name,source);
    return { ...fixture, write, config,
      async build() {
        const result=await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root],{cwd:repositoryRoot,env:process.env,maxBuffer:8*1024*1024});
        return {manifest:JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8')),stdout:result.stdout};
      },
    };
  } catch(error) {await fixture.remove();throw error;}
}
