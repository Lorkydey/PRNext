import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function cacheComponentsFixture() {
  const fixture = await appFixture();
  try {
    for (const item of ['app', 'pages', 'proxy.ts']) await rm(path.join(fixture.root, item), { recursive: true, force: true });
    const files = {
      'prnext.config.mjs': `export default{cacheComponents:true,cacheLife:{test:{stale:0,revalidate:30,expire:60}}}`,
      'app/layout.jsx': `import{Suspense}from'react';export default({children})=><html><body><Suspense fallback={<p>Loading request data</p>}>{children}</Suspense></body></html>`,
      'app/page.jsx': `import{cookies}from'next/headers';import{cacheLife,cacheTag}from'next/cache';import Counter from'./counter';let calls=0;async function Box({children,tenant}){'use cache';cacheLife('test');cacheTag('box');const value=++calls;return <section><p data-testid="cached">{tenant+':'+value}</p><Counter/>{children}</section>}export default async function Page(){const tenant=(await cookies()).get('tenant')?.value||'public';return <Box tenant={tenant}><p data-testid="private">{(await cookies()).get('private')?.value||'none'}</p></Box>}`,
      'app/counter.jsx': `'use client';import{useState}from'react';import{useRouter}from'next/navigation';export default function Counter(){const[n,set]=useState(0);const router=useRouter();return <><button onClick={()=>set(n+1)}>Count {n}</button><button onClick={()=>router.refresh()}>Refresh</button></>}`,
      'app/data/route.ts': `import {cacheLife,cacheTag} from'next/cache';let calls=0;async function data(id:string){'use cache';cacheLife({stale:0,revalidate:30,expire:60});cacheTag('data:'+id);const date=new Date('2026-01-02');return {value:++calls,id,date,map:new Map([['a',7]]),set:new Set([3]),big:12n}}export async function GET(request){const id=new URL(request.url).searchParams.get('id')||'a';const value=await data(id);return Response.json({value:value.value,id:value.id,date:value.date.toISOString(),map:value.map.get('a'),set:[...value.set],big:String(value.big)})}`,
      'app/clear/route.ts': `import{revalidateTag}from'next/cache';export async function POST(request){revalidateTag(new URL(request.url).searchParams.get('tag')||'box',{expire:0});return Response.json({ok:true})}`,
      'app/private/page.jsx': `import{cookies}from'next/headers';import{cacheLife}from'next/cache';async function Content(){'use cache: private';cacheLife('test');return <p data-testid="private">{(await cookies()).get('tenant')?.value||'public'}</p>}export default()=> <Content/>`,
      'app/static/page.jsx': `import{cacheLife,cacheTag}from'next/cache';export default async function Page(){'use cache';cacheLife('hours');cacheTag('static');return <h1>Cached static component</h1>}`,
      'app/closure/route.ts': `import{cacheLife}from'next/cache';let calls=0;export async function GET(request){const tenant=new URL(request.url).searchParams.get('tenant')||'a';async function inner(key:string){'use cache';cacheLife('test');return {tenant,key,value:++calls}}return Response.json(await inner('same'))}`,
      'app/short/route.ts': `import{cacheLife,cacheTag}from'next/cache';let calls=0;async function child(){'use cache';cacheTag('nested-child');cacheLife({revalidate:.15,expire:.3,stale:0});return ++calls}async function parent(){'use cache';return await child()}export async function GET(){return Response.json({value:await parent()})}`,
      'app/fetch-tag/route.ts': `import{cacheLife}from'next/cache';let calls=0;async function read(){'use cache';cacheLife({stale:0,revalidate:30,expire:60});await fetch('data:text/plain,hello',{next:{tags:['nested-fetch']}});return ++calls}export async function GET(){return Response.json({value:await read()})}`,
      'app/unsafe/route.ts': `import{headers}from'next/headers';async function data(){'use cache';return (await headers()).get('authorization')}export async function GET(){return Response.json({value:await data()})}`,
    };
    for (const [name, body] of Object.entries(files)) { const file = path.join(fixture.root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, body); }
    return { ...fixture, build: async () => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root], { maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    } };
  } catch (error) { await fixture.remove(); throw error; }
}
