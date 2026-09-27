import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function appStaticFixture({ originDelayMs = 0 } = {}) {
  const fixture = await appFixture();
  const counts = new Map(), values = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://origin').searchParams.get('key') || 'home';
    if (request.method === 'POST') values.set(key, { ...values.get(key), value: (values.get(key)?.value || 0) + 1 });
    else counts.set(key, (counts.get(key) || 0) + 1);
    const data = { key, value: 0, mode: 'ok', ...values.get(key), count: counts.get(key) || 0 };
    if (originDelayMs) await delay(originDelayMs);
    await gates.get(key)?.promise;
    response.setHeader('content-type', 'application/json');
    if (data.mode === 'error') response.statusCode = 500;
    response.end(JSON.stringify(data));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true });
    const files = {
      'lib/static-data.js': `export const origin=${JSON.stringify(originUrl)};
        export async function read(key,revalidate=false){const response=await fetch(origin+'/?key='+encodeURIComponent(key),{cache:'force-cache',next:{tags:['static:'+key],revalidate}});if(!response.ok)throw new Error('Static origin failure');return response.json()}`,
      'app/client.jsx': `'use client';import {useState} from 'react';import {usePathname,useSearchParams,useRouter} from 'next/navigation';import Link from 'next/link';
        export function Navigation(){const [count,setCount]=useState(0);const search=useSearchParams(),pathname=usePathname(),router=useRouter();return <header>
          <button onClick={()=>setCount(count+1)}>Layout count: {count}</button><button onClick={()=>router.refresh()}>Refresh page</button>
          <Link href="/">Home</Link><Link href="/catalog/built?from=navigation">Catalog</Link><Link href="/plain?from=plain">Plain</Link><Link href="/redirect">Cached redirect</Link>
          <Link href="/client-search?from=navigation&tag=one&tag=two">Client page</Link><Link href="/client-force?from=secret">Forced client page</Link><Link href="/custom-client?from=outer">Custom client props</Link>
          <p data-testid="client-path">{pathname}</p><p data-testid="client-query">{search.get('from')||'none'}</p></header>}`,
      'app/layout.jsx': `import {Navigation} from './client';export const metadata={title:{default:'Static fixture',template:'%s | Static fixture'}};export default function Layout({children}){return <html><head/><body><Navigation/>{children}</body></html>}`,
      'app/view.jsx': `export default function View({data}){return <main><h1>{data.key}</h1><p data-testid="value">{data.value}</p><p data-testid="count">{data.count}</p></main>}`,
      'app/actions.js': `'use server';import {updateTag} from 'next/cache';import {origin,read} from '../lib/static-data';export async function update(){await fetch(origin+'/?key=home',{method:'POST',cache:'no-store'});updateTag('static:home');return read('home')}`,
      'app/page.jsx': `import {read} from '../lib/static-data';import View from './view';import {update} from './actions';export default async function Page(){return <><View data={await read('home')}/><form action={update}><button>Update static home</button></form></>}`,
      'app/plain/page.jsx': `const generated=Date.now();export default function Page(){return <><h1>Plain static</h1><p data-testid="generated">{generated}</p></>}`,
      'app/client-search/page.jsx': `'use client';import {use} from 'react';export default function Page({searchParams,params}){const query=use(searchParams);const values=use(params);return <main><h1>Client search page</h1><p data-testid="page-query">{query.from||'none'}</p><p data-testid="page-repeated">{JSON.stringify(query.tag||[])}</p><p data-testid="page-params">{JSON.stringify(values)}</p></main>}`,
      'app/client-force/page.jsx': `'use client';export const dynamic='force-static';export {default} from '../client-search/page';`,
      'app/custom-client/custom.jsx': `'use client';import {use} from 'react';export default function Custom({searchParams,params}){return <><p data-testid="custom-query">{use(searchParams).from}</p><p data-testid="custom-params">{use(params).id}</p></>}`,
      'app/custom-client/page.jsx': `import Custom from './custom';export default function Page(){return <Custom searchParams={Promise.resolve({from:'component-owned'})} params={Promise.resolve({id:'custom-id'})}/>}`,
      'app/catalog/[id]/page.jsx': `import {read} from '../../../lib/static-data';import View from '../../view';export const generateStaticParams=()=>[{id:'built'}];export async function generateMetadata({params}){return {title:'Product '+(await params).id}}export default async function Page({params}){const {id}=await params;return <View data={await read('catalog/'+id)}/>}`,
      'app/closed/[id]/page.jsx': `import {read} from '../../../lib/static-data';import View from '../../view';export const dynamicParams=false;export const generateStaticParams=()=>[{id:'built'}];export default async function Page({params}){return <View data={await read('closed/'+(await params).id)}/>}`,
      'app/nested/[category]/layout.jsx': `export const dynamicParams=false;export const generateStaticParams=()=>[{category:'a'},{category:'b'}];export default function Layout({children}){return children}`,
      'app/nested/[category]/[id]/page.jsx': `export const generateStaticParams=({params})=>[{id:params.category+'-one'}];export default async function Page({params}){const {category,id}=await params;return <h1>{category+':'+id}</h1>}`,
      'app/(group)/grouped/[...parts]/page.jsx': `export const generateStaticParams=()=>[{parts:['a','b']}];export default async function Page({params}){return <h1>{(await params).parts.join(' / ')}</h1>}`,
      'app/optional/[[...slug]]/page.jsx': `export const generateStaticParams=()=>[{slug:[]},{slug:['hello']}];export default async function Page({params}){return <h1>{(await params).slug?.join('/')||'optional root'}</h1>}`,
      'app/ttl/[id]/page.jsx': `import {read} from '../../../lib/static-data';import View from '../../view';export const revalidate=60;export const generateStaticParams=()=>[];export default async function Page({params}){return <View data={await read('ttl/'+(await params).id,1)}/>}`,
      'app/dynamic-cookie/page.jsx': `import {headers,cookies} from 'next/headers';export default async function Page(){return <p data-testid="request">{(await headers()).get('x-marker')+':'+(await cookies()).get('marker')?.value}</p>}`,
      'app/search/page.jsx': `export default async function Page({searchParams}){return <p data-testid="search">{(await searchParams).from||'none'}</p>}`,
      'app/uncached/page.jsx': `import {origin} from '../../lib/static-data';import View from '../view';export default async function Page(){return <View data={await(await fetch(origin+'/?key=uncached',{cache:'no-store'})).json()}/>}`,
      'app/force-static/page.jsx': `import {headers,cookies} from 'next/headers';export const dynamic='force-static';export default async function Page({searchParams}){return <p data-testid="forced">{JSON.stringify({header:(await headers()).get('x-marker'),cookie:(await cookies()).get('marker')?.value||null,query:(await searchParams).from||null})}</p>}`,
      'app/closed-dynamic/[id]/page.jsx': `import {headers} from 'next/headers';export const dynamicParams=false;export const generateStaticParams=()=>[{id:'built'}];export default async function Page(){return <p>{(await headers()).get('x-marker')||'none'}</p>}`,
      'app/catalog/specific/page.jsx': `export const dynamic='force-dynamic';export default function Page(){return <h1>Specific dynamic route</h1>}`,
      'app/redirect/page.jsx': `import {redirect} from 'next/navigation';export default function Page(){redirect('/plain')}`,
      'app/missing/not-found.jsx': `export default function Missing(){return <h1>Static missing page</h1>}`,
      'app/missing/page.jsx': `import {notFound} from 'next/navigation';export default function Page(){notFound()}`,
      'app/api/invalidate/route.js': `import {revalidateTag,revalidatePath} from 'next/cache';export async function POST(request){const input=await request.json();if(input.path)revalidatePath(input.path,input.type);else revalidateTag(input.tag,input.mode==='stale'?'max':{expire:0});return Response.json({ok:true})}`,
    };
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture.root, file)), { recursive: true });
      await writeFile(path.join(fixture.root, file), source);
    }
    const build = async (args = []) => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root, ...args], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { ...fixture, build, manifest, counts, values, originUrl,
      hold(key) {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        gates.set(key, { promise, release });
        return () => { gates.delete(key); release(); };
      },
      async remove() {
        for (const gate of gates.values()) gate.release();
        origin.closeAllConnections();
        await new Promise(resolve => origin.close(resolve));
        await fixture.remove();
      },
    };
  } catch (error) {
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    await fixture.remove();
    throw error;
  }
}
