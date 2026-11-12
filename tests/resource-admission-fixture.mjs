import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from '../packages/prnext/build/index.mjs';
import { repositoryRoot } from './support.mjs';

export async function resourceAdmissionFixture() {
  const root = await mkdtemp(path.join(repositoryRoot, '.prnext-resource-admission-'));
  const write = async (name, value) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  try {
    for (const [name, value] of Object.entries({
      'package.json': '{"type":"module"}',
      'prnext.config.mjs': 'export default {prerender:{workers:1}};',
      'app/layout.jsx': 'export default function Layout({children}){return <html><head/><body>{children}</body></html>}',
      'app/page.jsx': `import{headers}from'next/headers';export const dynamic='force-dynamic';export default async function Page(){return <main><h1>Small dynamic page</h1><p>{(await headers()).get('x-resource-owner')||'public'}</p></main>}`,
      'app/catalogue/page.jsx': `import{headers}from'next/headers';import{setTimeout as delay}from'node:timers/promises';
        export const dynamic='force-dynamic';
        function Rows({rows}){return <ul>{rows.map(row=><li key={row.id} title={row.name}>{row.name}<b>{row.price}</b></li>)}</ul>}
        export default async function Page({searchParams}){
          const owner=(await headers()).get('x-resource-owner')||'public',q=await searchParams;
          const bytes=Buffer.alloc(Math.min(24,Math.max(0,Number(q.memory)||0))*1024*1024,91);
          const rows=Array.from({length:1000},(_,id)=>({id,name:'Product '+id,price:id+1}));
          await delay(Math.min(500,Math.max(0,Number(q.wait)||0)));
          const until=performance.now()+Math.min(30,Math.max(0,Number(q.cpu)||0));let work=0;while(performance.now()<until)work++;
          return <main><p>{owner}</p><p>working-set:{bytes.length},check:{bytes[0]||0}</p><Rows rows={rows}/><span data-work={work}>complete</span></main>
        }`,
      'app/api/light/route.js': `export function GET(request){return Response.json({owner:request.headers.get('x-resource-owner')||'public',value:42})}`,
      'app/api/io/route.js': `import{setTimeout as delay}from'node:timers/promises';export async function GET(request){await delay(100);return Response.json({owner:request.headers.get('x-resource-owner')||'public',value:43})}`,
      'app/api/stream/route.js': `import{setTimeout as delay}from'node:timers/promises';export function GET(request){let count=0,closed=false;const owner=request.headers.get('x-resource-owner')||'public';return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(owner+'\\n'))},async pull(c){await delay(20);if(closed)return;if(++count===8){c.close();closed=true}else c.enqueue(new TextEncoder().encode('chunk '+count+'\\n'))},cancel(){closed=true}}))}`,
    })) await write(name, value);
    return { root, write, build: () => build(root), remove: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
