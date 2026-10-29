import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {repositoryRoot,startServer} from '../support.mjs';

test.describe('Differential App navigation',()=>{
  let root,server;
  test.beforeAll(async()=>{
    root=await mkdtemp(path.join(repositoryRoot,'.prnext-flight-browser-'));
    const files={
      'package.json':'{"type":"module"}',
      'app/layout.jsx':`export default function Layout({children}){return <html><body><header>${'Shared layout content '.repeat(500)}</header>{children}</body></html>}`,
      'app/one/page.jsx':`import Link from 'next/link';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Page one</h1><Link href='/two' prefetch={false}>Two</Link></main>}`,
      'app/two/page.jsx':`import Link from 'next/link';export const dynamic='force-dynamic';export default function Page(){return <main><h1>Page two</h1><Link href='/one' prefetch={false}>One</Link></main>}`,
    };
    for(const[file,source]of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),source);}
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',root]);
    server=await startServer(root,['--workers','1']);
  });
  test.afterAll(async()=>{await server?.close();if(root)await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  test('streams differential bytes through React while preserving document and history',async({page})=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url+'/one');await page.evaluate(()=>window.__sameDocument=true);
    await page.getByRole('link',{name:'Two',exact:true}).click();await expect(page.getByRole('heading',{name:'Page two'})).toBeVisible();
    const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/one'&&response.headers()['content-type']==='application/x-prnext-flight-delta');
    await page.getByRole('link',{name:'One',exact:true}).click();await response;await expect(page.getByRole('heading',{name:'Page one'})).toBeVisible();
    expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);
    await page.goBack();await expect(page.getByRole('heading',{name:'Page two'})).toBeVisible();expect(errors).toEqual([]);
  });
  test('a corrupt delta retries one fresh GET and keeps the current document',async({page})=>{
    await page.goto(server.url+'/one');await page.evaluate(()=>window.__sameDocument=true);
    await page.getByRole('link',{name:'Two',exact:true}).click();await expect(page.getByRole('heading',{name:'Page two'})).toBeVisible();
    let corrupt=0,fresh=0;
    await page.route('**/one',async route=>{
      const headers=route.request().headers();
      if(headers['x-prnext-flight-base']&&!corrupt++)return route.fulfill({status:200,headers:{'content-type':'application/x-prnext-flight-delta','x-prnext-flight-base':headers['x-prnext-flight-base'],'x-prnext-deployment-id':headers['x-prnext-deployment-id']},body:'BAD!'});
      if(headers.rsc==='1'&&!headers['x-prnext-flight-accept'])fresh++;
      return route.continue();
    });
    await page.getByRole('link',{name:'One',exact:true}).click();await expect(page.getByRole('heading',{name:'Page one'})).toBeVisible();
    expect(corrupt).toBe(1);expect(fresh).toBe(1);expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);
  });
});
