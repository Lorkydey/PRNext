import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {appFixture,freePort,repositoryRoot} from '../support.mjs';

test('deferred client compilation preserves shared ESM bindings, form state, CSS and Fast Refresh',async({page})=>{
  test.setTimeout(90000);
  const fixture=await appFixture(),port=await freePort(),url=`http://127.0.0.1:${port}`;
  let child,output='';
  const heavy=label=>`import {useState} from 'react';import {token,count} from './lazy-shared';import './lazy-heavy.css';export default function Heavy({expected}){const[n,setN]=useState(0);return <section className="lazy-heavy" data-testid="lazy-heavy" data-same={expected===token}><span>${label}:{count}</span><button onClick={()=>setN(n+1)}>Heavy count {n}</button></section>}`;
  try{
    await writeFile(path.join(fixture.root,'prnext.config.mjs'),'export default {experimental:{lazyDynamicImports:true}}');
    await writeFile(path.join(fixture.root,'app/layout.tsx'),'export default function RootLayout({children,modal}){return <html><body>{children}{modal}</body></html>}');
    await mkdir(path.join(fixture.root,'app/@modal'),{recursive:true});
    await writeFile(path.join(fixture.root,'app/@modal/default.tsx'),'export default function Modal(){return null}');
    await writeFile(path.join(fixture.root,'app/page.tsx'),"import Client from './lazy-client';export default function Page(){return <Client/>}");
    await writeFile(path.join(fixture.root,'app/lazy-shared.ts'),"export const token={};export let count=0;export function increment(){count++}");
    await writeFile(path.join(fixture.root,'app/lazy-variant.js'),"export const token={};export let count=0;export function increment(){count++}");
    await writeFile(path.join(fixture.root,'app/lazy-data.json'),'{"value":{"shared":"JSON_BROWSER_IDENTITY"}}');
    await writeFile(path.join(fixture.root,'app/lazy-json-loader.ts'),"export const loadJSONAgain=()=>import('./lazy-data.json');");
    await writeFile(path.join(fixture.root,'app/lazy-client.tsx'),`'use client';import {useState} from 'react';import dynamic from 'next/dynamic';import {token,increment} from './lazy-shared';import jsonDefault from './lazy-data.json';import {loadJSONAgain} from './lazy-json-loader';const Heavy=dynamic(()=>import('./lazy-heavy').then(module=>{window.__lazyNativeNamespace=Object.prototype.toString.call(module);return module}),{ssr:false});async function variants(){const[a,b,again]=await Promise.all([import('./lazy-variant.js?one'),import('./lazy-variant.js?two'),import('./lazy-variant.js?one')]);a.increment();window.__lazySuffixIdentity={distinct:a!==b,repeated:a===again,separateToken:a.token!==b.token,counts:[a.count,b.count]}}async function jsonIdentities(){const[a,b,again]=await Promise.all([import('./lazy-data.json'),loadJSONAgain(),import('./lazy-data.json')]);a.default.value.probe='updated';window.__lazyJSONIdentity={same:a===b,repeated:a===again,defaultSame:a.default===b.default,staticSame:jsonDefault===a.default,mutation:b.default.value.probe,native:Object.prototype.toString.call(a)}}export default function Client(){const[show,setShow]=useState(false);const[n,setN]=useState(0);return <main><input aria-label="Draft"/><button onClick={variants}>Check query identities</button><button onClick={jsonIdentities}>Check JSON identities</button><button onClick={()=>setN(n+1)}>Parent count {n}</button><button onClick={()=>{increment();setShow(true)}}>Load editor</button>{show&&<Heavy expected={token}/>}</main>}`);
    await writeFile(path.join(fixture.root,'app/lazy-heavy.tsx'),heavy('LAZY_BROWSER_INITIAL'));
    await writeFile(path.join(fixture.root,'app/lazy-heavy.css'),'.lazy-heavy{color:rgb(12,34,56)}');
    child=spawn(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'dev',fixture.root,'--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NODE_ENV:'development'},stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',data=>{output=(output+data).slice(-48000);});child.stderr.on('data',data=>{output=(output+data).slice(-48000);});
    for(let i=0;;i++){
      if(child.exitCode!==null)throw Error('Development server exited');
      try{await fetch(url+'/robots.txt');break;}catch{}
      if(i>240)throw Error('Development server did not start');await delay(50);
    }
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>Object.keys(button).some(key=>key.startsWith('__reactProps$'))));
    const manifest=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    const assets=path.join(fixture.root,'.prnext/assets');
    const script=(await Promise.all((await readdir(assets)).filter(file=>file.endsWith('.js')).map(file=>readFile(path.join(assets,file),'utf8')))).join('\n');
    expect(script).not.toContain('LAZY_BROWSER_INITIAL');
    expect(manifest.devLazy.modules.some(item=>item.request==='./lazy-heavy')).toBe(true);
    expect(manifest.devLazy.modules.some(item=>/[?#]/.test(item.request))).toBe(false);
    await page.getByRole('button',{name:'Check query identities',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.__lazySuffixIdentity)).toEqual({distinct:true,repeated:true,separateToken:true,counts:[1,0]});
    await page.getByRole('button',{name:'Check JSON identities',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.__lazyJSONIdentity)).toEqual({same:true,repeated:true,defaultSame:true,staticSame:true,mutation:'updated',native:'[object Module]'});
    await page.getByLabel('Draft',{exact:true}).fill('Keep this draft');
    await page.getByRole('button',{name:'Parent count 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Parent count 1',exact:true})).toBeVisible();
    await page.evaluate(()=>{window.__lazyNoReload=true;});
    const firstUse=performance.now();
    const [compiled]=await Promise.all([
      page.waitForResponse(response=>response.url().includes('/_prnext/ensure?path=')&&new URL(response.url()).searchParams.get('path')?.startsWith('/_prnext/lazy/'),{timeout:30000}),
      page.getByRole('button',{name:'Load editor',exact:true}).click(),
    ]);
    expect(compiled.status(),await compiled.text()).toBe(200);
    const descriptor=await compiled.json();expect(descriptor.lazy.native).toBe(true);
    const firstUseReport=test.info().outputPath('lazy-first-use.json');
    await mkdir(path.dirname(firstUseReport),{recursive:true});
    await writeFile(firstUseReport,JSON.stringify({compilationAndRequestMs:performance.now()-firstUse,status:compiled.status(),native:descriptor.lazy.native})+'\n');
    await test.info().attach('lazy-first-use.json',{path:firstUseReport,contentType:'application/json'});
    const editor=page.getByTestId('lazy-heavy');
    await expect(editor).toContainText('LAZY_BROWSER_INITIAL:1');
    await expect(editor).toHaveAttribute('data-same','true');
    expect(await page.evaluate(()=>window.__lazyNativeNamespace)).toBe('[object Module]');
    await expect(editor).toHaveCSS('color','rgb(12, 34, 56)');
    await page.getByRole('button',{name:'Heavy count 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Heavy count 1',exact:true})).toBeVisible();
    await writeFile(path.join(fixture.root,'app/lazy-heavy.tsx'),heavy('LAZY_BROWSER_UPDATED'));
    await expect(editor).toContainText('LAZY_BROWSER_UPDATED',{timeout:30000});
    await expect(page.getByRole('button',{name:'Heavy count 1',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Parent count 1',exact:true})).toBeVisible();
    await expect(page.getByLabel('Draft',{exact:true})).toHaveValue('Keep this draft');
    await writeFile(path.join(fixture.root,'app/lazy-heavy.css'),'.lazy-heavy{color:rgb(65,43,21)}');
    await expect(editor).toHaveCSS('color','rgb(65, 43, 21)',{timeout:30000});
    await expect(page.getByRole('button',{name:'Heavy count 1',exact:true})).toBeVisible();
    await expect(page.getByLabel('Draft',{exact:true})).toHaveValue('Keep this draft');
    expect(await page.evaluate(()=>window.__lazyNoReload)).toBe(true);
    expect(errors).toEqual([]);
  }catch(error){error.message+='\nDevelopment output:\n'+output;throw error;}
  finally{
    if(child&&child.exitCode===null&&!child.signalCode)await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),7000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
    await fixture.remove();
  }
});

test('a deferred client form invokes an existing static Server Action without losing its document or drafts',async({page,context})=>{
  test.setTimeout(60000);
  const {createHash}=await import('node:crypto');
  const {rm}=await import('node:fs/promises');
  const privateValue='LAZY_ACTION_PRIVATE_ENV_CANARY',serverSource='LAZY_ACTION_SERVER_IMPLEMENTATION_ONLY';
  const digest=createHash('sha256').update(privateValue).digest('hex');
  const fixture=await appFixture(),port=await freePort(),url=`http://127.0.0.1:${port}`;
  let child,output='';
  const files={
    'prnext.config.mjs':"export default {experimental:{lazyDynamicImports:true}}",
    'app/layout.jsx':'export default function Layout({children}){return <html><body>{children}</body></html>}',
    'app/app/page.jsx':`import {cookies} from 'next/headers';import Client from './client';export default async function Page(){return <><p data-testid="server-saves">{(await cookies()).get('lazy-action-saves')?.value||'0'}</p><Client/></>}`,
    'app/app/actions.js':`'use server';import {createHash} from 'node:crypto';import {cookies} from 'next/headers';export async function saveDraft(previous,form){if(createHash('sha256').update(process.env.PRNEXT_LAZY_ACTION_PRIVATE||'').digest('hex')!==${JSON.stringify(digest)})throw new Error(${JSON.stringify(serverSource)});const store=await cookies(),count=Number(store.get('lazy-action-saves')?.value||0)+1;store.set('lazy-action-saves',String(count),{httpOnly:true,sameSite:'lax'});return {message:'Saved '+String(form.get('draft'))+' #'+count}}`,
    'app/app/client.jsx':`'use client';import {useEffect,useState} from 'react';import dynamic from 'next/dynamic';import {saveDraft} from './actions';const Deferred=dynamic(()=>import('./deferred-form'),{ssr:false});export default function Client(){const[show,setShow]=useState(false),[count,setCount]=useState(0);useEffect(()=>{window.__staticActionReady=typeof saveDraft==='function'},[]);return <main><label>Parent draft<input/></label><button onClick={()=>setCount(count+1)}>Parent count {count}</button><button onClick={()=>setShow(true)}>Load action form</button>{show&&<Deferred/>}</main>}`,
    'app/app/deferred-form.jsx':`'use client';import {useActionState,useEffect,useState} from 'react';import {saveDraft} from './actions';export default function DeferredForm(){const[state,action,pending]=useActionState(saveDraft,{message:'Not saved'}),[draft,setDraft]=useState('');useEffect(()=>{window.__lazyActionFormReady=true},[]);return <section data-testid="deferred-action-form"><p>LAZY_ACTION_DEFERRED_BROWSER</p><form action={action}><label>Deferred value<input name="draft" value={draft} onChange={event=>setDraft(event.target.value)}/></label><button type="submit" disabled={pending}>Save deferred draft</button></form><p data-testid="deferred-action-result">{state.message}</p></section>}`,
  };
  const errors=[],posts=[],statuses=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&request.headers()['next-action'])posts.push(request.headers()['next-action']);});
  page.on('response',response=>{if(response.request().method()==='POST'&&response.request().headers()['next-action'])statuses.push(response.status());});
  const browserScripts=async manifest=>{
    const directory=path.join(fixture.root,'.prnext-dev',manifest.devSession,manifest.buildId,'assets');
    return (await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.js')).map(name=>readFile(path.join(directory,name),'utf8')))).join('\n');
  };
  try{
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(fixture.root,name),{recursive:true,force:true});
    for(const [name,source]of Object.entries(files)){
      const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);
    }
    child=spawn(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'dev',fixture.root,'--hostname','127.0.0.1','--port',String(port)],{
      env:{...process.env,NODE_ENV:'development',PRNEXT_LAZY_ACTION_PRIVATE:privateValue},stdio:['ignore','pipe','pipe'],windowsHide:true});
    let launchError;child.on('error',error=>{launchError=error;});
    child.stdout.on('data',data=>{output=(output+data).slice(-24000);});child.stderr.on('data',data=>{output=(output+data).slice(-24000);});
    for(let attempt=0;;attempt++){
      if(launchError)throw launchError;
      if(child.exitCode!==null)throw Error('Development server exited');
      try{await fetch(url+'/robots.txt');break;}catch{}
      if(attempt>240)throw Error('Development server did not start');await delay(50);
    }
    await page.goto(url+'/app');
    await page.waitForFunction(()=>window.__staticActionReady===true);
    const before=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    const staticActions=Object.keys(before.app.actions);
    expect(staticActions).toHaveLength(1);
    expect(before.devLazy.modules.some(item=>item.request==='./deferred-form')).toBe(true);
    const initialScripts=await browserScripts(before);
    expect(initialScripts.includes('LAZY_ACTION_DEFERRED_BROWSER')).toBe(false);
    await page.getByLabel('Parent draft',{exact:true}).fill('Keep parent draft');
    await page.getByRole('button',{name:'Parent count 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Parent count 1',exact:true})).toBeVisible();
    await page.evaluate(()=>{window.__lazyActionDocument=true;});
    const [activation]=await Promise.all([
      page.waitForResponse(response=>response.url().includes('/_prnext/ensure?path=')&&new URL(response.url()).searchParams.get('path')?.startsWith('/_prnext/lazy/'),{timeout:30000}),
      page.getByRole('button',{name:'Load action form',exact:true}).click(),
    ]);
    expect(activation.status()).toBe(200);
    expect((await activation.json()).lazy.native).toBe(true);
    await page.waitForFunction(()=>window.__lazyActionFormReady===true);
    const after=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    expect(after.cacheId).toBe(before.cacheId);
    expect(after.devSession).toBe(before.devSession);
    expect(after.buildId).toBe(before.buildId);
    expect(after.app.actions).toEqual(before.app.actions);
    const activatedScripts=await browserScripts(after);
    expect(activatedScripts.includes('LAZY_ACTION_DEFERRED_BROWSER')).toBe(true);
    await page.getByLabel('Deferred value',{exact:true}).fill('Keep submitted draft');
    await page.getByRole('button',{name:'Save deferred draft',exact:true}).click();
    await expect(page.getByTestId('deferred-action-result')).toHaveText('Saved Keep submitted draft #1');
    await expect(page.getByTestId('server-saves')).toHaveText('1');
    expect(posts).toEqual(staticActions);
    expect(statuses).toEqual([200]);
    await expect(page.getByRole('button',{name:'Parent count 1',exact:true})).toBeVisible();
    await expect(page.getByLabel('Parent draft',{exact:true})).toHaveValue('Keep parent draft');
    await expect(page.getByLabel('Deferred value',{exact:true})).toHaveValue('Keep submitted draft');
    expect(await page.evaluate(()=>window.__lazyActionDocument)).toBe(true);
    const cookie=(await context.cookies(url)).find(item=>item.name==='lazy-action-saves');
    expect(cookie?.value).toBe('1');expect(cookie?.httpOnly).toBe(true);
    const latest=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    const scripts=[initialScripts,activatedScripts,await browserScripts(latest)].join('\n');
    expect({loaded:scripts.includes('LAZY_ACTION_DEFERRED_BROWSER'),privateValue:scripts.includes(privateValue),
      serverSource:scripts.includes(serverSource),nodeImport:scripts.includes('node:crypto'),
      privateEnv:scripts.includes('PRNEXT_LAZY_ACTION_PRIVATE'),actionKey:scripts.includes(before.app.actionKey)})
      .toEqual({loaded:true,privateValue:false,serverSource:false,nodeImport:false,privateEnv:false,actionKey:false});
    expect(errors).toEqual([]);
  }catch(error){error.message+='\nDevelopment output:\n'+output;throw error;}
  finally{
    if(child&&child.exitCode===null&&!child.signalCode)await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),7000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
    await fixture.remove();
  }
});
