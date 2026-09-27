import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function partialFixture() {
  const fixture = await appFixture();
  let fetches = 0;
  const origin = createServer((_request, response) => { fetches++; response.end('Network response'); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const closeOrigin = () => new Promise(resolve => origin.close(resolve));
  try {
    for (const name of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, name), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default {cacheComponents:true,rewrites:async()=>[{source:'/visible/:id',destination:'/product/:id'}]}`,
      'app/layout.jsx': `import{randomUUID}from'node:crypto';export default({children})=><html><body><header data-testid="shell">{'Built '+randomUUID()}</header>{children}</body></html>`,
      'app/page.jsx': `import{Suspense}from'react';import{cookies,headers}from'next/headers';import Counter from'./counter';import{rename}from'./actions';async function Personal(){const cookie=await cookies();const delay=Number((await headers()).get('x-test-delay')||0);if(delay)await new Promise(r=>setTimeout(r,delay));return <section><p data-testid="personal">{cookie.get('name')?.value||'guest'}</p><Counter/><form action={rename}><button type="submit">Rename visitor</button></form></section>}export default()=> <main><h1>Shared catalogue</h1><Suspense fallback={<p data-testid="pending">Waiting for request</p>}><Personal/></Suspense></main>`,
      'app/actions.js': `'use server';import{cookies}from'next/headers';export async function rename(){(await cookies()).set('name','Action visitor')}`,
      'app/blocking/page.jsx': `import{cookies}from'next/headers';export const instant=false;export default async()=> <p data-testid="blocking">{(await cookies()).get('name')?.value||'guest'}</p>`,
      'app/counter.jsx': `'use client';import{useState}from'react';import{useRouter}from'next/navigation';export default function Counter(){const[n,set]=useState(0);const router=useRouter();return <><button onClick={()=>set(n+1)}>Count {n}</button><button onClick={()=>router.refresh()}>Refresh</button></>}`,
      'app/query/page.jsx': `import{Suspense}from'react';async function Result({searchParams}){return <p data-testid="query">{(await searchParams).q||'none'}</p>}export default({searchParams})=><Suspense fallback={<p>Waiting query</p>}><Result searchParams={searchParams}/></Suspense>`,
      'app/metadata/page.jsx': `import{Suspense}from'react';import{connection}from'next/server';async function Dynamic(){await connection();return null}import{cookies}from'next/headers';export async function generateMetadata(){return{title:'Hello '+((await cookies()).get('name')?.value||'guest')}}export default()=> <><h1>Metadata shell</h1><Suspense fallback={null}><Dynamic/></Suspense></>`,
      'app/mixed/page.jsx': `import{Suspense}from'react';import{connection}from'next/server';import{cookies}from'next/headers';import{cacheLife,cacheTag}from'next/cache';import{randomUUID}from'node:crypto';async function Cached(){'use cache';cacheLife({stale:0,revalidate:1,expire:2});cacheTag('partial-catalogue');return <p data-testid="cached">{'Cached '+randomUUID()}</p>}async function Private(){'use cache: private';return <p data-testid="private">{(await cookies()).get('name')?.value||'guest'}</p>}async function Live(){await connection();return <p data-testid="connection">Request connected</p>}async function Network(){const r=await fetch(${JSON.stringify(originUrl)});return <p data-testid="network">{await r.text()}</p>}export default()=> <main><Cached/><Suspense fallback={<p>Waiting private</p>}><Private/></Suspense><Suspense fallback={<p>Waiting connection</p>}><Live/></Suspense><Suspense fallback={<p>Waiting network</p>}><Network/></Suspense></main>`,
      'app/tag/route.js': `import{revalidateTag}from'next/cache';export async function POST(){revalidateTag('partial-catalogue',{expire:0});return Response.json({ok:true})}`,
      'app/redirect/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';import{redirect}from'next/navigation';async function Target(){await cookies();redirect('/query?q=redirected')}export default()=> <Suspense fallback={<p>Checking session</p>}><Target/></Suspense>`,
      'app/client-query.jsx': `'use client';import{useSearchParams}from'next/navigation';export default function Query(){return <p data-testid="client-query">{useSearchParams().get('q')||'none'}</p>}`,
      'app/client-query/page.jsx': `import{Suspense}from'react';import Query from'../client-query';export default()=> <main><h1>Query shell</h1><Suspense fallback={<p>Waiting client query</p>}><Query/></Suspense></main>`,
      'app/pathname.jsx': `'use client';import{usePathname}from'next/navigation';export default()=> <p data-testid="pathname">{usePathname()}</p>`,
      'app/product/[id]/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';import Pathname from'../../pathname';import Counter from'../../counter';import Link from'next/link';async function Product({params}){return <><h1 data-testid="product">{(await params).id}</h1><Pathname/><Counter/><Link href="/product/other">Other product</Link></>}async function Visitor(){return <p data-testid="product-visitor">{(await cookies()).get('name')?.value||'guest'}</p>}export default({params})=> <main><h2>Product shell</h2><Suspense fallback={<p>Waiting product</p>}><Product params={params}/></Suspense><Suspense fallback={<p>Waiting visitor</p>}><Visitor/></Suspense></main>`,
      'app/generated/[id]/page.jsx': `import{Suspense}from'react';import{cookies}from'next/headers';export function generateStaticParams(){return[{id:'seed'}]}async function Visitor(){return <p data-testid="generated-visitor">{(await cookies()).get('name')?.value||'guest'}</p>}export default async({params})=> <><h1 data-testid="generated">{(await params).id}</h1><Suspense fallback={<p>Waiting visitor</p>}><Visitor/></Suspense></>`,
      'app/complete/[id]/page.jsx': `import{Suspense}from'react';import{randomUUID}from'node:crypto';async function Content({params}){return <p data-testid="complete">{(await params).id+':'+randomUUID()}</p>}export default({params})=> <Suspense fallback={<p>Waiting params</p>}><Content params={params}/></Suspense>`,
      'app/draft/route.js': `import{draftMode}from'next/headers';export async function GET(){(await draftMode()).enable();return Response.json({ok:true})}`,
      'app/invalidate/route.js': `import{revalidatePath}from'next/cache';export async function POST(){revalidatePath('/','layout');return Response.json({ok:true})}`,
    };
    for (const [name, source] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
    return { ...fixture, fetches: () => fetches, remove: async () => { await closeOrigin(); await fixture.remove(); }, build: async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    } };
  } catch (error) { await closeOrigin(); await fixture.remove(); throw error; }
}
