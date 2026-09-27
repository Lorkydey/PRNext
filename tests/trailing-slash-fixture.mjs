import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appFixture, repositoryRoot } from './support.mjs';

export async function trailingSlashFixture(config = {}) {
  const fixture = await appFixture();
  const write = async (name, source) => { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); };
  try {
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), {recursive:true, force:true});
    await write('prnext.config.mjs', `export default {...${JSON.stringify(config)},generateBuildId:()=> 'slash-fixture',async headers(){return[{source:'/:path*',headers:[{key:'x-configured-slash',value:'yes'}]}]},async redirects(){return[{source:'/old',destination:'/legacy/redirected',permanent:false}]},async rewrites(){return[{source:'/configured/:slug',destination:'/legacy/:slug?configured=yes'}]}}`);
    const files = {
      'proxy.js': `import{NextResponse}from'next/server';export function proxy(request){let response;if(request.nextUrl.pathname.startsWith('/alias/')){const target=request.nextUrl.clone();target.pathname=target.pathname.replace('/alias/','/legacy/');response=NextResponse.rewrite(target)}else response=NextResponse.next();response.headers.set('x-probe-path',request.nextUrl.pathname);response.headers.set('x-probe-url',request.url);response.headers.set('x-probe-rsc',request.headers.get('rsc')||'absent');response.headers.set('x-probe-tree',request.headers.get('next-router-state-tree')||'absent');return response}export const config={matcher:['/legacy/:path*','/alias/:path*','/app/:path*','/api/:path*','/plain','/']}`,
      'pages/_app.jsx': `import{useState,useEffect}from'react';import{useRouter}from'next/router';import Link from'next/link';export default function App({Component,pageProps}){const[count,setCount]=useState(0),router=useRouter();useEffect(()=>{window.__slashRouter=router},[router]);return <><button data-testid="count" onClick={()=>setCount(count+1)}>{count}</button><pre data-testid="router">{JSON.stringify({pathname:router.pathname,asPath:router.asPath})}</pre><Link href="/" prefetch={false} data-testid="home-link">Home</Link><Link href="/legacy/linked?query=one#anchor" prefetch={false} data-testid="page-link">Page</Link><Link href="/plain/" prefetch={false} data-testid="plain-link">Plain</Link><Link href="/alias/rewritten?query=one" prefetch={false} data-testid="alias-link">Alias</Link><Component {...pageProps}/></>}`,
      'pages/index.jsx': `export default function Home(){return <h1>Home</h1>}`,
      'pages/plain.jsx': `export default function Plain(){return <h1>Plain page</h1>}`,
      'pages/legacy/[slug].jsx': `export const getServerSideProps=({params,req,query,resolvedUrl})=>({props:{params,url:req.url,query,resolvedUrl}});export default function Page(props){return <><h1 id="anchor">Page {props.params.slug}</h1><pre data-testid="props">{JSON.stringify(props)}</pre></>}`,
      'pages/cached.jsx': `export const getStaticProps=()=>({props:{seed:'cached'}});export default function Page({seed}){return <h1>{seed}</h1>}`,
      'pages/api/echo.js': `export default function handler(req,res){res.json({method:req.method,body:req.body,url:req.url})}`,
      'public/file.txt': 'public content',
      'public/pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYKjYAgABqQEtEfonzQAAAABJRU5ErkJggg==', 'base64'),
      'public/.well-known/token': 'well known',
      'public/plain-file': 'extensionless public',
      'app/layout.jsx': `import Shell from'../components/shell';export default function Layout({children}){return <html><body><Shell/>{children}</body></html>}`,
      'components/shell.jsx': `'use client';import{useState,useEffect}from'react';import{useRouter,usePathname}from'next/navigation';import Link from'next/link';export default function Shell(){const[count,setCount]=useState(0),router=useRouter(),pathname=usePathname();useEffect(()=>{window.__slashAppRouter=router},[router]);return <><button data-testid="app-count" onClick={()=>setCount(count+1)}>{count}</button><pre data-testid="app-path">{pathname}</pre><Link href="/app/other?query=one" data-testid="app-link">Other</Link><Link href="/app/start/" data-testid="app-start">Start</Link></>}`,
      'app/app/start/page.jsx': `export default function Page(){return <h1>App start</h1>}`,
      'app/app/other/page.jsx': `export default function Page(){return <h1>App other</h1>}`,
    };
    for (const [name, source] of Object.entries(files)) await write(name, source);
    await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], {maxBuffer: 4 * 1024 * 1024});
    const manifest = JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    return {...fixture,manifest};
  } catch(error) { await fixture.remove(); throw error; }
}
