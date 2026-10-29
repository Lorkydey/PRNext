import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {routingFixture} from '../app-routing-fixture.mjs';
import {repositoryRoot,binary,freePort} from '../support.mjs';

test('lazy parallel routing compiles retained sources, preserves slot state and supports interception',async({page})=>{
  const fixture=await routingFixture(),port=await freePort();let child,output='';
  try{
    await writeFile(path.join(fixture.root,'prnext.config.mjs'),`export default{basePath:'/docs',assetPrefix:'/resources',onDemandEntries:{maxInactiveAge:0,pagesBufferLength:0}}`);
    child=spawn(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'dev',fixture.root,'--port',String(port)],{env:{...process.env,PRNEXT_BINARY:binary},stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',chunk=>output=(output+chunk).slice(-200000));child.stderr.on('data',chunk=>output=(output+chunk).slice(-200000));
    for(let n=0;n<200&&!output.includes('on-demand routes');n++){if(child.exitCode!==null)throw Error(output);await delay(25);}
    const url=`http://127.0.0.1:${port}`;
    page.on('pageerror',error=>output+='\nBROWSER '+error.message);
    page.on('requestfailed',request=>output+='\nFAILED '+new URL(request.url()).pathname+' '+request.failure()?.errorText);
    page.on('response',response=>output+='\nHTTP '+response.status()+' '+new URL(response.url()).pathname);
    await page.goto(url+'/docs/dashboard');await expect(page.getByRole('button',{name:'analytics count 0',exact:true})).toBeEnabled();
    const manifest=JSON.parse(await readFile(path.join(fixture.root,'.prnext/manifest.json'),'utf8'));
    expect(manifest.routes.some(route=>route.devDeferred)).toBe(true);
    await page.getByRole('button',{name:'analytics count 0',exact:true}).click();
    await page.getByRole('link',{name:'settings',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Team settings',exact:true})).toBeVisible({timeout:20000});
    await expect(page.getByRole('button',{name:'analytics count 1',exact:true})).toBeVisible();
    await page.goto(url+'/docs/album');await page.getByRole('link',{name:'album photo',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('Album modal two',{timeout:20000});await expect(page.getByRole('heading',{name:'Album background'})).toBeVisible();
  }finally{
    output+='\nSTATE '+await readFile(path.join(fixture.root,'.prnext-dev.json'),'utf8').catch(()=>'?');
    await test.info().attach('development-server',{body:output,contentType:'text/plain'});
    if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),6000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
    await fixture.remove();
  }
});
