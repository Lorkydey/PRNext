import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function pagesNavigationFixture({ withRouting = true } = {}) {
  const fixture = await appFixture();
  const counts = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://origin').pathname.slice(1);
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    await gates.get(key)?.promise;
    if (!response.destroyed) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ originKey: key, count }));
    }
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const write = async (file, source) => {
    const filename = path.join(fixture.root, file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  };
  try {
    for (const file of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, file), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': withRouting ? `export default {generateBuildId:()=> 'pages-navigation-fixture',async rewrites(){return [{source:'/alias/:slug',destination:'/server/:slug?injected=rewrite&collision=target'}]},async redirects(){return [{source:'/configured-redirect',destination:'/server/configured?via=redirect',permanent:false}]}}` : `export default {generateBuildId:()=> 'pages-navigation-fixture'}`,
      'proxy.js': `import{NextResponse}from'next/server';export function proxy(request){const target=request.nextUrl.clone(),person=request.cookies.get('person')?.value||'anonymous';target.pathname=target.pathname==='/isr/personal'?'/isr/'+person:target.pathname.replace('/via/','/server/');target.searchParams.set('injected','middleware');const headers=new Headers(request.headers);headers.set('x-navigation-person',person);return NextResponse.rewrite(target,{request:{headers}})}export const config={matcher:['/via/:path*','/isr/personal']}`,
      'lib/read.js': `export async function read(key){return(await fetch(${JSON.stringify(originUrl)}+'/'+encodeURIComponent(key))).json()}`,
      'pages/_app.jsx': `import{useEffect,useState}from'react';import Router,{useRouter}from'next/router';import Link from'next/link';
        export default function App({Component,pageProps}){const[count,setCount]=useState(0),router=useRouter();
        useEffect(()=>{window.__pagesRouter=Router;window.__appMounts=(window.__appMounts||0)+1;window.__routeEvents=[];const names=['routeChangeStart','beforeHistoryChange','routeChangeComplete','routeChangeError','hashChangeStart','hashChangeComplete'];const listeners=names.map(name=>{const handler=(...args)=>window.__routeEvents.push([name,...args.map(value=>value instanceof Error?{cancelled:value.cancelled,message:value.message}:value)]);Router.events.on(name,handler);return[name,handler]});return()=>listeners.forEach(([name,handler])=>Router.events.off(name,handler))},[]);
        return <><button data-testid="app-count" onClick={()=>setCount(count+1)}>App count {count}</button><nav>
        <Link prefetch={false} href="/" data-testid="nav-home">Home</Link><Link prefetch={false} href="/other" data-testid="nav-other">Other</Link>
        <Link prefetch={false} href="/server/one?from=link" data-testid="nav-server">Server</Link><Link prefetch={false} href="/alias/book?collision=visible&tag=a&tag=b" data-testid="nav-alias">Alias</Link>
        <Link prefetch={false} href="/via/book?from=middleware" data-testid="nav-middleware">Middleware</Link><Link prefetch={false} href="/isr/seed" data-testid="nav-static">Static</Link>
        <Link prefetch={false} href="/app-side" data-testid="nav-app">App router</Link><Link prefetch={false} href="/other" onNavigate={event=>event.preventDefault()} data-testid="nav-cancelled">Stay here</Link>
        </nav><pre data-testid="router">{JSON.stringify({pathname:router.pathname,asPath:router.asPath,query:router.query,isFallback:router.isFallback})}</pre><Component {...pageProps}/></>}`,
      'pages/index.jsx': `import Head from'next/head';export default function Home(){return <><Head><title>Navigation home</title></Head><h1>Navigation home</h1><div style={{height:1800}}/><h2 id="bottom">Bottom destination</h2></>}`,
      'pages/other.jsx': `import Head from'next/head';import styles from'../components/other.module.css';export default function Other(){return <><Head><title>Other page</title><meta name="description" content="Other navigation page"/></Head><h1 className={styles.heading} data-testid="other-heading">Other page</h1></>}`,
      'components/other.module.css': '.heading { color: rgb(73, 19, 137); }',
      'pages/server/[slug].jsx': `import{useState}from'react';import Head from'next/head';import{read}from'../../lib/read';
        export async function getServerSideProps({req,res,params,query,resolvedUrl}){const data=await read('server-'+params.slug);res.setHeader('x-navigation-data','present');if(query.cookie)res.setHeader('set-cookie',['navigation=one; Path=/','navigation-two=two; HttpOnly; Path=/']);return{props:{...data,slug:params.slug,query,url:req.url,resolvedUrl,person:req.headers['x-navigation-person']||req.cookies.person||'anonymous'}}}
        export default function Server(props){const[count,setCount]=useState(0);return <><Head><title>{'Server '+props.slug}</title></Head><h1>Server {props.slug}</h1><pre data-testid="server-props">{JSON.stringify(props)}</pre><button data-testid="page-count" onClick={()=>setCount(count+1)}>Page count {count}</button></>}`,
      'pages/isr/[slug].jsx': `import{read}from'../../lib/read';import{useRouter}from'next/router';import Head from'next/head';export const getStaticPaths=()=>({paths:[{params:{slug:'seed'}}],fallback:true});export const getStaticProps=async({params})=>({props:{...await read('static-'+params.slug),slug:params.slug},revalidate:60});export default function Static(props){const router=useRouter();return router.isFallback?<p data-testid="static-fallback">Generating static page</p>:<><Head><title>{'Static '+props.slug}</title></Head><h1>Static {props.slug}</h1><pre data-testid="static-props">{JSON.stringify(props)}</pre></>}`,
      'pages/outcome/[mode].jsx': `export function getServerSideProps({params}){return params.mode==='missing'?{notFound:true}:params.mode==='failed'?(()=>{throw new Error('PRIVATE_DATA_FAILURE')})():{redirect:{destination:'/server/redirected?from=data',permanent:false}}}export default function Outcome(){return <h1>Unexpected outcome render</h1>}`,
      'pages/data-only.jsx': `export const getServerSideProps=()=>({props:{dataOnly:true}});export default function Page(){throw new Error('SSR_COMPONENT_SHOULD_NOT_RUN_FOR_DATA')}`,
      'pages/catch/[[...parts]].jsx': `import{useRouter}from'next/router';export default function Catch(){return <h1 data-testid="catch-parts">{JSON.stringify(useRouter().query.parts||[])}</h1>}`,
      'pages/prefetch.jsx': `import Link from'next/link';export default function Page(){return <><h1>Prefetch probe</h1><Link href="/isr/viewport" data-testid="prefetch-static">Static prefetch</Link><Link href="/server/prefetched" data-testid="prefetch-server">Server prefetch</Link></>}`,
      'pages/api/hello.js': `export default function handler(req,res){res.json({hello:true})}`,
      'app/layout.jsx': `export default function Layout({children}){return <html><body>{children}</body></html>}`,
      'app/app-side/page.jsx': `import Link from'next/link';export default function Page(){return <><h1>Application side</h1><Link href="/" data-testid="app-to-pages">Pages home</Link></>}`,
    };
    for (const [file, source] of Object.entries(files)) if (withRouting || file !== 'proxy.js') await write(file, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { root: fixture.root, manifest, build, write, counts,
      hold(key) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
      async remove() { for (const gate of gates.values()) gate.release(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); },
    };
  } catch (error) {
    for (const gate of gates.values()) gate.release();
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    await fixture.remove(); throw error;
  }
}
