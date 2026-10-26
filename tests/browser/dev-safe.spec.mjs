import{test,expect}from'@playwright/test';
import{readdir}from'node:fs/promises';
import path from'node:path';
import{devFixture,counterSource}from'../dev-fixture.mjs';
test('safe mode rebuilds all routes with fresh compilers, preserves state and explains changes',async({page})=>{
 test.setTimeout(90000);const fixture=await devFixture({args:['--safe'],files:{'pages/unopened.jsx':'export default()=> <h1>Unopened</h1>'}});
 try{
  await page.goto(fixture.url+'/docs/pages');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await page.getByTestId('counter').click();
  let state=JSON.parse(await fixture.read('.prnext-dev.json'));expect(state.safeMode).toBe(true);expect(state.routes).toContain('/unopened');expect(state.compiler.contexts).toBe(0);expect(state.compiler.health.reason).toBe('safe-mode');
  const files=await readdir(path.join(fixture.root,'.prnext-dev',state.session));expect(files.some(name=>name.startsWith('transport-'))).toBe(false);
  await fixture.write('components/Counter.jsx',counterSource('Safe'));await expect(page.getByTestId('counter')).toHaveText('Safe 1',{timeout:30000});
  await fixture.write('components/counter.module.css','.counter{color:rgb(20,40,60)}');await expect(page.getByTestId('counter')).toHaveCSS('color','rgb(20, 40, 60)',{timeout:30000});
  state=JSON.parse(await fixture.read('.prnext-dev.json'));expect(state.cssOnly).not.toBe(true);expect(state.reason.code).toBe('safe-mode');expect(state.transforms.diskHits).toBe(0);expect(state.compiler.health.builds).toBe(1);
  await expect(page.getByTestId('counter')).toHaveText('Safe 1');
 }finally{await fixture.close();}
});
test('anonymous default page components retain child state when another route compiles and source changes',async({page})=>{
 test.setTimeout(90000);const fixture=await devFixture({files:{'pages/pages.jsx':`import Counter from'../components/Counter';export const getServerSideProps=()=>({props:{}});export default()=> <Counter/>;`,'pages/api/ping.js':'export default(req,res)=>res.json({ok:true})'}});
 try{
  await page.goto(fixture.url+'/docs/pages');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');
  await page.evaluate(()=>window.__anonymousPageDocument=true);
  expect((await fetch(fixture.url+'/docs/api/ping')).status).toBe(200);await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await expect(page.getByTestId('counter')).toHaveText('Original 1');
  await fixture.write('components/Counter.jsx',counterSource('Anonymous'));await expect(page.getByTestId('counter')).toHaveText('Anonymous 1',{timeout:30000});expect(await page.evaluate(()=>window.__anonymousPageDocument)).toBe(true);
 }finally{await fixture.close();}
});

test('generated Server Action proxies preserve client state across new routes and edits',async({page})=>{
 test.setTimeout(90000);const fixture=await devFixture({files:{
  'app/app/actions.js':"'use server';export async function ping(value){return 'Action works '+value}",
  'app/app/client.jsx':"'use client';import{useState,useRef}from'react';import{ping}from'./actions';export default()=>{const[result,set]=useState('Run action'),sequence=useRef(0);return <form action={async()=>set(await ping(++sequence.current))}><button data-testid='action'>{result}</button></form>}",
  'app/app/page.jsx':"import Counter from'../../components/Counter';import Action from'./client';export const dynamic='force-dynamic';export default()=> <><Counter/><Action/></>",
  'pages/api/ping.js':'export default(req,res)=>res.json({ok:true})',
 }});
 try{
  await page.goto(fixture.url+'/docs/app');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');await page.evaluate(()=>window.__actionPageDocument=true);
  let calls=0;const runAction=async()=>{await page.getByTestId('action').click();await expect(page.getByTestId('action')).toHaveText('Action works '+(++calls));};
  await runAction();expect((await fetch(fixture.url+'/docs/api/ping')).status).toBe(200);await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await expect(page.getByTestId('counter')).toHaveText('Original 1');
  await fixture.write('components/Counter.jsx',counterSource('Actions'));await expect(page.getByTestId('counter')).toHaveText('Actions 1',{timeout:30000});await runAction();expect(await page.evaluate(()=>window.__actionPageDocument)).toBe(true);
 }finally{await fixture.close();}
});
