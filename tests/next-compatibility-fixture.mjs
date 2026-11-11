import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from '../packages/prnext/build/index.mjs';
import {repositoryRoot} from './support.mjs';
export async function nextCompatibilityFixture(){
  const root=await mkdtemp(path.join(repositoryRoot,'.prnext-next-compatibility-'));
  const write=async(name,source)=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source)};
  const remove=async()=>{assert.equal(path.dirname(root),path.resolve(repositoryRoot));assert.ok(path.basename(root).startsWith('.prnext-next-compatibility-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
  try{for(const[name,source]of Object.entries({
    'package.json':'{"type":"module"}',
    'prnext.config.mjs':`export default {prerender:{workers:1},compiler:{styledJsx:{useLightningcss:true},styledComponents:true,emotion:{autoLabel:'always'}},instrumentationClientInject:['./injected.js']};`,
    'injected.js':`window.__clientHooks=['injected'];export function onRouterTransitionStart(url,type){window.__transitions||=[];window.__transitions.push({source:'injected',url,type})}`,
    'instrumentation-client.ts':`(window as any).__clientHooks.push('application');export function onRouterTransitionStart(url:string,type:string){(window as any).__transitions.push({source:'application',url,type})}`,
    'app/actions.js':`'use server';import{cookies}from'next/headers';export async function save(previous,data){const value=String(data.get('value'));(await cookies()).set('compat-form',value);return 'saved '+value}export async function queued(){return true}`,
    'app/layout.jsx':`import Client from './Client';export default function Layout({children}){return <html><head/><body><Client/>{children}</body></html>}`,
    'app/Client.jsx':`'use client';import{useEffect,useState}from'react';import Form from'next/form';import Link,{useLinkStatus}from'next/link';import{useRouter,useServerInsertedHTML}from'next/navigation';import{useReportWebVitals}from'next/web-vitals';
      import styled,{ServerStyleSheet,StyleSheetManager}from'styled-components';import emotionStyled from'@emotion/styled';
      import{useServerInsertedHTML as usePrivateInsertion}from'next/dist/shared/lib/server-inserted-html.shared-runtime';
      import{useActionState}from'react';import{save,queued}from'./actions';
      function Queue(){return <button onClick={()=>Promise.all([queued(),queued()]).then(()=>window.__queuedFinished=true)}>Queue mutations</button>}
      function ServerForm(){const[state,action]=useActionState(save,'initial');return <Form id='server-form' action={action}><label>Server value<input name='value' defaultValue='native'/></label><button>Server submit</button><output data-testid='server-action-state'>{state}</output></Form>}
      const Styled=styled.div\`color:rgb(60,70,80);\`,Emotion=emotionStyled.div({color:'rgb(90,100,110)'});
      function Status(){const status=useLinkStatus();usePrivateInsertion(()=> <style data-private='yes'>{'.private-style{color:red}'}</style>);return <span data-testid='link-status'>{status.pending?'pending':'idle'}</span>}
      export default function Client(){const[n,set]=useState(0),[sheet]=useState(()=>new ServerStyleSheet()),router=useRouter();useReportWebVitals(metric=>{window.__vitals||=[];window.__vitals.push({name:metric.name,value:metric.value,id:metric.id})});useServerInsertedHTML(()=>{const styles=sheet.getStyleElement();sheet.instance.clearTag();return styles});useServerInsertedHTML(()=> <style data-inserted='yes'>{'.inserted-style{color:rgb(10, 20, 30)}'}</style>);useEffect(()=>{window.__hydrated=true;window.__clientHooks.push('hydrated')},[]);const content=<section><button onClick={()=>set(n+1)}>Ready {n}</button><p className='inserted-style'>Inserted CSS</p><ServerForm/><Queue/><Styled>Styled components CSS</Styled><Emotion>Emotion CSS</Emotion><Link href='/destination' prefetch={false}>Destination <Status/></Link><button onClick={()=>router.push('/other')}>Supersede</button><button onClick={()=>router.back()}>Go back</button><Form action='/search?discard=old'><label>Search<input name='q' required defaultValue='hello'/></label><input name='tag' value='one' readOnly/><input name='tag' value='two' readOnly/><button name='submit' value='yes'>Search now</button><button formAction='/other' name='alternate' value='yes'>Other submit</button></Form><Form action={async data=>{await new Promise(done=>setTimeout(done,10));set(Number(data.get('value')))}}><label>Client value<input name='value' defaultValue='9'/></label><button>Client action</button></Form><div className='scoped'><p>Scoped CSS</p><style jsx>{'.scoped p{color:rgb(30, 40, 50)}'}</style></div></section>;return typeof window==='undefined'?<StyleSheetManager sheet={sheet.instance}>{content}</StyleSheetManager>:content}`,
    'app/page.jsx':`export const dynamic='force-dynamic';export default function Page(){return <h1>Compatibility home</h1>}`,
    'app/destination/page.jsx':`export const dynamic='force-dynamic';export default async function Page(){await new Promise(done=>setTimeout(done,1000));return <h1>Destination arrived</h1>}`,
    'app/other/page.jsx':`export const dynamic='force-dynamic';export default function Page(){return <h1>Other arrived</h1>}`,
    'app/search/page.jsx':`export const dynamic='force-dynamic';export default async function Page({searchParams}){const q=await searchParams;return <h1>{JSON.stringify(q)}</h1>}`,
    'pages/legacy-form.jsx':`import Form from'next/form';import styled from'styled-components';const Box=styled.div\`color:rgb(150,160,170);\`;export default function Page(){return <><Form action='/legacy-result'><label>Legacy search<input name='q' defaultValue='legacy'/></label><button>Legacy submit</button></Form><Box>Pages styled components</Box><p>Pages styled JSX</p><style jsx>{'p{color:rgb(120,130,140)}'}</style></>}`,
    'pages/legacy-result.jsx':`export function getServerSideProps({query}){return{props:{q:query.q||''}}}export default function Page({q}){return <h1>Legacy {q}</h1>}`,
  }))await write(name,source);return{root,write,build:options=>build(root,options),remove};}catch(error){await remove();throw error}
}
