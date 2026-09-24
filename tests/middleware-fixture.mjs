import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function middlewareFixture({ convention = 'proxy', directory = '' } = {}) {
  const fixture = await appFixture();
  const counts = new Map(), completed = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://origin'), key = url.pathname.slice(1);
    counts.set(key, (counts.get(key) || 0) + 1);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    await gates.get(key)?.promise;
    completed.set(key, (completed.get(key) || 0) + 1);
    if (!response.destroyed) {
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-origin', 'yes');
      response.end(JSON.stringify({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString('base64') }));
    }
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const write = async (file, source) => { const target = path.join(fixture.root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source); };
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true });
    await rm(path.join(fixture.root, 'pages'), { recursive: true, force: true });
    await rm(path.join(fixture.root, 'proxy.ts'), { force: true });
    const files = {
      'app/layout.jsx': `import View from '../components/View';export default function Layout({children}){return <html><body><View/>{children}</body></html>}`,
      'components/View.jsx': `'use client';import {useState}from'react';import Link from'next/link';import{usePathname,useSearchParams}from'next/navigation';export default function View(){const[n,setN]=useState(0);return <><button data-testid="count" onClick={()=>setN(n+1)}>count {n}</button><p data-testid="pathname">{usePathname()}</p><p data-testid="query">{useSearchParams().toString()}</p><Link href="/mw/app?visible=visitor" data-testid="app-link">App rewrite</Link><Link href="/mw/static?visible=cached" data-testid="static-link">Cached rewrite</Link><Link href="/mw/redirect" data-testid="redirect-link">Redirect</Link></>}`,
      'app/page.jsx': `export default function Page(){return <h1>Middleware fixture</h1>}`,
      'app/static/page.jsx': `export default function Page(){return <h1 data-testid="static-title">Cached application page</h1>}`,
      'app/app-target/page.jsx': `import{headers,cookies}from'next/headers';export default async function Page({searchParams}){return <><h1>App target</h1><pre data-testid="server-state">{JSON.stringify({query:await searchParams,header:(await headers()).get('x-shared'),cookie:(await cookies()).get('mwc')?.value||null})}</pre></>}`,
      'app/actions-target/page.jsx': `import{headers,cookies}from'next/headers';export default async function Page({searchParams}){async function increment(){'use server';if((await headers()).get('x-added')!=='added')throw new Error('Middleware header missing');const jar=await cookies();jar.set('count',String(Number(jar.get('count')?.value||0)+1),{path:'/'});}return <><p data-testid="action-count">{(await cookies()).get('count')?.value||'0'}</p><pre data-testid="action-query">{JSON.stringify(await searchParams)}</pre><form action={increment}><button>Increment middleware action</button></form></>}`,
      'app/mw/[...segments]/route.js': `import{headers,cookies}from'next/headers';export async function GET(request,{params}){const h=new Headers({'x-shared':'handler','x-own':'handler'});if(request.nextUrl.pathname.endsWith('/cookies'))h.append('set-cookie','handler=last; Path=/');return Response.json({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),ambientHeaders:Object.fromEntries(await headers()),requestCookies:request.cookies.getAll(),ambientCookies:(await cookies()).getAll(),params:await params,body:Buffer.from(await request.arrayBuffer()).toString('base64')},{headers:h})}export const POST=GET;export const PUT=GET;`,
      'app/api/plain/route.js': `import{headers,cookies}from'next/headers';export async function GET(){return Response.json({headers:Object.fromEntries(await headers()),cookies:(await cookies()).getAll()})}`,
      'app/conditional/[...segments]/route.js': `export function GET(request){return Response.json({header:request.headers.get('x-shared')})}`,
      'app/negative/[...segments]/route.js': `export function GET(request){return Response.json({header:request.headers.get('x-shared')})}`,
      'pages/pages-target.jsx': `export async function getServerSideProps({req,resolvedUrl,query}){return{props:{url:req.url,resolvedUrl,query,headers:req.headers,cookies:req.cookies}}}export default function Page(props){return <pre id="pages-state">{JSON.stringify(props)}</pre>}`,
      'pages/ssg.jsx': `export const getStaticProps=()=>({props:{message:'cached Pages data'}});export default function Page({message}){return <h1>{message}</h1>}`,
      'public/mw/asset.txt': 'public middleware asset',
      'rustyx.config.mjs': `export default {async headers(){return[{source:'/mw/:path*',headers:[{key:'x-config',value:'yes'},{key:'x-shared',value:'config'}]}]},async redirects(){return[{source:'/mw/config-redirect',destination:'/static',permanent:false}]},async rewrites(){return{beforeFiles:[{source:'/chain',destination:'/mw/target?phase=before',has:[{type:'header',key:'x-shared',value:'middleware'}]}],afterFiles:[],fallback:[]}}}`,
      [path.join(directory, convention + '.ts')]: `import{NextResponse,type NextRequest,type NextFetchEvent}from'next/server';import{createHash}from'node:crypto';
        const origin=${JSON.stringify(originUrl)};await fetch(origin+'/boot');
        export const config={matcher:['/mw/:path*','/ssg',{source:'/conditional/:path*',has:[{type:'header',key:'x-run',value:'yes'},{type:'cookie',key:'enabled',value:'1'},{type:'query',key:'go',value:'1'}],missing:[{type:'header',key:'next-router-prefetch'}]},'/negative/((?!skip).*)']};
        export async function ${convention}(request:NextRequest,event:NextFetchEvent){
          const url=request.nextUrl,p=url.pathname,mode=url.searchParams.get('mode');
          if(p==='/mw/inspect')return Response.json({url:request.url,headers:Object.fromEntries(request.headers),cookies:request.cookies.getAll()});
          if(p==='/mw/guard'&&request.headers.get('x-pass')!=='yes')return Response.json({denied:true},{status:401});
          if(p==='/mw/failure')throw new Error('private middleware failure');
          if(p==='/mw/gate')await fetch(origin+'/gate');
          if(p==='/mw/background'){event.waitUntil(fetch(origin+'/background').then(()=>fetch(origin+'/background-done')));}
          if(p==='/mw/background-error')event.waitUntil(Promise.reject(new Error('background test rejection')));
          if(p==='/mw/direct')return new Response('direct response',{status:201,headers:{'content-type':'text/plain','x-direct':'yes',location:new URL('/static',request.url).href}});
          if(p==='/mw/direct-control')return new Response('direct response with continuation',{status:201,headers:{location:new URL('/static',request.url).href,'x-middleware-next':'1'}});
          if(p==='/mw/stream'){let first=true;return new Response(new ReadableStream({async pull(c){if(first){first=false;c.enqueue(new TextEncoder().encode('first\\n'));return}await fetch(origin+'/stream');c.enqueue(new TextEncoder().encode('last\\n'));c.close()}}),{headers:{'content-type':'text/plain'}})}
          if(p==='/mw/large'){let left=17*1024*1024;return new Response(new ReadableStream({pull(c){if(!left){c.close();return}const n=Math.min(left,65536);left-=n;c.enqueue(new Uint8Array(n).fill(42))}}),{headers:{'content-type':'application/octet-stream'}})}
          if(p==='/mw/redirect')return NextResponse.redirect(new URL('/static?redirect=middleware',request.url));
          if(p==='/ssg'&&mode==='redirect')return NextResponse.redirect(new URL('/static?redirect=data',request.url));
          let h;if(mode==='replace')h=new Headers({'x-added':'added'});else if(mode==='empty')h=new Headers();else{h=new Headers(request.headers);h.delete('x-remove');h.set('x-added','added');}
          if(p==='/mw/body')h.set('x-body-sha',createHash('sha256').update(Buffer.from(await request.clone().arrayBuffer())).digest('hex'));
          if(mode==='cookie-override')h.set('cookie','original=override');
          const init={request:{headers:h}};
          let response=p==='/mw/app'?NextResponse.rewrite(new URL('/app-target?dest=middleware',request.url),init):p==='/mw/static'?NextResponse.rewrite(new URL('/static?dest=middleware',request.url),init):p==='/mw/pages'?NextResponse.rewrite(new URL('/pages-target?dest=middleware',request.url),init):p==='/mw/before'?NextResponse.rewrite(new URL('/chain?phase=middleware',request.url),init):p==='/mw/data'?NextResponse.rewrite(new URL('/ssg',request.url),init):p==='/mw/external'?NextResponse.rewrite(new URL(origin+'/upstream?dest=middleware'),init):NextResponse.next(init);
          if(p==='/mw/action')response=NextResponse.rewrite(new URL('/actions-target?dest=middleware',request.url),init);
          response.headers.set('x-shared','middleware');response.headers.set('x-proxy-seen-path',p);
          if(p==='/mw/cookies'||p==='/mw/app'){response.cookies.set('mwc','fresh',{path:'/'});response.cookies.set('expires','with-date',{expires:new Date('2030-01-01T00:00:00Z')});}
          return response;
        }`,
    };
    for (const [file, source] of Object.entries(files)) await write(file, source);
    const build = async (args = []) => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/rustyx/cli.mjs'), 'build', fixture.root, ...args], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.rustyx/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { ...fixture, build, manifest, counts, completed, originUrl, write,
      hold(key) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
      async remove() { for (const gate of gates.values()) gate.release(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); },
    };
  } catch (error) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); throw error; }
}
