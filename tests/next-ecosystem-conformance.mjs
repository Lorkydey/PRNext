import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {ecosystemFixture,ecosystemDirectory} from './ecosystem-fixture.mjs';
import {buildNextReference,nextServer} from './next-reference-support.mjs';
import {startServer,repositoryRoot} from './support.mjs';

test('real Better Auth, SQLite/Drizzle, next-intl, MDX and Server Component after agree with Next',{timeout:360000},async()=>{
  const fixture=await ecosystemFixture();let browser,server;
  try{
    const nextCli=path.join(ecosystemDirectory,'node_modules/next/dist/bin/next');
    await buildNextReference(nextCli,fixture.root);
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',fixture.root],{cwd:fixture.root,maxBuffer:8*1024*1024});
    browser=await chromium.launch();const results=[];
    for(const engine of ['next','prnext']){
      server=engine==='next'?await nextServer(nextCli,fixture.root):await startServer(fixture.root,['--workers','1']);
      const context=await browser.newContext();const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(['error','warning'].includes(message.type())&&/hydration|hydrated|did not match|didn't match/i.test(message.text()))errors.push(message.text());});
      const email=engine+'@example.test';
      const signup=await context.request.post(server.url+'/api/auth/sign-up/email',{headers:{origin:server.url},data:{name:'Fixture user',email,password:'fixture-only-password-123'}});
      assert.equal(signup.status(),200,await signup.text());
      await context.addCookies([{name:'locale',value:'fr',url:server.url}]);
      await page.goto(server.url);await page.getByRole('heading',{name:'Bonjour PRNext'}).waitFor();
      assert.equal(await page.getByTestId('session').textContent(),email);
      await page.getByRole('button',{name:'Clics : 0',exact:true}).click();await page.getByRole('button',{name:'Clics : 1',exact:true}).waitFor();
      await page.getByRole('button',{name:'Save note',exact:true}).click();await page.getByTestId('saved').filter({hasText:'persisted through Drizzle'}).waitFor();
      await page.evaluate(()=>{window.__ecosystemDocument='same'});await page.getByRole('link',{name:'Notes',exact:true}).click();await page.getByText('persisted through Drizzle',{exact:true}).first().waitFor();assert.equal(await page.getByText('persisted through Drizzle',{exact:true}).count(),1);assert.equal(await page.evaluate(()=>window.__ecosystemDocument),'same');
      await page.goto(server.url+'/guide');assert.equal(await page.getByTestId('mdx-value').textContent(),'42');
      await rm(path.join(fixture.root,'after.jsonl'),{force:true});
      await context.addCookies([{name:'visitor',value:engine,url:server.url}]);await page.goto(server.url+'/after');await page.getByRole('heading',{name:'After response '+engine}).waitFor();
      let record;for(let i=0;i<100;i++){try{record=JSON.parse((await readFile(path.join(fixture.root,'after.jsonl'),'utf8')).trim().split('\n')[0]);break;}catch{await delay(20);}}
      assert.deepEqual(record,{visitor:engine,blocked:true});
      const logout=await context.request.post(server.url+'/api/auth/sign-out',{headers:{origin:server.url},data:{}});assert.equal(logout.status(),200);
      await page.goto(server.url);assert.equal(await page.getByTestId('session').textContent(),'anonymous');assert.deepEqual(errors,[]);
      const isolated=await browser.newContext();const isolatedPage=await isolated.newPage();await isolatedPage.goto(server.url);await isolatedPage.getByRole('heading',{name:'Hello PRNext'}).waitFor();await isolated.close();
      results.push({session:true,action:true,sqlite:true,translations:true,isolatedLocale:true,mdx:'42',afterRestricted:record.blocked,logout:true});
      await context.close();await server.close();server=undefined;
    }
    assert.deepEqual(results[1],results[0]);
  }finally{await server?.close();await browser?.close();await fixture.remove();}
});
