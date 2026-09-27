import {mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {appFixture,repositoryRoot} from './support.mjs';
export async function edgeActionsFixture(){
  const f=await appFixture();
  try{
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(f.root,name),{recursive:true,force:true});
    const files={
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/actions.js':`'use server';import{cookies}from'next/headers';export async function mutate(input){const value=input instanceof FormData?input.get('value'):input.value;(await cookies()).set('edge-action',value,{httpOnly:true});return {value,runtime:process.env.NEXT_RUNTIME,node:typeof Buffer}}`,
      'app/client.jsx':`'use client';import{useState}from'react';import{mutate}from'./actions';export default function Client(){const[value,set]=useState('initial');return <><button onClick={async()=>set(JSON.stringify(await mutate({value:'browser'})))}>Edge action</button><p id='result'>{value}</p></>}`,
      'app/node/page.jsx':`import Client from'../client';import{mutate}from'../actions';export const runtime='nodejs';export default function Page(){return <><h1>Node actions</h1><Client/><form id='direct' action={mutate}><input name='value' defaultValue='native-node'/><button>Submit</button></form></>}`,
      'app/page.jsx':`import{cookies}from'next/headers';import{mutate}from'./actions';import Client from'./client';export const runtime='edge';export default async function Page(){const value=(await cookies()).get('edge-action')?.value||'initial';const captured='encrypted-edge';async function inline(data){'use server';(await cookies()).set('inline-edge',captured+':'+data.get('value'))}return <><h1>Edge actions</h1><p id='cookie'>{value}</p><Client/><form id='direct' action={mutate}><input name='value' defaultValue='native'/><button>Submit</button></form><form id='inline' action={inline}><input name='value' defaultValue='bound'/><button>Inline</button></form></>}`,
    };
    for(const[name,source]of Object.entries(files)){const file=path.join(f.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)}
    return {...f,build:async()=>{await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',f.root]);return JSON.parse(await readFile(path.join(f.root,'.prnext/manifest.json'),'utf8'))}};
  }catch(error){await f.remove();throw error}
}
