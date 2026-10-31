import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {repositoryRoot,startServer} from '../support.mjs';

async function hydrated(page){await expect(page.locator('html')).toHaveAttribute('data-flight-hydrated','true');}
async function consumedFlight(page,response){
  const token=response.headers()['x-prnext-flight-token'];expect(token).toMatch(/^[a-f0-9]{48}$/);
  await page.waitForFunction(token=>window.__flightConsumed?.has(token),token);
}

test.describe('Differential App navigation',()=>{
  let root,server,counterAsset;
  test.beforeAll(async()=>{
    root=await mkdtemp(path.join(repositoryRoot,'.prnext-flight-browser-'));
    const files={
      'package.json':'{"type":"module"}',
      'components/Counter.jsx':`'use client';import {useState,useEffect} from 'react';export default function Counter(){const[n,set]=useState(0);useEffect(()=>{document.documentElement.dataset.flightHydrated='true'},[]);return <button onClick={()=>set(n+1)}>Count {n}</button>}`,
      'app/layout.jsx':`import Counter from '../components/Counter';export default function Layout({children}){return <html><body><Counter/><header>${'Shared layout content '.repeat(500)}</header>{children}</body></html>}`,
      'app/one/page.jsx':`import Link from 'next/link';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Page one</h1><Link href='/two' prefetch={false}>Two</Link></main>}`,
      'app/two/page.jsx':`import Link from 'next/link';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Page two</h1><Link href='/one' prefetch={false}>One</Link></main>}`,
      'app/heavy/page.jsx':`import Link from 'next/link';import {randomUUID} from 'node:crypto';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Heavy</h1><p>{randomUUID()}</p><table><tbody>{Array.from({length:1000},(_,n)=><tr key={n}><td>{n}</td><td>{'row '+n}</td><td>{n*7}</td></tr>)}</tbody></table><Link href='/small' prefetch={false}>Small</Link></main>}`,
      'app/small/page.jsx':`import Link from 'next/link';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Small</h1><Link href='/heavy' prefetch={false}>Heavy</Link></main>}`,
    };
    for(const[file,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);}
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root]);
    const manifest=JSON.parse(await readFile(path.join(root,'.prnext/manifest.json'),'utf8'));
    for(const module of Object.values(manifest.app.clientModules)){
      if((await readFile(path.join(root,'.prnext/assets',path.basename(module.browserModule)),'utf8')).includes('flightHydrated')){
        expect(counterAsset).toBeUndefined();counterAsset=module.browserModule;
      }
    }
    expect(counterAsset).toBeTruthy();
    server=await startServer(root,['--workers','1']);
  });
  test.beforeEach(async({page})=>{
    await page.addInitScript(()=>{
      window.__flightConsumed=new Set();
      const original=window.fetch;
      window.fetch=async(...args)=>{
        const response=await original(...args),token=response.headers.get('x-prnext-flight-token');
        if(!response.body||!token)return response;
        const pathname=new URL(response.url).pathname,read=response.body.getReader.bind(response.body);
        response.body.getReader=(...options)=>{
          const reader=read(...options),next=reader.read.bind(reader);
          reader.read=async(...values)=>{
            const value=await next(...values);
            if(value.done){
              if(window.__flightHoldPath===pathname){window.__flightEofHeld=true;await new Promise(resolve=>{window.__releaseFlightEof=resolve;});}
              // Publish after the consuming transport's EOF microtask, which
              // retains the base. Network completion or a visible React tree
              // alone does not establish that this stream was consumed.
              const {port1,port2}=new MessageChannel();
              port1.onmessage=()=>{window.__flightConsumed.add(token);port1.close();port2.close();};
              port2.postMessage(null);
            }
            return value;
          };
          return reader;
        };
        return response;
      };
    });
  });
  test.afterAll(async()=>{await server?.close();if(root){expect(path.dirname(path.resolve(root))).toBe(path.resolve(repositoryRoot));expect(path.basename(root).startsWith('.prnext-flight-browser-')).toBe(true);await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}});
  test('streams differential bytes through React while preserving document and history',async({page})=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url+'/one');await hydrated(page);await page.evaluate(()=>window.__sameDocument=true);
    const first=page.waitForResponse(response=>new URL(response.url()).pathname==='/two'&&response.request().headers().rsc==='1');
    await page.getByRole('link',{name:'Two',exact:true}).click();await expect(page.getByRole('heading',{name:'Page two'})).toBeVisible();await consumedFlight(page,await first);
    const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/one'&&response.headers()['content-type']==='application/x-prnext-flight-delta');
    await page.getByRole('link',{name:'One',exact:true}).click();await response;await expect(page.getByRole('heading',{name:'Page one'})).toBeVisible();
    expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);
    await page.goBack();await expect(page.getByRole('heading',{name:'Page two'})).toBeVisible();expect(errors).toEqual([]);
  });
  test('a corrupt delta retries one fresh GET and keeps the current document',async({page})=>{
    let releaseAsset;
    const assetGate=new Promise(resolve=>{releaseAsset=resolve;});
    const heldAsset=page.waitForRequest(server.url+counterAsset,{timeout:15000});void heldAsset.catch(()=>{});
    await page.route(server.url+counterAsset,async route=>{await assetGate;await route.continue();});
    try{
    const visit=page.goto(server.url+'/one');void visit.catch(()=>{});
    await heldAsset;await visit;
    await expect(page.getByRole('heading',{name:'Page one'})).toBeVisible();
    expect(await page.locator('html').getAttribute('data-flight-hydrated')).toBeNull();
    releaseAsset();await hydrated(page);await page.evaluate(()=>{window.__sameDocument=true;window.__flightHoldPath='/two';});
    const first=page.waitForResponse(response=>new URL(response.url()).pathname==='/two'&&response.request().headers().rsc==='1');
    await page.getByRole('link',{name:'Two',exact:true}).click();await expect(page.getByRole('heading',{name:'Page two'})).toBeVisible();
    const flight=await first;
    await page.waitForFunction(()=>window.__flightEofHeld===true);
    expect(await page.evaluate(token=>window.__flightConsumed.has(token),flight.headers()['x-prnext-flight-token'])).toBe(false);
    await page.evaluate(()=>window.__releaseFlightEof());await consumedFlight(page,flight);
    let corrupt=0,fresh=0;
    await page.route('**/one',async route=>{
      const headers=route.request().headers();
      if(headers['x-prnext-flight-base']){corrupt++;if(corrupt===1)return route.fulfill({status:200,headers:{'content-type':'application/x-prnext-flight-delta','x-prnext-flight-base':headers['x-prnext-flight-base'],'x-prnext-deployment-id':headers['x-prnext-deployment-id']},body:'BAD!'});}
      if(headers.rsc==='1'&&!headers['x-prnext-flight-accept'])fresh++;
      return route.continue();
    });
    await page.getByRole('link',{name:'One',exact:true}).click();await expect(page.getByRole('heading',{name:'Page one'})).toBeVisible();
    expect(corrupt).toBe(1);expect(fresh).toBe(1);expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);
    }finally{releaseAsset();await page.evaluate(()=>window.__releaseFlightEof?.()).catch(()=>{});}
  });
  test('large-small-large navigation and cold bootstrap retain every visible cell and client state',async({page})=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url+'/heavy');await hydrated(page);await page.getByRole('button',{name:'Count 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
    const expected=Array.from({length:1000},(_,n)=>[String(n),'row '+n,String(n*7)]).flat();
    expect(await page.locator('table:visible td').allTextContents()).toEqual(expected);
    await page.evaluate(()=>window.__sameDocument=true);
    for(let n=0;n<3;n++){
      await page.getByRole('link',{name:'Small',exact:true}).click();await expect(page.getByRole('heading',{name:'Small',exact:true})).toBeVisible();
      await page.getByRole('link',{name:'Heavy',exact:true}).click();await expect(page.getByRole('heading',{name:'Heavy',exact:true})).toBeVisible();
      expect(await page.locator('table:visible td').allTextContents()).toEqual(expected);
      await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
});
