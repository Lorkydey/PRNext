import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appFixture, repositoryRoot } from './support.mjs';

export async function routeStaticFixture({ originDelayMs = 0 } = {}) {
  const fixture = await appFixture();
  const counts = new Map(), values = new Map(), gates = new Map();
  const origin = createServer(async (request, response) => {
    const key = new URL(request.url, 'http://origin').searchParams.get('key') || 'json';
    counts.set(key, (counts.get(key) || 0) + 1);
    const data = { key, count: counts.get(key), value: 0, mode: 'ok', ...values.get(key) };
    if (originDelayMs) await delay(originDelayMs);
    await gates.get(key)?.promise;
    if (!response.destroyed) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(data)); }
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const write = async (file, source) => { const target = path.join(fixture.root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, source); };
  try {
    await rm(path.join(fixture.root, 'app'), { recursive: true });
    await rm(path.join(fixture.root, 'pages'), { recursive: true, force: true });
    const files = {
      'lib/data.js': `export const origin=${JSON.stringify(originUrl)};
        export async function read(key,revalidate=false){const data=await(await fetch(origin+'/?key='+encodeURIComponent(key),{cache:'force-cache',next:{tags:['handler:'+key],revalidate}})).json();if(data.mode==='error')throw new Error('Handler origin failure');return data}
        export async function uncached(key){return(await fetch(origin+'/?key='+encodeURIComponent(key),{cache:'no-store'})).json()}
        export async function plain(key){return(await fetch(origin+'/?key='+encodeURIComponent(key))).json()}`,
      'app/static/json/route.js': `import {read} from '../../../lib/data';export const revalidate=false;export async function GET(){return Response.json(await read('json'),{headers:{'x-handler':'static-json'}})}`,
      'app/static/path/route.js': `export const revalidate=false;export function GET(request){return Response.json({pathname:request.nextUrl.pathname,method:request.method})}`,
      'app/static/binary/route.js': `export const dynamic='force-static';export function GET(){return new Response(Uint8Array.from({length:16384},(_,i)=>i%256),{status:201,headers:{'content-type':'application/octet-stream','x-binary':'yes'}})}`,
      'app/static/no-type/route.js': `export const revalidate=false;export function GET(){return new Response(new Uint8Array([0,255,42]))}`,
      'app/static/encoded/route.js': `import {gzipSync} from 'node:zlib';export const revalidate=false;export function GET(){return new Response(gzipSync('already encoded handler body '.repeat(512)),{headers:{'content-type':'text/plain','content-encoding':'gzip'}})}`,
      'app/static/cookies/route.js': `export const revalidate=false;export function GET(){const headers=new Headers({'content-type':'text/plain','cache-control':'private, no-store','etag':'"handler-owned"'});headers.append('set-cookie','first=one; Path=/');headers.append('set-cookie','second=two; HttpOnly; Path=/');return new Response('cookies from static response',{headers})}`,
      'app/static/head/route.js': `export const revalidate=false;export function GET(){return new Response('GET body',{status:201,headers:{'x-handler':'GET'}})}export function HEAD(){return new Response(null,{status:202,headers:{'x-handler':'HEAD'}})}`,
      'app/static/empty/route.js': `export const revalidate=false;export function GET(){return new Response(null,{status:204,headers:{'x-empty':'yes'}})}`,
      'app/static/missing/route.js': `export const revalidate=false;export function GET(){return new Response('cached missing',{status:404,headers:{'content-type':'text/plain'}})}`,
      'app/static/redirect/route.js': `import {redirect} from 'next/navigation';export const revalidate=false;export function GET(){redirect('/static/json')}`,
      'app/static/forced/route.js': `import {headers,cookies} from 'next/headers';export const dynamic='force-static';export async function GET(request){return Response.json({url:request.url,href:request.nextUrl.href,query:[...request.nextUrl.searchParams],requestHeader:request.headers.get('x-private'),requestCookie:request.cookies.get('secret')?.value||null,header:(await headers()).get('x-private'),cookie:(await cookies()).get('secret')?.value||null})}`,
      'app/cold/[id]/route.js': `import {read} from '../../../lib/data';export const revalidate=false;export const generateStaticParams=()=>[];export async function GET(request,{params}){return Response.json({...await read('cold/'+(await params).id),method:request.method},{status:201,headers:{'x-handler':'GET'}})}export function HEAD(){return new Response(null,{status:202,headers:{'x-handler':'HEAD'}})}`,
      'app/implicit/[id]/route.js': `import {read} from '../../../lib/data';export const revalidate=false;export const generateStaticParams=()=>[];export async function GET(request,{params}){return Response.json({...await read('implicit/'+(await params).id),method:request.method},{headers:{'x-handler':'implicit'}})}`,
      'app/closed/[id]/route.js': `export const revalidate=false;export const dynamicParams=false;export const generateStaticParams=()=>[{id:'built'}];export async function GET(_,{params}){return Response.json(await params)}`,
      'app/ttl/[id]/route.js': `import {read} from '../../../lib/data';export const revalidate=60;export const generateStaticParams=()=>[];export async function GET(_,{params}){return Response.json(await read('ttl/'+(await params).id,1))}`,
      'app/status/[id]/route.js': `import {read} from '../../../lib/data';export const revalidate=false;export const generateStaticParams=()=>[];export async function GET(_,{params}){const data=await read('status/'+(await params).id);return Response.json(data,{status:data.status||200})}`,
      'app/mixed-status/[id]/route.js': `import {plain} from '../../../lib/data';export const revalidate=false;export const generateStaticParams=()=>[{id:'ok'},{id:'bad'}];export async function GET(_,{params}){const {id}=await params;return Response.json(await plain('mixed-status/'+id),{status:id==='bad'?401:200})}`,
      'app/error-mode/[id]/route.js': `export const dynamic='error';export async function GET(_,{params}){return Response.json(await params)}`,
      'app/revalidate-only/[id]/route.js': `import {plain} from '../../../lib/data';export const revalidate=false;export async function GET(_,{params}){return Response.json(await plain('revalidate-only/'+(await params).id))}`,
      'app/dynamic/default/route.js': `import {uncached} from '../../../lib/data';export async function GET(){return Response.json(await uncached('default'))}`,
      'app/dynamic/request/route.js': `export const revalidate=false;export function GET(request){const clone=request.clone();return Response.json({url:request.url,query:Object.fromEntries(request.nextUrl.searchParams),header:clone.headers.get('x-private'),cookie:request.cookies.get('secret')?.value||null})}`,
      'app/dynamic/late/route.js': `import {headers} from 'next/headers';export const revalidate=false;export function GET(){return new Response(new ReadableStream({async pull(controller){controller.enqueue(new TextEncoder().encode((await headers()).get('x-private')||'none'));controller.close()}}),{headers:{'content-type':'text/plain'}})}`,
      'app/dynamic/caught/route.js': `import {headers} from 'next/headers';export const revalidate=false;export async function GET(){let value='caught';try{value=(await headers()).get('x-private')||'none'}catch{}return new Response(value)}`,
      'app/dynamic/mixed/route.js': `import {uncached} from '../../../lib/data';export const dynamic='force-static';export async function GET(){return Response.json(await uncached('mixed'))}export async function POST(request){return new Response(await request.text(),{status:201})}`,
      'app/dynamic/status/route.js': `import {plain} from '../../../lib/data';export const revalidate=false;export async function GET(){return Response.json(await plain('status-dynamic'),{status:401})}`,
      'app/api/invalidate/route.js': `import {revalidatePath,revalidateTag} from 'next/cache';export async function POST(request){const input=await request.json();if(input.path)revalidatePath(input.path,input.type);else revalidateTag(input.tag,input.mode==='stale'?'max':{expire:0});return Response.json({ok:true})}`,
      'prnext.config.mjs': `export default {async rewrites(){return [{source:'/handler-alias',destination:'/static/json?injected=destination'},{source:'/handler-html',destination:'/static/html?injected=destination'}]}}`,
      'app/static/html/route.js': `export const revalidate=false;export function GET(){return new Response('<!doctype html><html><body>Handler HTML</body></html>',{headers:{'content-type':'text/html'}})}`,
    };
    for (const [file, source] of Object.entries(files)) await write(file, source);
    const build = async (args = []) => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', fixture.root, ...args], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(await readFile(path.join(fixture.root, '.prnext/manifest.json'), 'utf8'));
    };
    const manifest = await build();
    return { ...fixture, build, manifest, counts, values, originUrl, write,
      hold(key) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
      async remove() { for (const gate of gates.values()) gate.release(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); },
    };
  } catch (error) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); await fixture.remove(); throw error; }
}
