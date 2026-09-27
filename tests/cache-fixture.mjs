import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function cacheFixture({ originDelayMs = 0 } = {}) {
  const fixture = await appFixture();
  const counts = new Map(), values = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://origin');
    const key = url.searchParams.get('key') || 'page';
    if (request.method === 'POST') {
      values.set(key, (values.get(key) || 0) + 1);
    } else counts.set(key, (counts.get(key) || 0) + 1);
    const value = values.get(key) || 0;
    if (originDelayMs && request.method !== 'POST') await delay(originDelayMs);
    await gates.get(key)?.promise;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ key, value, count: counts.get(key) || 0, authorization: request.headers.authorization || '' }));
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true });
    const files = {
      'app/layout.jsx': `import Navigation from '../components/navigation';export default function Layout({children}){return <html><body><Navigation/>{children}</body></html>}`,
      'app/data.js': `import {unstable_cache} from 'next/cache';
        export const origin=${JSON.stringify(originUrl)};
        export const readCached=unstable_cache(async key=>{
          const result=await fetch(origin+'/?key='+encodeURIComponent(key),{cache:'no-store'});
          return {...await result.json(),producer:process.pid};
        },['cache-fixture'],{tags:['functions'],revalidate:false});`,
      'app/actions.js': `'use server';import {updateTag} from 'next/cache';import {readCached,origin} from './data';
        export async function mutate(){await fetch(origin+'/?key=page',{method:'POST'});updateTag('functions');return readCached('page');}`,
      'app/page.jsx': `import {readCached} from './data';import {mutate} from './actions';
        export default async function Page(){const data=await readCached('page');return <><h1>Shared cache</h1><p data-testid="cached-value">{data.value}</p><p data-testid="cached-count">{data.count}</p><form action={mutate}><button>Update cached value</button></form></>}`,
      'app/api/data/route.js': `import {readCached} from '../../data';
        export async function GET(request){return Response.json({...await readCached(new URL(request.url).searchParams.get('key')||'data'),worker:process.pid});}`,
      'app/api/raw/route.js': `import {origin} from '../../data';
        export async function GET(request){const key=new URL(request.url).searchParams.get('key')||'raw';return Response.json(await(await fetch(origin+'/?key='+encodeURIComponent(key),{cache:'no-store'})).json());}`,
      'app/api/fetch/route.js': `import {origin} from '../../data';
        export async function GET(request){const query=new URL(request.url).searchParams;const key=query.get('key')||'fetch';
          const result=await fetch(origin+'/?key='+encodeURIComponent(key),{cache:'force-cache',headers:{authorization:request.headers.get('authorization')||''},next:{tags:['fetch:'+key]}});
          return Response.json({...await result.json(),worker:process.pid});}`,
      'app/api/forced/route.js': `import {origin} from '../../data';export const fetchCache='force-no-store';
        export async function GET(){return Response.json(await(await fetch(origin+'/?key=forced-api',{cache:'force-cache'})).json());}`,
      'app/forced/layout.jsx': `export const dynamic='force-dynamic';export default function Layout({children}){return children}`,
      'app/forced/page.jsx': `import {origin} from '../data';export default async function Page(){const data=await(await fetch(origin+'/?key=forced-page',{cache:'force-cache'})).json();return <p>{data.count}</p>}`,
      'app/memo/page.jsx': `import {origin} from '../data';
        async function Item(){const data=await(await fetch(origin+'/?key=memo',{cache:'no-store'})).json();return <p>{data.count}</p>}
        export default function Page(){return <><Item/><Item/></>}`,
      'app/catalog/[id]/page.jsx': `import {origin} from '../../data';
        export default async function Page({params}){const {id}=await params;const data=await(await fetch(origin+'/?key=catalog-'+id,{cache:'force-cache'})).json();return <p data-testid="catalog-value">{data.value}</p>}`,
      'app/api/invalidate/route.js': `import {revalidateTag,revalidatePath,updateTag} from 'next/cache';import {readCached} from '../../data';
        export async function POST(request){const input=await request.json();
          if(input.update)updateTag(input.update);
          else if(input.path)revalidatePath(input.path,input.type);
          else revalidateTag(input.tag,input.mode==='stale'?'max':{expire:0});
          return Response.json(input.read?await readCached(input.read):{invalidated:true});}`,
    };
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture.root, file)), { recursive: true });
      await writeFile(path.join(fixture.root, file), contents);
    }
    const build = () => promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root]);
    await build();
    return { ...fixture, build, counts, values, originUrl,
      hold(key) {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        gates.set(key, { promise });
        return () => { gates.delete(key); release(); };
      },
      async remove() {
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
