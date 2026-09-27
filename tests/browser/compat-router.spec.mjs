import {test,expect} from '@playwright/test';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appFixture,startServer,repositoryRoot} from '../support.mjs';

for(const webpack of [false,true])test(`compat router shares Pages state and returns null in App and Edge (${webpack?'webpack':'esbuild'})`,async({page})=>{
  const f=await appFixture();let server;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  try{
    for(const name of ['app','pages','components','proxy.ts'])await rm(path.join(f.root,name),{recursive:true,force:true});
    const files={
      'next.config.mjs':webpack?`export default {webpack(config,{webpack}){config.plugins.push(new webpack.DefinePlugin({FLAGS:{enabled:true}}));return config}}`:'export default {}',
      'components/shared.jsx':`'use client';import{useRouter}from'next/compat/router';import{useState,useContext}from'react';import{RouterContext}from'next/dist/shared/lib/router-context.shared-runtime';import{AppRouterContext}from'next/dist/shared/lib/app-router-context.shared-runtime';export default function Shared(){const router=useRouter();const privateRouter=useContext(RouterContext),appRouter=useContext(AppRouterContext);const[count,set]=useState(0);return <><p data-testid="internal-contexts">{String(privateRouter===router)+'|'+(appRouter?typeof appRouter.push:'pages')}</p><p data-testid="route">{router?.pathname||'no-pages-router'}</p><p data-testid="query">{router?.query.value||'-'}</p><button onClick={()=>set(count+1)}>Count {count}</button>{router&&<button onClick={()=>router.push('/legacy?value=next',undefined,{shallow:true})}>Navigate</button>}</>}`,
      'pages/legacy.jsx':`export{default}from'../components/shared'`,
      'app/layout.jsx':`export default({children})=><html><body>{children}</body></html>`,
      'app/page.jsx':`export{default}from'../components/shared'`,
      'app/edge/page.jsx':`export const runtime='edge';export{default}from'../../components/shared'`,
    };
    for(const[name,source]of Object.entries(files)){await mkdir(path.dirname(path.join(f.root,name)),{recursive:true});await writeFile(path.join(f.root,name),source);}
    await promisify(execFile)(process.execPath,[path.join(repositoryRoot,'packages/prnext/cli.mjs'),'build',f.root],{maxBuffer:4*1024*1024});
    server=await startServer(f.root);
    for(const route of ['/legacy','/','/edge']){
      const response=await fetch(server.url+route);expect(response.status).toBe(200);
      expect(await response.text()).toContain(route==='/legacy'?'/legacy':'no-pages-router');
      await page.goto(server.url+route);await expect(page.getByTestId('internal-contexts')).toHaveText(route==='/legacy'?'true|pages':'true|function');await expect(page.getByTestId('route')).toHaveText(route==='/legacy'?'/legacy':'no-pages-router');
      await page.getByRole('button',{name:'Count 0',exact:true}).click();await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
      if(route==='/legacy'){
        await page.getByRole('button',{name:'Navigate',exact:true}).click();await expect(page.getByTestId('query')).toHaveText('next');
        await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
      }
    }
    expect(errors).toEqual([]);
  }finally{await server?.close();await f.remove();}
});
