import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function deploymentFixture({ basePath = '/docs', assetPrefix = '', cdn = false } = {}) {
  const fixture = await appFixture();
  const assetRequests = [];
  let assets;
  if (cdn) {
    assets = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://assets');
      assetRequests.push(url.pathname);
      response.setHeader('access-control-allow-origin', '*');
      const name = url.pathname.slice('/cdn/_rustyx/assets/'.length);
      if (!url.pathname.startsWith('/cdn/_rustyx/assets/') || path.basename(name) !== name) { response.writeHead(404); response.end(); return; }
      try {
        const body = await readFile(path.join(fixture.root, '.rustyx/assets', name));
        response.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' })[path.extname(name)] || 'application/octet-stream');
        response.setHeader('cache-control', 'public, max-age=31536000, immutable');
        response.end(body);
      } catch { response.writeHead(404); response.end(); }
    });
    assets.listen(0, '127.0.0.1');
    await once(assets, 'listening');
    assetPrefix = `http://127.0.0.1:${assets.address().port}/cdn`;
  }
  const write = async (file, source) => { const filename = path.join(fixture.root, file); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); };
  const closeAssets = async () => { if (assets) { assets.closeAllConnections(); await new Promise(resolve => assets.close(resolve)); } };
  try {
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'rustyx.config.mjs': `export default {basePath:${JSON.stringify(basePath)},assetPrefix:${JSON.stringify(assetPrefix)},generateBuildId:()=> 'deployment-fixture',async headers(){return[{source:'/legacy/:slug',headers:[{key:'x-configured',value:'yes'}]},{source:'/outside-header',basePath:false,headers:[{key:'x-outside',value:'yes'}]}]},async redirects(){return[{source:'/configured',destination:'/legacy/configured?from=config',permanent:false},{source:'/outside-redirect',basePath:false,destination:'https://example.test/landing',permanent:false}]},async rewrites(){return[{source:'/alias/:slug',destination:'/legacy/:slug?injected=rule'}]}}`,
      'proxy.js': `import{NextResponse}from'next/server';export function proxy(request){const target=request.nextUrl.clone();target.pathname=target.pathname.replace('/via/','/legacy/');if(request.nextUrl.pathname==='/inspect'){target.pathname='/legacy/cloned';return NextResponse.json({url:request.url,pathname:request.nextUrl.pathname,basePath:request.nextUrl.basePath,href:request.nextUrl.href,clone:target.href})}target.searchParams.set('injected','middleware');return NextResponse.rewrite(target)}export const config={matcher:['/via/:slug','/inspect']}`,
      'public/public.txt': 'deployed public content',
      'pages/_app.jsx': `import{useState,useEffect}from'react';import{useRouter}from'next/router';import Link from'next/link';export default function App({Component,pageProps}){const[count,setCount]=useState(0),router=useRouter();useEffect(()=>{window.__deploymentRouter=router},[router]);return <><button data-testid="pages-count" onClick={()=>setCount(count+1)}>Pages {count}</button><pre data-testid="pages-router">{JSON.stringify({pathname:router.pathname,asPath:router.asPath,basePath:router.basePath,query:router.query})}</pre><nav><Link prefetch={false} href="/" data-testid="to-root">Root</Link><Link prefetch={false} href="/plain" data-testid="to-plain">Plain</Link><Link prefetch={false} href="/legacy/one?from=link" data-testid="to-legacy">Legacy</Link><Link prefetch={false} href="/alias/book?from=alias" data-testid="to-alias">Alias</Link><Link prefetch={false} href="/via/book?from=via" data-testid="to-via">Middleware</Link><Link prefetch={false} href="/cached/seed" data-testid="to-cached">Cached</Link><Link prefetch={false} href="/app" data-testid="to-app">Application</Link></nav><Component {...pageProps}/></>}`,
      'pages/index.jsx': `export default function Home(){return <h1>Deployment home</h1>}`,
      'pages/plain.jsx': `import Head from'next/head';import styles from'../components/deployed.module.css';import picture from'../components/mark.svg';export default function Plain(){return <><Head><title>Deployed plain page</title></Head><h1 className={styles.heading} data-testid="styled-title">Deployed plain page</h1><img data-testid="imported-picture" src={picture.src} alt="Deployment mark"/><a href=${JSON.stringify(basePath + '/public.txt')} data-testid="public-link">Public file</a></>}`,
      'components/deployed.module.css': '.heading { color: rgb(39, 83, 121); background-image: url("./mark.svg"); }',
      'components/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#275379"/></svg>',
      'pages/legacy/[slug].jsx': `export const getServerSideProps=({req,params,query,resolvedUrl})=>({props:{url:req.url,params,query,resolvedUrl}});export default function Legacy(props){return <><h1>Legacy {props.params.slug}</h1><pre data-testid="legacy-props">{JSON.stringify(props)}</pre></>}`,
      'pages/cached/[slug].jsx': `import{useRouter}from'next/router';export const getStaticPaths=()=>({paths:[{params:{slug:'seed'}}],fallback:true});export const getStaticProps=({params})=>({props:{slug:params.slug},revalidate:60});export default function Cached({slug}){return useRouter().isFallback?<p data-testid="cached-fallback">Loading cached page</p>:<h1>Cached {slug}</h1>}`,
      'pages/go/[mode].jsx': `export const getServerSideProps=({params})=>({redirect:{destination:params.mode==='prefixed'?${JSON.stringify(basePath + '/plain')}:params.mode==='outside'?'/outside':'/plain',permanent:false,...(params.mode==='outside'?{basePath:false}:{})}});export default function Page(){return null}`,
      'pages/api/echo.js': `export default function handler(req,res){res.json({url:req.url,query:req.query})}`,
      'app/layout.jsx': `import Shell from'../components/AppShell';export default function Layout({children}){return <html><body><Shell/>{children}</body></html>}`,
      'components/AppShell.jsx': `'use client';import{useState}from'react';import{usePathname,useSearchParams}from'next/navigation';import Link from'next/link';export default function Shell(){const[count,setCount]=useState(0),pathname=usePathname(),search=useSearchParams();return <><button data-testid="app-count" onClick={()=>setCount(count+1)}>App {count}</button><pre data-testid="app-path">{pathname}</pre><pre data-testid="app-search">{search.toString()}</pre><Link href="/app" data-testid="app-home">Home</Link><Link href="/app/other?from=link" data-testid="app-other">Other</Link><Link href="/plain" data-testid="app-pages">Pages</Link></>}`,
      'app/app/page.jsx': `import{cookies}from'next/headers';import{redirect}from'next/navigation';import{revalidatePath}from'next/cache';import Lazy from'../../components/LazyShelf';export const dynamic='force-dynamic';export default async function Page(){const count=Number((await cookies()).get('deployment-count')?.value||0);async function increment(){'use server';const jar=await cookies();jar.set('deployment-count',String(Number(jar.get('deployment-count')?.value||0)+1),{path:${JSON.stringify(basePath || '/')}});revalidatePath('/app')}async function move(){'use server';redirect('/app/other?from=action')}async function publicMove(){'use server';redirect(${JSON.stringify(basePath + '/app/other?from=public-action')})}return <><h1>Deployed application</h1><p data-testid="action-count">{count}</p><form action={increment}><button data-testid="increment-action">Increment action</button></form><form action={move}><button data-testid="redirect-action">Redirect action</button></form><form action={publicMove}><button data-testid="public-redirect-action">Public redirect action</button></form><Lazy/></>}`,
      'components/LazyShelf.jsx': `'use client';import{useState}from'react';import dynamic from'next/dynamic';const Widget=dynamic(()=>import('./LazyWidget'),{loading:()=> <p>Loading deployed widget</p>});export default function Shelf(){const[show,setShow]=useState(false);return <><button data-testid="show-widget" onClick={()=>setShow(true)}>Show deployed widget</button>{show&&<Widget/>}</>}`,
      'components/LazyWidget.jsx': `'use client';import{useState}from'react';export default function Widget(){const[n,setN]=useState(0);return <button data-testid="deployed-widget" onClick={()=>setN(n+1)}>Deployed widget {n}</button>}`,
      'app/app/other/page.jsx': `export default function Other(){return <h1>Application other</h1>}`,
      'app/nav-go/[mode]/page.jsx': `import{redirect}from'next/navigation';export default async function Page({params}){const{mode}=await params;redirect(mode==='prefixed'?${JSON.stringify(basePath + '/app')}:'/app')}`,
      'app/api/url/route.js': `export function GET(request){const clone=request.nextUrl.clone();clone.pathname='/app/other';return Response.json({url:request.url,pathname:request.nextUrl.pathname,basePath:request.nextUrl.basePath,href:request.nextUrl.href,clone:clone.href})}`,
    };
    for (const [file, source] of Object.entries(files)) await write(file, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { root: fixture.root, manifest, basePath, assetPrefix, assetRequests, build, write,
      async remove() { await closeAssets(); await fixture.remove(); },
    };
  } catch (error) { await closeAssets(); await fixture.remove(); throw error; }
}
