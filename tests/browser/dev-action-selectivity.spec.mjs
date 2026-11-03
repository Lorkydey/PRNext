import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';

const client = (action, label) => `'use client';import{useActionState,useEffect,useState}from'react';import Link from'next/link';import{save}from'${action}';export default function Client(){const[result,submit,pending]=useActionState(save,'idle');const[count,setCount]=useState(0);const[ready,setReady]=useState(false);useEffect(()=>setReady(true),[]);return <><h1>${label}</h1><button data-testid="count" data-hydrated={ready} onClick={()=>setCount(count+1)}>Count {count}</button><form action={submit}><input aria-label="Value" name="value" defaultValue="kept"/><button disabled={pending}>Save ${label}</button><output data-testid="result">{result}</output></form><Link href="/a" prefetch={false}>Go A</Link></>}`;
const sharedAction = prefix => `'use server';import{value}from'../../shared-leaf.js';export async function save(previous,form){return ${JSON.stringify(prefix)}+value+':'+form.get('value')}`;

test('Action import closures update their routes, retain unrelated pending mutations, and synchronize a skipped tab before navigation',async({page,context},testInfo)=>{
  test.setTimeout(120000);
  const fixture=await devFixture({files:{
    'shared-leaf.js':`export const value='one'`,
    'app/shared/actions.js':sharedAction(''),
    'app/shared/Client.jsx':client('./actions.js','Shared'),
    'app/a/page.jsx':`import Client from'../shared/Client';export default function Page(){return <Client/>}`,
    'app/b/page.jsx':`import Client from'../shared/Client';export default function Page(){return <Client/>}`,
    'app/c/actions.js':`'use server';export async function save(previous,form){return 'independent:'+form.get('value')}`,
    'app/c/Client.jsx':client('./actions.js','Independent'),
    'app/c/page.jsx':`import Client from'./Client';export default function Page(){return <Client/>}`,
  }});
  let release,other,independent;
  const errors=[];
  try{
    other=await context.newPage();independent=await context.newPage();
    for(const [tab,route]of [[page,'a'],[other,'b'],[independent,'c']]){
      tab.on('pageerror',error=>errors.push(error.message));
      await tab.goto(fixture.url+'/docs/'+route);
      await expect(tab.getByTestId('count')).toHaveAttribute('data-hydrated','true');
      await tab.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
      await tab.getByTestId('count').click();await expect(tab.getByTestId('count')).toHaveText('Count 1');
      await tab.evaluate(()=>window.__selectivityDocument='same-document');
    }
    for(const tab of [page,other,independent])await tab.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true&&!window.__PRNEXT_DEV__?.applying);
    const oldManifest=await currentManifest(fixture);
    const independentIds=oldManifest.devActions.actions.filter(action=>action.file==='app/c/actions.js').map(action=>action.id);
    let posts=0,arrived=false;
    await independent.route('**/docs/c',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      posts++;const response=await route.fetch();await response.body();arrived=true;
      await new Promise(resolve=>{release=resolve;});await route.fulfill({response});
    });
    await independent.getByLabel('Value').fill('pending-preserved');await independent.getByRole('button',{name:'Save Independent',exact:true}).click();
    await expect.poll(()=>arrived).toBe(true);
    const initialSequence=oldManifest.devSequence;
    await fixture.write('shared-leaf.js',`export const value='two'`);
    await expect.poll(async()=>JSON.parse(await fixture.read('.prnext-dev.json')).sequence,{timeout:20000}).toBeGreaterThan(initialSequence);
    await expect.poll(()=>independent.evaluate(()=>window.__PRNEXT_DEV__?.lastRefresh?.skipped),{timeout:20000}).toBe(true);
    const intermediate=await currentManifest(fixture);
    expect(intermediate.devActions.actions.map(action=>action.id).sort()).toEqual(oldManifest.devActions.actions.map(action=>action.id).sort());
    const sequence=intermediate.devSequence;
    await fixture.write('app/shared/actions.js',sharedAction('edited:'));
    await expect.poll(async()=>JSON.parse(await fixture.read('.prnext-dev.json')).sequence,{timeout:20000}).toBeGreaterThan(sequence);
    const next=await currentManifest(fixture);
    await expect.poll(()=>independent.evaluate(()=>window.__PRNEXT_DEV__?.buildId),{timeout:20000}).toBe(next.buildId);
    expect(next.devActions.actions.filter(action=>action.file==='app/c/actions.js').map(action=>action.id)).toEqual(independentIds);
    expect(next.devActions.actions.filter(action=>action.file==='app/shared/actions.js').map(action=>action.id)).not.toEqual(oldManifest.devActions.actions.filter(action=>action.file==='app/shared/actions.js').map(action=>action.id));
    const state=JSON.parse(await fixture.read('.prnext-dev.json'));expect(state.affectedRoutes).toEqual(['/a','/b']);
    for(const tab of [page,other])await expect.poll(()=>tab.evaluate(()=>({buildId:window.__PRNEXT_DEV__?.buildId,skipped:!!window.__PRNEXT_DEV__?.lastRefresh?.skipped})),{timeout:20000}).toEqual({buildId:next.buildId,skipped:false});
    release();release=undefined;
    await expect(independent.getByTestId('result')).toHaveText('independent:pending-preserved');expect(posts).toBe(1);
    for(const tab of [page,other,independent]){
      await expect(tab.getByTestId('count')).toHaveText('Count 1');expect(await tab.evaluate(()=>window.__selectivityDocument)).toBe('same-document');
    }
    for(const tab of [page,other]){
      await tab.getByRole('button',{name:'Save Shared',exact:true}).click();await expect(tab.getByTestId('result')).toHaveText('edited:two:kept');
    }
    await independent.getByRole('link',{name:'Go A',exact:true}).click();
    await expect(independent).toHaveURL(fixture.url+'/docs/a');
    await independent.getByRole('button',{name:'Save Shared',exact:true}).click();await expect(independent.locator('[data-testid="result"]:visible')).toHaveText('edited:two:kept');
    expect(await independent.evaluate(()=>window.__selectivityDocument)).toBe('same-document');expect(errors).toEqual([]);
  }catch(error){await testInfo.attach('development-output',{body:fixture.output(),contentType:'text/plain'});throw error;}
  finally{release?.();await Promise.allSettled([other?.close(),independent?.close()]);await fixture.close();}
});

async function currentManifest(fixture){
  const state=JSON.parse(await fixture.read('.prnext-dev.json'));
  return JSON.parse(await fixture.read(`.prnext-dev/${state.session}/${state.buildId}/manifest.json`));
}
