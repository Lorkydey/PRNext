import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {build} from '../packages/prnext/build/index.mjs';
import {repositoryRoot} from './support.mjs';

export async function frameworkOptimizationsFixture({extraRoutes=12}={}) {
  const root=await mkdtemp(path.join(repositoryRoot,'.prnext-framework-optimizations-'));
  const write=async(name,source)=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);};
  const remove=async()=>{assert.equal(path.dirname(root),path.resolve(repositoryRoot));assert.ok(path.basename(root).startsWith('.prnext-framework-optimizations-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});};
  try {
    for(const [name,source]of Object.entries({
      'package.json':JSON.stringify({type:'module',dependencies:{'@tanstack/react-query':'5.107.1','@tanstack/query-core':'5.107.1'}}),
      'prnext.config.mjs':"export default {prerender:{workers:1},navigationCache:{maxEntries:3,ttlMs:30000,authCookies:['query_owner']}};",
      'app/layout.jsx':'export default function Layout({children}){return <html><head/><body>{children}</body></html>}',
      'app/page.jsx':`import Link from'next/link';export default function Page(){return <main><h1>Framework optimizations</h1><Link href='/query' prefetch={false}>Query page</Link><Link href='/deferred' prefetch={false}>Deferred page</Link></main>}`,
      'app/other/page.jsx':`import Link from'next/link';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Other page</h1><Link href='/deferred-visible' prefetch={false}>Deferred visible</Link><Link href='/query' prefetch={false}>Query page</Link></main>}`,
      'app/navigation/[slug]/page.jsx':`export const dynamic='force-dynamic';export default function Page(){return <p>Navigation page</p>}`,
      'app/navigation/layout.jsx':`import Navigation from'../Navigation';export default function Layout({children}){return <main><Navigation/>{children}</main>}`,
      'app/Navigation.jsx':`'use client';import React from'react';import{useRouter,usePathname,useParams,useSearchParams}from'next/navigation';
        function record(name){if(typeof window!=='undefined'){window.__navRenders||={};window.__navRenders[name]=(window.__navRenders[name]||0)+1}}
        const Router=React.memo(function Router(){record('router');useRouter();return <p data-testid='router-observer'>router</p>});
        const Path=React.memo(function Path(){record('path');return <p data-testid='path-observer'>{usePathname()}</p>});
        const Params=React.memo(function Params(){record('params');return <p data-testid='params-observer'>{useParams().slug}</p>});
        const Search=React.memo(function Search(){record('search');return <p data-testid='search-observer'>{useSearchParams().get('q')||'empty'}</p>});
        export default function Navigation(){const router=useRouter();return <><button onClick={()=>router.push('?q=second')}>Update query</button><button onClick={()=>router.push('/navigation/two?q=second')}>Update slug</button><Router/><Path/><Params/><Search/></>}`,
      'app/query/actions.js':`'use server';import{cookies}from'next/headers';import{revalidatePath}from'next/cache';export async function changeOwner(){(await cookies()).set('query_owner','owner-B',{path:'/',httpOnly:true});revalidatePath('/query')}`,
      'app/query/page.jsx':`import{headers,cookies}from'next/headers';import{getQueryClient,dehydrateQuery}from'@thomas.f/prnext/query/server';import{QueryProvider,QueryHydrationBoundary}from'@thomas.f/prnext/query';import QueryView from'../QueryView';import{changeOwner}from'./actions';
        export const dynamic='force-dynamic';export default async function Page(){const owner=(await cookies()).get('query_owner')?.value||(await headers()).get('x-query-owner')||'owner-A';const client=getQueryClient();let calls=0;const options={queryKey:['account'],queryFn:async()=>({owner,source:'ssr',calls:++calls,marker:'QUERY-SNAPSHOT-ONLY-ONCE-123456789'})};await Promise.all([client.prefetchQuery(options),getQueryClient().prefetchQuery(options)]);const state=dehydrateQuery(client);return <main><QueryProvider state={state} scopeKey={owner}><QueryView name='one'/><QueryProvider><QueryHydrationBoundary state={dehydrateQuery(client)}><QueryView name='two'/></QueryHydrationBoundary></QueryProvider></QueryProvider><form action={changeOwner}><button>Change query owner</button></form></main>}`,
      'app/QueryView.jsx':`'use client';import React from'react';import Link from'next/link';import{useQuery,useQueryClient}from'@tanstack/react-query';export default function QueryView({name}){const client=useQueryClient();const result=useQuery({queryKey:['account'],queryFn:({signal})=>fetch('/api/query',{signal}).then(r=>r.json())});const draft=useQuery({queryKey:['local-draft'],enabled:false});React.useEffect(()=>{window.__queryHydrated=true},[]);return <section><p data-testid={'query-'+name}>{result.data?result.data.owner+':'+result.data.source+':'+result.data.calls:'loading'}</p><p data-testid={'draft-'+name}>{draft.data||'empty'}</p>{name==='one'?<><button onClick={()=>client.invalidateQueries({queryKey:['account']})}>Refresh query</button><button onClick={()=>client.setQueryData(['local-draft'],'kept')}>Remember query draft</button><Link href='/other' prefetch={false}>Other query page</Link></>:null}</section>}`,
      'app/api/query/route.js':`import{cookies,headers}from'next/headers';let calls=0;export async function GET(){return Response.json({owner:(await cookies()).get('query_owner')?.value||(await headers()).get('x-query-owner')||'owner-A',source:'browser',calls:++calls})}`,
      'pages/_app.jsx':`import{QueryProvider}from'@thomas.f/prnext/query';export default function App({Component,pageProps}){return <QueryProvider state={pageProps.queryState} scopeKey={pageProps.owner}><Component {...pageProps}/></QueryProvider>}`,
      'pages/query-legacy.jsx':`import{getQueryClient,dehydrateQuery}from'@thomas.f/prnext/query/server';import QueryView from'../app/QueryView';export async function getServerSideProps({req}){const owner=req.headers['x-query-owner']||'owner-A',client=getQueryClient();await client.prefetchQuery({queryKey:['account'],queryFn:()=>({owner,source:'ssr',calls:1})});return{props:{owner,queryState:dehydrateQuery(client)}}}export default function Page(){return <main><QueryView name='one'/><QueryView name='two'/></main>}`,
      'app/DeferredDemo.jsx':`'use client';import React from'react';import Link from'next/link';import{deferHydration}from'@thomas.f/prnext/hydration';
        const Interaction=deferHydration(()=>import('./DeferredWidget'),{when:'interaction'});
        const Visible=deferHydration(()=>import('./DeferredWidget'),{when:'visible',rootMargin:'0px'});
        const Idle=deferHydration(()=>import('./DeferredWidget'),{when:'idle'});
        const Nested=deferHydration(()=>import('./DeferredPanel'),{when:'interaction'});
        export default function DeferredDemo({strategy='interaction'}){const[n,set]=React.useState(0),[label,setLabel]=React.useState('label-A');const Component=strategy==='visible'?Visible:strategy==='idle'?Idle:strategy==='nested'?Nested:Interaction;return <main><button data-testid='eager' onClick={()=>set(n+1)}>Eager {n}</button><button onClick={()=>setLabel('label-B')}>Change deferred props</button><Link href='/other' prefetch={false}>Leave deferred</Link>{strategy==='visible'?<div style={{height:2000}}>Spacer</div>:null}<Component label={label}/></main>}`,
      'app/DeferredWidget.jsx':`import React from'react';if(typeof window!=='undefined')window.__DEFERRED_WIDGET_CODE__=(window.__DEFERRED_WIDGET_CODE__||0)+1;export default function DeferredWidget({label}){const[n,set]=React.useState(0);React.useEffect(()=>{window.__deferredHydrated=true},[]);return <section><p data-testid='deferred-label'>{label}</p><button data-testid='deferred-button' onClick={()=>{window.__deferredClicks=(window.__deferredClicks||0)+1;set(n=>n+1)}}>Deferred {n}</button><label>Deferred input<input data-testid='deferred-input' defaultValue='server text'/></label><form onSubmit={event=>{event.preventDefault();window.__deferredSubmits=(window.__deferredSubmits||0)+1;}}><button data-testid='deferred-submit'>Deferred submit</button></form></section>}`,
      'app/DeferredPanel.jsx':`import{deferHydration}from'@thomas.f/prnext/hydration';const Inner=deferHydration(()=>import('./DeferredWidget'),{when:'interaction'});export default function Panel(props){return <section><h2>Nested panel</h2><Inner {...props}/></section>}`,
      'app/deferred/page.jsx':`import Demo from'../DeferredDemo';export default function Page(){return <Demo/>}`,
      'app/deferred-edge/page.jsx':`import Demo from'../DeferredDemo';export const runtime='edge';export const dynamic='force-dynamic';export default function Page(){return <Demo/>}`,
      'app/deferred-visible/page.jsx':`import Demo from'../DeferredDemo';export const dynamic='force-dynamic';export default function Page(){return <Demo strategy='visible'/>}`,
      'app/deferred-idle/page.jsx':`import Demo from'../DeferredDemo';export default function Page(){return <Demo strategy='idle'/>}`,
      'app/deferred-nested/page.jsx':`import Demo from'../DeferredDemo';export default function Page(){return <Demo strategy='nested'/>}`,
    }))await write(name,source);
    for(let index=0;index<extraRoutes;index++){
      await write(`app/unrelated-${index}/Client.jsx`,`'use client';export default function Unrelated(){return <button onClick={()=>{}}>Unrelated ${index}</button>}`);
      await write(`app/unrelated-${index}/page.jsx`,`import Client from'./Client';export default function Page(){return <Client/>}`);
    }
    return {root,write,remove,build:()=>build(root),async widgetAsset(){const directory=path.join(root,'.prnext/assets');for(const file of await readdir(directory))if(file.endsWith('.js')&&(await readFile(path.join(directory,file),'utf8')).includes('__DEFERRED_WIDGET_CODE__'))return '/_prnext/assets/'+file;throw Error('Deferred widget chunk not found');}};
  }catch(error){await remove();throw error;}
}
