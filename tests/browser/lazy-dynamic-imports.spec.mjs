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
    await writeFile(path.join(fixture.root,'app/lazy-client.tsx'),`'use client';import {useState} from 'react';import dynamic from 'next/dynamic';import {token,increment} from './lazy-shared';const Heavy=dynamic(()=>import('./lazy-heavy').then(module=>{window.__lazyNativeNamespace=Object.prototype.toString.call(module);return module}),{ssr:false});async function variants(){const[a,b,again]=await Promise.all([import('./lazy-variant.js?one'),import('./lazy-variant.js?two'),import('./lazy-variant.js?one')]);a.increment();window.__lazySuffixIdentity={distinct:a!==b,repeated:a===again,separateToken:a.token!==b.token,counts:[a.count,b.count]}}export default function Client(){const[show,setShow]=useState(false);const[n,setN]=useState(0);return <main><input aria-label="Draft"/><button onClick={variants}>Check query identities</button><button onClick={()=>setN(n+1)}>Parent count {n}</button><button onClick={()=>{increment();setShow(true)}}>Load editor</button>{show&&<Heavy expected={token}/>}</main>}`);
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
