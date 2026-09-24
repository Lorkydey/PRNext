import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';
export async function i18nFixture() {
  const f=await appFixture();
  try {
    for(const name of ['app','pages','proxy.ts','components'])await rm(path.join(f.root,name),{recursive:true,force:true});
    const files={
      'next.config.mjs':`export default {i18n:{locales:['en','fr','nl'],defaultLocale:'en',domains:[{domain:'en.test',defaultLocale:'en'},{domain:'fr.test',defaultLocale:'fr',http:true}]},generateBuildId:()=> 'i18n-test',rewrites:async()=>[{source:'/alias',destination:'/server'}]}`,
      'middleware.js':`import{NextResponse}from'next/server';export const config={matcher:'/server'};export default function middleware(req){const response=NextResponse.next();response.headers.set('x-locale',req.nextUrl.locale);response.headers.set('x-pathname',req.nextUrl.pathname);return response}`,
      'pages/_app.jsx':`import{useState}from'react';export default function App({Component,pageProps}){const[n,set]=useState(0);return <><button onClick={()=>set(n+1)}>count {n}</button><Component {...pageProps}/></>}`,
      'pages/index.jsx':`import Link from'next/link';import{useRouter}from'next/router';export default function Home(){const r=useRouter();return <><h1>Home {r.locale}</h1><p id='path'>{r.asPath}</p><Link href='/article/one'>Article</Link><Link href='/' locale='fr'>French</Link><Link href='/' locale='en'>English</Link></>}`,
      'pages/article/[id].jsx':`import Link from'next/link';import{useRouter}from'next/router';export function getStaticPaths({locales}){return{paths:locales.map(locale=>({params:{id:'one'},locale})),fallback:'blocking'}}export function getStaticProps({locale,locales,defaultLocale,params}){return{props:{locale,locales,defaultLocale,id:params.id},revalidate:60}}export default function Article(p){const r=useRouter();return <><h1>Article {p.locale} {p.id}</h1><p id='route'>{r.pathname}</p><p id='path'>{r.asPath}</p><Link href='/'>Home</Link></>}`,
      'pages/server.jsx':`export function getServerSideProps({locale,locales,defaultLocale,resolvedUrl}){return{props:{locale,locales,defaultLocale,resolvedUrl}}}export default(p)=><pre>{JSON.stringify(p)}</pre>`,
      'pages/404.jsx':`export function getStaticProps({locale}){return{props:{locale}}}export default({locale})=><h1>Missing {locale}</h1>`,
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(f.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)}
    return {...f,build:async()=>{await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/rustyx/cli.mjs'),'build',f.root]);return JSON.parse(await readFile(path.join(f.root,'.rustyx/manifest.json'),'utf8'))}};
  }catch(error){await f.remove();throw error}
}
