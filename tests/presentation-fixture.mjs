import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from '../packages/prnext/build/index.mjs';
import {repositoryRoot} from './support.mjs';

export const presentationSecrets = ['PRIVATE-PRESENTATION-ROW', 'PRIVATE-PRESENTATION-OWNER', 'PRIVATE-PRESENTATION-UNUSED'];
export const presentationTable = `'use presentation';
export default function Table({rows,title,unused}) {
  return <section data-testid="presentation"><h2>{title}</h2><p data-testid="count">{rows.length}</p><table><tbody>{rows.map((row,index)=><tr key={row.id}><td>{index+1}</td><td>{row.name}</td><td>{row.price}</td><td>{row.owner.label}</td><td className={row.available?'available':'sold'}>{row.available?'Available':'Sold'}</td></tr>)}</tbody></table></section>;
}`;

export async function presentationFixture({enabled=true, webpack=false, reactCompiler=false}={}) {
  const root=await mkdtemp(path.join(repositoryRoot,'.prnext-presentation-'));
  const write=async(name,source)=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);};
  const configure=async(extra='')=>write('prnext.config.mjs',`export default {experimental:{presentationComponents:${enabled}},navigationCache:{authCookies:['presentation_owner']},prerender:{workers:1},${webpack?'webpack(config){return config},':''}${reactCompiler?`reactCompiler:${JSON.stringify(reactCompiler)},`:''}${extra}};`);
  try {
    await configure();
    for(const [file,source] of Object.entries({
      'package.json':'{"type":"module"}',
      'tsconfig.json':'{"compilerOptions":{"jsx":"react-jsx"}}',
      'app/layout.jsx':`import Counter from './counter';export default function Layout({children}){return <html><body><Counter/>{children}</body></html>}`,
      'app/counter.jsx':`'use client';import{useState,useEffect}from'react';export default function Counter(){const[count,setCount]=useState(0);useEffect(()=>{performance.mark('presentation-hydrated')},[]);return <button data-testid="counter" onClick={()=>setCount(count+1)}>Count {count}</button>}`,
      'app/Table.jsx':presentationTable,
      'app/data.js':`import 'server-only';export function rows(count,owner='Public'){return Array.from({length:count},(_,i)=>({id:'row-'+i,name:'Product '+i+' < & $',price:10+i,available:i%3!==0,owner:{label:owner,secret:'${presentationSecrets[1]}'},secret:'${presentationSecrets[0]}'}))}`,
      'app/actions.js':`'use server';import{cookies}from'next/headers';import{revalidatePath}from'next/cache';export async function switchOwner(){(await cookies()).set('presentation_owner','Account B',{path:'/',httpOnly:true});revalidatePath('/')}`,
      'app/page.jsx':`import Link from'next/link';import{cookies}from'next/headers';import Table from'./Table';import{rows}from'./data';import{switchOwner}from'./actions';export const dynamic='force-dynamic';export default async function Page({searchParams}){const count=Number((await searchParams).rows||100);const owner=(await cookies()).get('presentation_owner')?.value||'Account A';return <main><h1>Presentation benchmark</h1><Table rows={rows(Math.min(2000,Math.max(1,count)),owner)} title="Products" unused="${presentationSecrets[2]}"/><Link href="/navigation" prefetch={false}>Next page</Link><form action={switchOwner}><button>Switch account</button></form></main>}`,
      'app/next/page.jsx':`import Link from'next/link';import Table from'../Table';import{rows}from'../data';export default()=> <main><Table rows={rows(12,'Next page owner')} title="Next products"/><Link href="/" prefetch={false}>Home page</Link></main>`,
      'app/navigation/page.jsx':`import{cookies}from'next/headers';import Link from'next/link';import Table from'../Table';import{rows}from'../data';export const dynamic='force-dynamic';export default async function Page(){await cookies();return <main><Table rows={rows(12,'Next page owner')} title="Next products"/><Link href="/" prefetch={false}>Home page</Link></main>}`,
      'app/client/Client.jsx':`'use client';import{useState}from'react';import Table from'../Table';export default function Client(){const[count,setCount]=useState(0);return <main><button onClick={()=>setCount(count+1)}>Client count {count}</button><Table title="Client-owned products" rows={[{id:'a',name:'Client product',price:1,owner:{label:'Client owner'},available:true},{id:'b',name:'Second client product',price:2,owner:{label:'Client owner'},available:false}]}/></main>}`,
      'app/client/page.jsx':`import Client from'./Client';export default()=> <Client/>`,
      'app/fallback/Value.jsx':`'use presentation';export default({value})=><p data-testid="fallback">{value}</p>`,
      'app/fallback/Unsupported.jsx':`'use presentation';import 'server-only';const privateValue='SERVER-IMPORT-IS-PRIVATE';export default()=> <p data-testid="unsupported">{privateValue?'Ordinary server component':'Missing'}</p>`,
      'app/fallback/page.jsx':`import Value from'./Value';import Unsupported from'./Unsupported';export default()=> <main><Value value={7n}/><Unsupported/></main>`,
      'app/stream/page.jsx':`import{Suspense}from'react';import Table from'../Table';import{rows}from'../data';export const dynamic='force-dynamic';async function Delayed(){await new Promise(resolve=>setTimeout(resolve,60));return <Table rows={rows(100)} title="Streamed products"/>}export default()=> <Suspense fallback={<p>Loading table</p>}><Delayed/></Suspense>`,
    })) await write(file,source);
    return {root,write,configure,build:(options={})=>build(root,options),remove:()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
  } catch(error) {await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});throw error;}
}
