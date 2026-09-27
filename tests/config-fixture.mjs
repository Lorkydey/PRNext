import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function configFixture() {
  const fixture = await appFixture();
  const counts = new Map(), gates = new Map(), requests = [];
  const origin = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://origin');
    const key = url.searchParams.get('key') || url.pathname;
    counts.set(key, (counts.get(key) || 0) + 1);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const received = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() };
    requests.push(received);
    if (url.pathname === '/stream' || url.pathname === '/blocked') {
      response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['proxy=one; Path=/', 'proxy-two=two; HttpOnly; Path=/'], connection: 'keep-alive, x-origin-hop', 'x-origin-hop': 'remove-me' });
      response.write('first-é\n');
      await gates.get(key)?.promise;
      if (!response.destroyed) response.end('second-🚀\n');
      return;
    }
    if (url.pathname === '/redirect') { response.writeHead(302, { location: '/proxy/final', 'set-cookie': 'redirect=yes; Path=/' }); response.end('origin redirect'); return; }
    await gates.get(key)?.promise;
    if (response.destroyed) return;
    if (url.pathname === '/priority') { response.setHeader('x-priority', 'origin'); response.setHeader('cache-control', 'private, no-store'); }
    response.writeHead(url.pathname === '/echo' ? 201 : 200, { 'content-type': 'application/json', 'set-cookie': ['proxy=one; Path=/', 'proxy-two=two; HttpOnly; Path=/'], connection: 'keep-alive, x-origin-hop', 'x-origin-hop': 'remove-me' });
    response.end(JSON.stringify({ ...received, key, count: counts.get(key) }));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const write = async (file, value) => { const filename = path.join(fixture.root, file); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, value); };
  const writeRuntimeEnv = (privateValue = 'PRIVATE_CONFIG_FIXTURE_BUILD_ONLY', publicValue = 'public-frozen') => write('.env.production.local', `CONFIG_FIXTURE_PRIVATE=${privateValue}\nNEXT_PUBLIC_CONFIG_FIXTURE=${publicValue}\nCONFIG_FIXTURE_ORDER=production-local\nCONFIG_FIXTURE_EXPANDED=\${CONFIG_FIXTURE_ORDER}-expanded\n`);
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true });
    await rm(path.join(fixture.root, 'pages'), { recursive: true, force: true });
    const files = {
      '.env': 'CONFIG_FIXTURE_ORDER=base\nCONFIG_FIXTURE_BASE=base-only\nCONFIG_FIXTURE_PROCESS=from-file\n',
      '.env.production': 'CONFIG_FIXTURE_ORDER=production\nCONFIG_FIXTURE_MODE=production-only\n',
      '.env.local': 'CONFIG_FIXTURE_ORDER=local\nCONFIG_FIXTURE_LOCAL=local-only\n',
      'public/override.txt': 'public-before-rewrite',
      'public/priority/public': 'public-winner',
      'public/compressible.txt': 'A compressible fixture sentence.\n'.repeat(1000),
      'lib/origin.js': `export const origin=${JSON.stringify(originUrl)};export async function read(key){return (await fetch(origin+'/count?key='+encodeURIComponent(key))).json()}`,
      'app/client.jsx': `'use client';import {useState} from 'react';import {usePathname,useSearchParams,useParams} from 'next/navigation';import Link from 'next/link';
        export function Navigation(){const [count,setCount]=useState(0),pathname=usePathname(),query=useSearchParams(),params=useParams();return <header>
        <button onClick={()=>setCount(count+1)}>Layout count: {count}</button><Link href="/">Home</Link>
        <Link href="/app-alias/book?from=navigation&collision=visible">App alias</Link><Link href="/client-alias/book?from=client&collision=visible">Client alias</Link><Link href="/cached-alias/built?from=cached">Cached alias</Link>
        <pre data-testid="nav-path">{pathname}</pre><pre data-testid="nav-query">{JSON.stringify(Object.fromEntries(query))}</pre><pre data-testid="nav-params">{JSON.stringify(params)}</pre>
        <p data-testid="public-env">{process.env.NEXT_PUBLIC_CONFIG_FIXTURE}</p><p data-testid="config-env">{process.env.EXPOSED_CONFIG_FIXTURE}</p></header>}`,
      'app/layout.jsx': `import {Navigation} from './client';export default function Layout({children}){return <html><head/><body><Navigation/>{children}</body></html>}`,
      'app/page.jsx': `export default function Page(){return <h1>Config fixture home</h1>}`,
      'app/view/[slug]/page.jsx': `export default async function Page({params,searchParams}){return <><h1>App view</h1><pre data-testid="app-server-data">{JSON.stringify({params:await params,query:await searchParams})}</pre></>}`,
      'app/action-target/page.jsx': `import {cookies} from 'next/headers';export default async function Page({searchParams}){
        const count=Number((await cookies()).get('rewrite-count')?.value||0),query=await searchParams;
        async function increment(){'use server';const jar=await cookies();jar.set('rewrite-count',String(Number(jar.get('rewrite-count')?.value||0)+1),{path:'/'})}
        return <><p data-testid="action-count">{count}</p><pre data-testid="action-query">{JSON.stringify(query)}</pre><form action={increment}><button>Increment rewritten action</button></form></>}`,
      'app/client-target/[slug]/page.jsx': `'use client';import {use} from 'react';export default function Page({params,searchParams}){return <><h1>Client view</h1><pre data-testid="client-page-query">{JSON.stringify(use(searchParams))}</pre><pre data-testid="client-page-params">{JSON.stringify(use(params))}</pre></>}`,
      'app/client-target/[slug]/layout.jsx': `export const generateStaticParams=()=>[{slug:'book'}];export default function Layout({children}){return children}`,
      'app/cached/[slug]/page.jsx': `import {read} from '../../../lib/origin';export const generateStaticParams=()=>[{slug:'built'}];export default async function Page({params}){const {slug}=await params;const data=await read('app:'+slug);return <><h1>Cached view</h1><p data-testid="cached-count">{data.count}</p><p data-testid="cached-slug">{slug}</p></>}`,
      'app/priority/fixed/page.jsx': `export default function Page(){return <h1>Fixed winner</h1>}`,
      'app/api/request/route.js': `export function GET(request){return Response.json({url:request.url,pathname:request.nextUrl.pathname,query:Object.fromEntries(request.nextUrl.searchParams)})}`,
      'app/api/handler-missing/route.js': `export function GET(){return Response.json({handler:true},{status:404})}`,
      'app/api/web-priority/route.js': `export function GET(){const headers=new Headers({'x-priority':'handler','cache-control':'private, no-store'});headers.append('set-cookie','handler-one=one; Path=/');headers.append('set-cookie','handler-two=two; Path=/');return new Response('handler',{headers})}`,
      'app/api/env/route.js': `export function GET(){return Response.json({private:process.env.CONFIG_FIXTURE_PRIVATE,public:process.env.NEXT_PUBLIC_CONFIG_FIXTURE,config:process.env.EXPOSED_CONFIG_FIXTURE,order:process.env.CONFIG_FIXTURE_ORDER,base:process.env.CONFIG_FIXTURE_BASE,mode:process.env.CONFIG_FIXTURE_MODE,local:process.env.CONFIG_FIXTURE_LOCAL,expanded:process.env.CONFIG_FIXTURE_EXPANDED,process:process.env.CONFIG_FIXTURE_PROCESS})}`,
      'pages/_app.jsx': `import {useState} from 'react';export default function App({Component,pageProps}){const [count,setCount]=useState(0);return <><button onClick={()=>setCount(count+1)}>Pages count: {count}</button><Component {...pageProps}/></>}`,
      'pages/api/pages-priority.js': `export default function handler(req,res){res.setHeader('x-priority','handler');res.setHeader('cache-control','private, no-store');res.setHeader('set-cookie',['handler-one=one; Path=/','handler-two=two; Path=/']);res.end('handler')}`,
      'pages/target/[slug].jsx': `export const getServerSideProps=({req,resolvedUrl,query})=>({props:{url:req.url,resolvedUrl,query}});export default function Page(props){return <><h1>Pages target</h1><pre data-testid="pages-data">{JSON.stringify(props)}</pre></>}`,
      'pages/priority/[slug].jsx': `export const getServerSideProps=({params})=>({props:params});export default function Page({slug}){return <h1>Dynamic winner: {slug}</h1>}`,
      'pages/fallback/[slug].jsx': `import {useRouter} from 'next/router';import {read} from '../../lib/origin';export const getStaticPaths=()=>({paths:[],fallback:true});export const getStaticProps=async({params})=>({props:await read('pages:'+params.slug)});export default function Page(props){const {pathname,asPath,query,isFallback}=useRouter();return isFallback?<p data-testid="fallback-loading">Fallback loading</p>:<><h1>Fallback result</h1><pre data-testid="fallback-data">{JSON.stringify({props,router:{pathname,asPath,query,isFallback}})}</pre></>}`,
      'next.config.mjs': `import {PHASE_PRODUCTION_BUILD} from 'next/constants';export default async phase=>{
        if(phase!==PHASE_PRODUCTION_BUILD)throw new Error('Unexpected config phase: '+phase);
        return {env:{EXPOSED_CONFIG_FIXTURE:'configured-public'},generateBuildId:async()=>'config-fixed-build',compress:false,poweredByHeader:false,productionBrowserSourceMaps:true,
        async headers(){return [
          {source:'/:path*',headers:[{key:'X-Order',value:'first'},{key:'X-Configured',value:'yes'}]},
          ...['/api/web-priority','/api/pages-priority','/proxy-priority'].map(source=>({source,headers:[{key:'X-Priority',value:'config'},{key:'Cache-Control',value:'public, max-age=3600'},{key:'Set-Cookie',value:'configured=overridden; Path=/'}]})),
          {source:'/configured-cookies',headers:[{key:'Set-Cookie',value:'configured-one=one; Path=/'},{key:'Set-Cookie',value:'configured-two=two; Path=/'}]},
          {source:'/headers/:slug',has:[{type:'header',key:'x-trigger',value:'(?<trigger>yes)'},{type:'cookie',key:'session',value:'(?<session>[a-z]+)'},{type:'query',key:'mode',value:'(?<mode>preview)'},{type:'host',value:'127\\\\.0\\\\.0\\\\.1'}],missing:[{type:'header',key:'x-disabled'}],headers:[{key:'X-Order',value:'last'},{key:'X-Captures',value:':slug|:trigger|:session|:mode|:host'}]},
        ]},async redirects(){return [
          {source:'/temporary/:id(\\\\d+)',destination:'/target/:id?fixed=dest#section',permanent:false},
          {source:'/permanent/:rest*',destination:'/target/:rest*',permanent:true},
          {source:'/numeric/:id(\\\\d+)',destination:'/target/:id',statusCode:303},
          {source:'/optional/:id?',destination:'/target',permanent:false},
          {source:'/conditional/:slug',has:[{type:'header',key:'x-destination',value:'(?<target>[a-z]+)'}],missing:[{type:'cookie',key:'disabled'}],destination:'/target/:target?slug=:slug',permanent:false},
          {source:'/query-presence',has:[{type:'query',key:'tag'}],destination:'/target/:tag*?joined=:tag*',permanent:false},
        ]},async rewrites(){return {beforeFiles:[
          {source:'/alias/:slug',destination:'/target/:slug?injected=dest&collision=dest'},
          {source:'/app-alias/:slug',destination:'/view/:slug?injected=dest&collision=dest'},
          {source:'/action-alias',destination:'/action-target?injected=dest'},
          {source:'/client-alias/:slug',destination:'/client-target/:slug?injected=dest&collision=dest'},
          {source:'/cached-alias/:slug',destination:'/cached/:slug?injected=dest'},
          {source:'/private-cached',has:[{type:'cookie',key:'session',value:'(?<session>[a-z-]+)'}],destination:'/cached/built?session=:session'},
          {source:'/private-fallback',has:[{type:'cookie',key:'session',value:'(?<session>[a-z-]+)'}],destination:'/fallback/private-built?session=:session'},
          {source:'/configured-cookies',destination:'/target/cookies'},
          {source:'/proxy-priority',destination:${JSON.stringify(originUrl)}+'/priority'},
          {source:'/fallback-alias/:slug',destination:'/fallback/:slug?injected=dest'},
          {source:'/api-alias/:slug',destination:'/api/request?slug=:slug&injected=dest'},
          {source:'/chain',destination:'/middle?first=one'},{source:'/middle',destination:'/target/chained?second=two'},
          {source:'/override.txt',destination:'/target/override'},
          {source:'/headers/:slug',destination:'/target/:slug'},
          {source:'/query-forward/:slug/:extra',destination:'/target/forward?picked=:slug'},
          {source:'/repeat-query/:parts*',destination:'/target/repeated?joined=:parts*&embedded=prefix-:parts*'},
          {source:'/proxy/:rest*',destination:${JSON.stringify(originUrl)}+'/:rest*'},
        ],afterFiles:[{source:'/priority/:slug',destination:'/target/:slug?phase=after'}],fallback:[
          {source:'/unmatched/:slug',destination:'/target/:slug?phase=fallback'},
          {source:'/api/handler-missing',destination:'/target/wrong-fallback'},
        ]}}};}`,
    };
    for (const [file, source] of Object.entries(files)) await write(file, source);
    await writeRuntimeEnv();
    const build = async (args = []) => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root, ...args], { maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CONFIG_FIXTURE_PROCESS: 'from-process' } });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { ...fixture, build, manifest, counts, requests, originUrl, writeRuntimeEnv,
      hold(key) { let release; const promise = new Promise(done => { release = done; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
      async remove() { for (const gate of gates.values()) gate.release(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); },
    };
  } catch (error) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); throw error; }
}
