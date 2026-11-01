import {mkdir,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const productionFixtureFiles=Object.freeze({
 'package.json':JSON.stringify({name:'private-prnext-vps-audit',private:true,type:'module',dependencies:{next:'16.4.3',react:'19.3.1','react-dom':'19.3.1','react-server-dom-webpack':'19.3.1','@thomas.f/prnext':'file:../framework.tgz'}}),
 'next.config.mjs':`export default {generateBuildId:()=> 'private-vps-audit-20261029'};`,
 'app/layout.jsx':`import Link from 'next/link';import Counter from '../components/Counter.jsx';export default function Layout({children}){return <html lang="en"><body><nav><Link href="/ssr">SSR</Link><Link href="/stream">Stream</Link><Link href="/heavy">Heavy</Link></nav><Counter/>{children}</body></html>}`,
 'components/Counter.jsx':`'use client';import {useState,useEffect} from 'react';export default function Counter(){const [n,set]=useState(0);useEffect(()=>{document.documentElement.dataset.hydrated='yes'},[]);return <button id="counter" onClick={()=>set(n+1)}>Count {n}</button>}`,
 'components/Rows.jsx':`export default function Rows({count=100}){return <table><tbody>{Array.from({length:count},(_,i)=><tr key={i}><td>{i}</td><td>{'row '+i}</td><td>{i*7}</td></tr>)}</tbody></table>}`,
 'app/ssr/page.jsx':`import {cookies} from 'next/headers';import {randomUUID} from 'node:crypto';import Rows from '../../components/Rows.jsx';export const dynamic='force-dynamic';export default async function Page(){const user=(await cookies()).get('user')?.value||'anonymous';return <main><h1>SSR fixture</h1><p>{'user:'+user}</p><p>{'nonce:'+randomUUID()}</p><Rows/></main>}`,
 'app/heavy/page.jsx':`import {cookies} from 'next/headers';import {randomUUID} from 'node:crypto';import Rows from '../../components/Rows.jsx';export const dynamic='force-dynamic';export default async function Page(){const user=(await cookies()).get('user')?.value||'anonymous';return <main><h1>Heavy SSR fixture</h1><p>{'user:'+user}</p><p>{'nonce:'+randomUUID()}</p><Rows count={1000}/></main>}`,
 'app/stream/page.jsx':`import {Suspense} from 'react';import {cookies} from 'next/headers';import {randomUUID} from 'node:crypto';export const dynamic='force-dynamic';async function Slow({user,nonce,delay}){await new Promise(resolve=>setTimeout(resolve,delay));return <p>{'completed:'+user+':'+nonce}</p>}export default async function Page({searchParams}){const user=(await cookies()).get('user')?.value||'anonymous',nonce=randomUUID(),q=await searchParams,delay=q.delay?Math.min(2000,Math.max(0,Number(q.delay))):40;return <main><h1>Stream fixture</h1><p>{'user:'+user}</p><p>{'nonce:'+nonce}</p><Suspense fallback={<p>pending-stream</p>}><Slow user={user} nonce={nonce} delay={delay}/></Suspense></main>}`,
 'app/static/page.jsx':`import Rows from '../../components/Rows.jsx';export default function Page(){return <main><h1>Static fixture</h1><Rows/></main>}`,
 'app/api/json/route.js':`import {randomUUID} from 'node:crypto';export const dynamic='force-dynamic';export function GET(request){const user=request.headers.get('cookie')?.match(/(?:^|;\\s*)user=([^;]*)/)?.[1]||'anonymous';return Response.json({user,nonce:randomUUID(),rows:Array.from({length:16},(_,i)=>({id:i,value:'value '+i}))},{headers:{'cache-control':'private, no-store'}})}`,
 'pages/legacy.jsx':`import Rows from '../components/Rows.jsx';export function getServerSideProps({req}){return {props:{user:req.cookies.user||'anonymous',nonce:crypto.randomUUID()}}}export default function Page({user,nonce}){return <main><h1>Pages SSR fixture</h1><p>{'user:'+user}</p><p>{'nonce:'+nonce}</p><Rows/></main>}`,
 'pages/api/legacy.js':`import {randomUUID} from 'node:crypto';export default function handler(req,res){res.setHeader('cache-control','private, no-store');res.json({user:req.cookies.user||'anonymous',nonce:randomUUID(),rows:Array.from({length:16},(_,i)=>({id:i,value:'value '+i}))})}`,
 'middleware.js':`import {NextResponse} from 'next/server';export function middleware(request){const response=NextResponse.rewrite(new URL('/ssr',request.url));response.headers.set('x-audit-middleware','once');return response}export const config={matcher:'/guarded'};`,
 'public/probe.txt':'private benchmark readiness\n',
 'public/payload.txt':'Identical private PRNext and Next.js benchmark payload.\n'.repeat(1024),
 'public/robots.txt':'User-agent: *\nDisallow: /\n'
});
export async function createProductionFixture(directory){
 const root=path.resolve(directory);await mkdir(root,{recursive:true});
 if((await readdir(root)).length)throw Error('Refusing to overwrite a nonempty fixture directory');
 const hashes={};for(const[name,source]of Object.entries(productionFixtureFiles)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);hashes[name]=createHash('sha256').update(source).digest('hex');}
 await writeFile(path.join(root,'.benchmark-fixture.json'),JSON.stringify(hashes,null,2));return{root,files:Object.keys(productionFixtureFiles).length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw Error('Provide an empty fixture directory');
 console.log(JSON.stringify(await createProductionFixture(process.argv[2])));
}
