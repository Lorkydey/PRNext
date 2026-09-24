import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function documentFixture({ variant = 'class', mixed = false } = {}) {
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
      'rustyx.config.mjs': `export default{basePath:'/docs',assetPrefix:'/resources',generateBuildId:()=> 'document-fixture',async rewrites(){return[{source:'/alias/:slug',destination:'/server/:slug?injected=rule'},{source:'/static-alias/:slug',destination:'/static/:slug?injected=static'}]},async headers(){return[{source:'/server/csp',headers:[{key:'Content-Security-Policy',value:"default-src 'self'; script-src 'nonce-doc-nonce' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; object-src 'none'"}]}]}}`,
      'pages/_app.jsx': `import{useState,useEffect}from'react';import{useRouter}from'next/router';import Link from'next/link';import Head from'next/head';export default function App({Component,pageProps}){const[n,setN]=useState(0),router=useRouter();useEffect(()=>{window.__documentRouter=router},[router]);return <><Head><meta name="description" content="App default"/></Head><button data-testid="app-count" onClick={()=>setN(n+1)}>App {n}</button><nav><Link prefetch={false} data-testid="home-link" href="/">Home</Link><Link prefetch={false} data-testid="server-link" href="/server/browser?from=link">Server</Link><Link prefetch={false} data-testid="static-link" href="/static/seed">Static</Link><Link prefetch={false} data-testid="missing-link" href="/server/missing">Missing</Link></nav><Component {...pageProps}/></>}`,
      'components/Content.jsx': `import{useState}from'react';import Head from'next/head';import styles from'./content.module.css';export default function Content({label='Home',count=0}){const[n,setN]=useState(0);return <><Head><title>{'Document '+label}</title><meta name="page-label" content={label}/></Head><h1 className={styles.title} data-testid="page-heading">{label}</h1><button data-testid="page-count" onClick={()=>setN(n+1)}>Page {n}</button><p data-testid="data-count">{count}</p></>}`,
      'components/content.module.css': '.title { color: rgb(12, 67, 123); }',
      'pages/index.jsx': `export{default}from'../components/Content';`,
      'pages/viewport.jsx': `import Head from'next/head';import Content from'../components/Content';export default function Page(){return <><Head><meta key="custom-viewport" name="viewport" content="width=900"/><meta name="description" content="Page override"/></Head><Content label="Viewport"/></>}`,
      'pages/server/[slug].jsx': `export{default}from'../../components/Content';export const getServerSideProps=async({params})=>{await fetch(${JSON.stringify(originURL + '/data-')}+params.slug);if(params.slug==='missing')return{notFound:true};if(params.slug==='error')throw new Error('PRIVATE_DOCUMENT_PAGE_ERROR');return{props:{label:'Server '+params.slug}}}`,
      'pages/static/[slug].jsx': `export{default}from'../../components/Content';export const getStaticPaths=()=>({paths:[{params:{slug:'seed'}}],fallback:'blocking'});export const getStaticProps=async({params})=>({props:{label:'Static '+params.slug,...await(await fetch(${JSON.stringify(originURL + '/static-')}+params.slug)).json()},revalidate:60});`,
      'pages/404.jsx': `export{default}from'../components/Content';export const getStaticProps=()=>({props:{label:'Custom 404'}});`,
      'pages/500.jsx': `export{default}from'../components/Content';export const getStaticProps=()=>({props:{label:'Custom 500'}});`,
      'pages/api/invalidate.js': `export default async(req,res)=>{await res.revalidate('/static/seed');res.json({ok:true})}`,
    };
    const layout = `<Html lang="fr" data-document="${variant}"><Head nonce="doc-nonce" crossOrigin="anonymous"><meta name="document-fixed" content="preserved"/><style id="document-fixed-style">{'body{--document-color:rgb(32, 54, 76)}'}</style></Head><body className="document-body" data-document-count={this.props.documentCount} data-document-path={this.props.seen?.pathname}><aside id="document-outside" onClick={()=>{throw new Error('Document must not hydrate')}}>Outside Main</aside><pre id="document-context">{JSON.stringify(this.props.seen||{})}</pre><Main/><NextScript nonce="doc-nonce" crossOrigin="anonymous"/><footer id="document-footer">Document footer</footer></body></Html>`;
    if (variant === 'class') files['pages/_document.jsx'] = `import React from'react';import{readFileSync}from'node:fs';import Document,{Html,Head,Main,NextScript}from'next/document';export default class CustomDocument extends Document{static async getInitialProps(ctx){const trace=[];const original=ctx.renderPage;ctx.renderPage=()=>original({enhanceApp:App=>function EnhancedApp(props){trace.push('app');return <App {...props}/>},enhanceComponent:Component=>function EnhancedComponent(props){trace.push('page');return <Component {...props}/>}});if(ctx.query.documentCrash)throw new Error('PRIVATE_DOCUMENT_HOOK_ERROR');const initial=await Document.getInitialProps(ctx);const{count}=await(await fetch(${JSON.stringify(originURL + '/document')})).json();if(ctx.req?.headers['x-document-test'])ctx.res.setHeader('x-document-hook',ctx.req.headers['x-document-test']);return{...initial,styles:<>{initial.styles}<style id="document-collected" data-render-trace={trace.join(',')}>{'.document-collected{color:rgb(17, 33, 55)}'}</style></>,documentCount:count,privateToken:'PRIVATE_DOCUMENT_DEPENDENCY'+readFileSync('/dev/null','utf8'),privateFunction:()=>42,seen:{pathname:ctx.pathname,query:ctx.query,asPath:ctx.asPath,url:ctx.req?.url,visitor:ctx.req?.headers.cookie||null,status:ctx.res?.statusCode,hadError:!!ctx.err}}}render(){return ${layout}}}`;
    else files['pages/_document.jsx'] = `import{Html,Head,Main,NextScript}from'rustyx/document';export default function CustomDocument(){return <Html lang="fr" data-document="function"><Head><meta name="document-fixed" content="preserved"/></Head><body className="function-document"><aside id="document-outside">Outside Main</aside><Main/><NextScript/><footer id="document-footer">Document footer</footer></body></Html>}`;
    if (mixed) Object.assign(files, {
      'app/layout.jsx': `export default function Layout({children}){return <html lang="en" data-app-layout="yes"><body>{children}</body></html>}`,
      'app/application/page.jsx': `export default function Page(){return <h1>Separate App document</h1>}`,
    });
    for (const [name, source] of Object.entries(files)) await write(name, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { root: fixture.root, manifest, counts, build, write, remove: close };
  } catch (error) { await close(); throw error; }
}
