import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function pagesErrorsFixture({ staticErrors = true, customError = true, mixed = false, basePath = '/docs', assetPrefix = '/resources', brokenError = false, revalidate = 60 } = {}) {
  const fixture = await appFixture(), counts = new Map();
  const origin = createServer((request, response) => {
    const key = new URL(request.url, 'http://origin').pathname;
    counts.set(key, (counts.get(key) || 0) + 1);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ count: counts.get(key) }));
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  const write = async (name, source) => { const filename = path.join(fixture.root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); };
  const close = async () => { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); };
  try {
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default{basePath:${JSON.stringify(basePath)},assetPrefix:${JSON.stringify(assetPrefix)},generateBuildId:()=> 'pages-errors',async rewrites(){return[{source:'/alias-missing',destination:'/outcome/missing?injected=rule'}]},async headers(){return[{source:'/unknown',headers:[{key:'x-error-routing',value:'configured'}]}]}}`,
      'pages/_app.jsx': `import{useState,useEffect}from'react';import{useRouter}from'next/router';import Link from'next/link';export default function App({Component,pageProps}){const[count,setCount]=useState(0),router=useRouter();useEffect(()=>{window.__errorsRouter=router},[router]);return <><button data-testid="app-count" onClick={()=>setCount(count+1)}>App {count}</button><pre data-testid="error-router">{JSON.stringify({pathname:router.pathname,asPath:router.asPath,query:router.query,basePath:router.basePath})}</pre><nav><Link prefetch={false} href="/" data-testid="home">Home</Link><Link prefetch={false} href="/outcome/missing?from=link" data-testid="missing-link">Missing</Link><Link prefetch={false} href="/unknown?from=link" data-testid="unknown-link">Unknown</Link><Link prefetch={false} href="/outcome/data?from=link" data-testid="data-link">Data error</Link><Link prefetch={false} href="/outcome/render?from=link" data-testid="render-link">Render error</Link><Link prefetch={false} href="/alias-missing?from=link" data-testid="alias-link">Alias missing</Link><Link prefetch={false} href="/late" data-testid="late-link">Client crash</Link><Link prefetch={false} href="/static/absent" data-testid="fallback-link">Static missing</Link></nav><Component {...pageProps}/></>}`,
      'pages/index.jsx': `import Head from'next/head';export default function Home(){return <><Head><title>Error fixture home</title></Head><h1>Error fixture home</h1></>}`,
      'pages/outcome/[mode].jsx': `export const getServerSideProps=({params,res,req})=>{res.setHeader('x-data-function','reached');if(params.mode==='missing')return{notFound:true};if(params.mode==='data')throw new Error('PRIVATE_SERVER_DATA_ERROR');if(params.mode==='status')res.statusCode=418;if(params.mode==='explicit'){res.statusCode=404;res.end('EXPLICIT_APPLICATION_RESPONSE');return}return{props:{mode:params.mode}}};export default function Outcome({mode}){if(mode==='render')throw new Error('PRIVATE_RENDER_ERROR');return <h1>Outcome {mode}</h1>}`,
      'pages/static/[slug].jsx': `export const getStaticPaths=()=>({paths:[{params:{slug:'seed'}},{params:{slug:'missing-seed'}}],fallback:false});export const getStaticProps=({params})=>params.slug==='missing-seed'?{notFound:true}:{props:{slug:params.slug}};export default({slug})=><h1>Static {slug}</h1>`,
      'pages/regenerate/[slug].jsx': `export const getStaticPaths=()=>({paths:[{params:{slug:'seed'}}],fallback:'blocking'});export const getStaticProps=async({params})=>{if(params.slug!=='seed'){await fetch(${JSON.stringify(originURL + '/generation-')}+params.slug);throw new Error('PRIVATE_GSP_ERROR')}return{props:{slug:params.slug}}};export default({slug})=><h1>Regenerated {slug}</h1>`,
      'pages/fallback/[slug].jsx': `import{useRouter}from'next/router';export const getStaticPaths=()=>({paths:[],fallback:true});export const getStaticProps=()=>({notFound:true,revalidate:60});export default()=>useRouter().isFallback?<p data-testid="missing-fallback">Loading fallback</p>:<h1>Unexpected fallback</h1>`,
      'pages/late.jsx': `import{useState}from'react';export default function Late(){const[n,setN]=useState(0);if(n)throw new Error('CLIENT_RENDER_ERROR');return <><h1>Client error trigger</h1><button data-testid="crash-client" onClick={()=>setN(1)}>Crash client</button></>}`,
      'pages/builtin.jsx': `import Error from'next/error';export default()=> <Error statusCode={403} title="Application says no"/>`,
      'pages/api/problem.js': `export default(req,res)=>{if(req.query.missing)return res.status(404).json({kind:'api404'});throw new Error('PRIVATE_API_ERROR')}`,
      'pages/api/invalidate.js': `export default async(req,res)=>{await res.revalidate('/404');res.json({ok:true})}`,
      'components/errors.module.css': '.missing { color: rgb(29, 79, 131); } .failed { color: rgb(143, 37, 61); } .custom { color: rgb(97, 53, 139); }',
    };
    if (staticErrors) for (const [status, className] of [[404, 'missing'], [500, 'failed']]) files[`pages/${status}.jsx`] = `import Head from'next/head';import styles from'../components/errors.module.css';export const getStaticProps=async()=>({props:{label:'static-${status}',...(await(await fetch(${JSON.stringify(originURL + '/error-' + status)})).json())},revalidate:${JSON.stringify(revalidate)}});export default function ErrorPage(props){return <><Head><title>Custom ${status} title</title></Head><h1 className={styles.${className}} data-testid="custom-${status}">Custom ${status}</h1><pre data-testid="error-props">{JSON.stringify(props)}</pre></>}`;
    if (customError) files['pages/_error.jsx'] = brokenError
      ? `export default function ErrorPage(){throw new Error('PRIVATE_BROKEN_ERROR_PAGE')}ErrorPage.getInitialProps=()=>({statusCode:500});`
      : `import Error from'next/error';import Head from'next/head';import styles from'../components/errors.module.css';export default function ErrorPage(props){return <><Head><title>Custom error {props.statusCode||'client'}</title></Head><h1 className={styles.custom} data-testid="custom-error">Custom error {props.statusCode||'client'}</h1><pre data-testid="error-props">{JSON.stringify(props)}</pre></>};ErrorPage.getInitialProps=async ctx=>({...await Error.getInitialProps(ctx),source:'custom-error',seen:{pathname:ctx.pathname,asPath:ctx.asPath,query:ctx.query,url:ctx.req?.url,res:ctx.res?.statusCode,hadError:!!ctx.err,errorStatus:ctx.err?.statusCode,errorKind:ctx.err?.message==='PRIVATE_GSP_ERROR'?'generation':ctx.err?.message==='PRIVATE_SERVER_DATA_ERROR'?'data':ctx.err?.message==='PRIVATE_RENDER_ERROR'?'render':undefined,server:typeof window==='undefined',visitor:ctx.req?.headers.cookie||null}});`;
    if (mixed) Object.assign(files, {
      'app/layout.jsx': `import Shell from'../components/AppShell';export default function Layout({children}){return <html><body><Shell/>{children}</body></html>}`,
      'components/AppShell.jsx': `'use client';import{useState}from'react';import{usePathname}from'next/navigation';import Link from'next/link';export default function Shell(){const[n,setN]=useState(0);return <><button data-testid="app-layout-count" onClick={()=>setN(n+1)}>Layout {n}</button><p data-testid="app-pathname">{usePathname()}</p><Link href="/application">Application</Link><Link href="/application-missing">App missing</Link></>}`,
      'app/not-found.jsx': `import Link from'next/link';export default()=> <><h1 data-testid="app-global-missing">App global missing</h1><Link href="/">Pages home</Link></>`,
      'app/application/page.jsx': `export default()=> <h1>Healthy application page</h1>`,
      'app/application-missing/page.jsx': `import{notFound}from'next/navigation';export const dynamic='force-dynamic';export default function Page(){notFound()}`,
    });
    for (const [name, source] of Object.entries(files)) await write(name, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { root: fixture.root, manifest, counts, build, write, remove: close };
  } catch (error) { await close(); throw error; }
}
