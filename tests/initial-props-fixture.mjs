import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function initialPropsFixture({ customApp = true, withRouting = false } = {}) {
  const fixture = await appFixture(), counts = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url, 'http://origin').pathname.slice(1));
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    await gates.get(key)?.promise;
    if (!response.destroyed) {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ count }));
    }
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originURL = `http://127.0.0.1:${origin.address().port}`;
  const write = async (name, source) => { const filename = path.join(fixture.root, name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, source); };
  const close = async () => { for (const gate of gates.values()) gate.release(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); };
  try {
    for (const name of ['app', 'pages', 'components', 'lib', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default{basePath:'/docs',assetPrefix:'/resources',generateBuildId:()=> 'initial-props',${withRouting ? `async rewrites(){return[{source:'/alias/:slug',destination:'/legacy/:slug?injected=rule'}]},` : ''}}`,
      'lib/hooks.js': `export const side=()=>typeof window==='undefined'?'server':'client';export async function count(key){return(await fetch(${JSON.stringify(originURL)}+'/'+encodeURIComponent(key))).json()}export const context=ctx=>({pathname:ctx.pathname,query:ctx.query,asPath:ctx.asPath,server:!!ctx.req,url:ctx.req?.url,status:ctx.res?.statusCode,visitor:ctx.req?.headers.cookie||null,hadError:!!ctx.err,AppTree:typeof ctx.AppTree});`,
      'components/Shell.jsx': `import{useState,useEffect}from'react';import Router,{useRouter}from'next/router';import Link from'next/link';export default function Shell({Component,pageProps,appSource,appCount,appContext}){const[n,setN]=useState(0),router=useRouter();useEffect(()=>{window.__initialRouter=Router},[]);return <><button data-testid="app-count" onClick={()=>setN(n+1)}>App {n}</button><pre data-testid="app-props">{JSON.stringify({appSource,appCount,appContext})}</pre><pre data-testid="router">{JSON.stringify({pathname:router.pathname,query:router.query,asPath:router.asPath,basePath:router.basePath})}</pre><nav><Link prefetch={false} href="/" data-testid="home-link">Home</Link><Link prefetch={false} href="/legacy/client?from=link" data-testid="legacy-link">Legacy</Link><Link prefetch={false} href="/plain" data-testid="plain-link">Plain</Link><Link prefetch={false} href="/server/data?from=link" data-testid="server-link">Server data</Link><Link prefetch={false} href="/static/seed" data-testid="static-link">Static</Link><Link prefetch={false} href="/legacy/failure" data-testid="failure-link">Failure</Link><Link prefetch={false} href="/alias/rewritten?from=alias" data-testid="alias-link">Alias</Link><Link prefetch={false} href="/via/rewritten?from=proxy" data-testid="proxy-link">Proxy</Link></nav><Component {...pageProps}/></>}`,
      'components/Content.jsx': `import{useState}from'react';import Head from'next/head';import styles from'./content.module.css';export default function Content(props){const[n,setN]=useState(0);return <><Head><title>{'Initial '+(props.label||'Home')}</title></Head><h1 className={styles.title} data-testid="page-heading">{props.label||'Home'}</h1><pre data-testid="page-props">{JSON.stringify(props)}</pre><button data-testid="page-count" onClick={()=>setN(n+1)}>Page {n}</button></>}`,
      'components/content.module.css': '.title { color: rgb(43, 76, 109); }',
      'pages/index.jsx': `export{default}from'../components/Content';`,
      'pages/plain.jsx': `import Content from'../components/Content';export default function Plain(){return <Content label="Plain"/>}`,
      'pages/legacy/[slug].jsx': `import Content from'../../components/Content';import{side,count,context}from'../../lib/hooks';export default function Legacy(props){if(props.renderFailure)throw new Error('LEGACY_RENDER_ERROR');return <Content {...props}/>};Legacy.getInitialProps=async ctx=>{const source=side(),slug=ctx.query.slug;if(slug==='failure')throw new Error('LEGACY_HOOK_ERROR');if(slug==='redirected'&&ctx.res){await count('page:redirected:server');ctx.res.setHeader('set-cookie','legacy=redirected; Path=/docs');ctx.res.writeHead(302,{Location:ctx.query.viaMiddleware?'/docs/hook-redirect-control':'/docs/legacy/redirect-target?from=hook'}).end();return}if(slug==='ended'&&ctx.res){await count('page:ended:server');ctx.res.setHeader('set-cookie','legacy=ended; Path=/docs');ctx.res.statusCode=Number(ctx.query.status||202);if(ctx.query.body==='json')ctx.res.setHeader('content-type','application/json');ctx.res.end(ctx.query.body==='json'?'{\"ignored\":true}':'Legacy explicit response');return}if(ctx.res)ctx.res.setHeader('x-page-initial-props','yes');return{label:'Legacy '+slug,pageSource:source,seen:context(ctx),renderFailure:ctx.query.renderFailure==='1',...await count('page:'+slug+':'+source),omitted:undefined}};`,
      'pages/server/[slug].jsx': `export{default}from'../../components/Content';import{count}from'../../lib/hooks';export const getServerSideProps=async({params,req})=>({props:{label:'Server '+params.slug,dataSource:'gssp',shared:'gssp',visitor:req.headers.cookie||null,...await count('gssp:'+params.slug)}});`,
      'pages/static/[slug].jsx': `export{default}from'../../components/Content';import{count}from'../../lib/hooks';export const getStaticPaths=()=>({paths:[{params:{slug:'seed'}}],fallback:'blocking'});export const getStaticProps=async({params})=>({props:{label:'Static '+params.slug,dataSource:'gsp',shared:'gsp',...await count('gsp:'+params.slug)},revalidate:60});`,
      'pages/404.jsx': `export{default}from'../components/Content';export const getStaticProps=()=>({props:{label:'Custom 404'}});`,
      'pages/500.jsx': `export{default}from'../components/Content';export const getStaticProps=()=>({props:{label:'Custom 500'}});`,
      'pages/_error.jsx': `import Error from'next/error';import Content from'../components/Content';import{side,count,context}from'../lib/hooks';export default function CustomError(props){return <Content {...props}/>};CustomError.getInitialProps=async ctx=>({...await Error.getInitialProps(ctx),label:'Custom error',pageSource:side(),seen:context(ctx),errorCount:(await count('error:'+side())).count});`,
      'pages/_document.jsx': `import Document,{Html,Head,Main,NextScript}from'next/document';export default class CustomDocument extends Document{static async getInitialProps(ctx){return{...await Document.getInitialProps(ctx),seen:JSON.stringify({pathname:ctx.pathname,query:ctx.query,asPath:ctx.asPath,hasRequest:!!ctx.req,hasResponse:!!ctx.res})}}render(){return <Html lang="fr"><Head/><body data-document-context={this.props.seen}><Main/><NextScript/></body></Html>}}`,
      'pages/api/invalidate.js': `export default async(req,res)=>{await res.revalidate('/static/seed');res.json({ok:true})}`,
    };
    const imports = `import DefaultApp from'next/app';import Shell from'../components/Shell';import{side,count,context}from'../lib/hooks';`;
    files['pages/_app.jsx'] = customApp === 'inherited'
      ? `${imports}export default class App extends DefaultApp{render(){return <Shell {...this.props}/>}}`
      : `${imports}export default function App(props){return <Shell {...props}/>};${customApp ? `App.getInitialProps=async app=>{const source=side();const result=app.ctx.query.skipPage?{pageProps:{label:'App selected'}}:await DefaultApp.getInitialProps(app);return{...result,pageProps:{fromApp:'app-marker',shared:'app',appOptional:undefined,...result.pageProps},appSource:source,appCount:(await count('app:'+app.ctx.pathname+':'+source)).count,appContext:{...context(app.ctx),routerPath:app.router.pathname,routerAsPath:app.router.asPath,AppTree:typeof app.AppTree}}};` : ''}`;
    if (withRouting) files['proxy.js'] = `import{NextResponse}from'next/server';export function proxy(req){if(req.nextUrl.pathname==='/hook-redirect-control')return NextResponse.redirect(new URL('/docs/legacy/final-control?from=middleware',req.url));if(req.nextUrl.pathname.startsWith('/legacy/'))return NextResponse.next();const url=req.nextUrl.clone();url.pathname=url.pathname.replace('/via/','/legacy/');if(url.searchParams.get('from')==='discard')url.search='?status=200&dest=server';url.searchParams.set('injected','proxy');return NextResponse.rewrite(url)}export const config={matcher:['/via/:path*','/legacy/passed','/legacy/ended','/legacy/redirected','/hook-redirect-control']}`;
    for (const [name, source] of Object.entries(files)) await write(name, source);
    const build = async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { root: fixture.root, manifest, counts, build, write, remove: close,
      hold(key) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
    };
  } catch (error) { await close(); throw error; }
}
