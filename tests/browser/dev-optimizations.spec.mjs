import {test,expect}from'@playwright/test';
import {devFixture}from'../dev-fixture.mjs';
test.describe('development optimizations',()=>{
 test.setTimeout(90000);
 let fixture;
 test.beforeEach(async()=>{fixture=await devFixture({files:{'pages/api/pid.js':'export default function handler(req,res){res.json({pid:process.pid})}','pages/dormant.jsx':'export default()=> <h1>Unopened</h1>'}});});
 test.afterEach(async()=>{await fixture?.close();});
 test('repeated CSS changes keep server PID and React state, including fresh navigations',async({page,context})=>{
  await page.goto(fixture.url+'/docs/pages');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await page.getByTestId('counter').click();
  const pid=async()=> (await(await fetch(fixture.url+'/docs/api/pid')).json()).pid;
  const beforePid=await pid();await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
  const state=JSON.parse(await fixture.read('.prnext-dev.json'));
  for(const color of ['rgb(20, 40, 60)','rgb(30, 50, 70)','rgb(40, 60, 80)','rgb(50, 70, 90)']){
   await fixture.write('components/counter.module.css',`.counter{color:${color}}`);await expect(page.getByTestId('counter')).toHaveCSS('color',color,{timeout:20000});
   expect(await pid()).toBe(beforePid);const after=JSON.parse(await fixture.read('.prnext-dev.json'));expect(after.cssOnly).toBe(true);expect(after.compiler.health.builds).toBe(state.compiler.health.builds);
  }
  await expect(page.getByTestId('counter')).toHaveText('Original 1');
  const fresh=await context.newPage();await fresh.goto(fixture.url+'/docs/pages');await expect(fresh.getByTestId('counter')).toHaveCSS('color','rgb(50, 70, 90)');
 });
 test('class-map changes and exact reversions use coherent full updates',async({page})=>{
  await page.goto(fixture.url+'/docs/app');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await page.getByTestId('counter').click();
  for(const css of ['.base{font-weight:600}.counter{composes:base;color:rgb(98,76,54)}','.counter{color:rgb(12,34,56)}']){
   await fixture.write('components/counter.module.css',css);const expanded=css.includes('composes');
   await expect(page.getByTestId('counter')).toHaveCSS('color',expanded?'rgb(98, 76, 54)':'rgb(12, 34, 56)',{timeout:20000});
   await expect(page.getByTestId('counter')).toHaveCSS('font-weight',expanded?'600':'400');await expect(page.getByTestId('counter')).toHaveText('Original 1');
  }
 });
 test('CSS-only updates leave an unrelated route stylesheet URL and component state intact',async({page,context})=>{
  // Add this route before it is opened so it enters the real on-demand graph.
  await fixture.write('pages/independent.jsx',"import{useState}from'react';import styles from'../components/independent.module.css';export default()=>{const[n,setN]=useState(0);return <button data-testid='independent' className={styles.other} onClick={()=>setN(n+1)}>Independent {n}</button>}");
  await fixture.write('components/independent.module.css','.other{color:rgb(80,90,100)}');
  await page.goto(fixture.url+'/docs/pages');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
  const other=await context.newPage();await other.goto(fixture.url+'/docs/independent');await other.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
  await other.getByTestId('independent').click();await expect(other.getByTestId('independent')).toHaveText('Independent 1');
  const hrefs=()=>other.locator('link[rel="stylesheet"]').evaluateAll(links=>links.map(link=>link.href));
  const before=await hrefs();expect(before.length).toBeGreaterThan(0);
  await fixture.write('components/counter.module.css','.counter{color:rgb(21,43,65)}');
  await expect(page.getByTestId('counter')).toHaveCSS('color','rgb(21, 43, 65)',{timeout:20000});
  await expect(other.getByTestId('independent')).toHaveText('Independent 1');
  expect(await hrefs()).toEqual(before);await expect(other.getByTestId('independent')).toHaveCSS('color','rgb(80, 90, 100)');
 });
 test('unopened route edits do not build, and an unrelated tab does not refresh its model',async({page,context})=>{
  await page.goto(fixture.url+'/docs/pages');const other=await context.newPage();await other.goto(fixture.url+'/docs/app');
  for(const tab of [page,other])await tab.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
  const before=JSON.parse(await fixture.read('.prnext-dev.json'));
  await fixture.write('pages/dormant.jsx','export default()=> <h1>Edited unopened</h1>');await page.waitForTimeout(400);
  expect(JSON.parse(await fixture.read('.prnext-dev.json')).sequence).toBe(before.sequence);
  await fixture.write('pages/pages.jsx',(await fixture.read('pages/pages.jsx')).replace('page-server-one','page-server-two'));
  await expect(page.getByTestId('server')).toHaveText('page-server-two',{timeout:20000});
  await expect.poll(()=>other.evaluate(()=>window.__PRNEXT_DEV__?.lastRefresh?.skipped)).toBe(true);
  await expect(other.getByTestId('server')).toHaveText('app-server-one');
 });
 test('workbench and inspector code are fetched only when requested',async({page})=>{
  const fetched=[],pending=[];page.on('response',response=>{if(new URL(response.url()).pathname.endsWith('.js'))pending.push(response.text().then(source=>{if(/function createDev(?:Workbench|ToolsPanel)\d*\(/.test(source))fetched.push(source.includes('function createDevWorkbench'));}).catch(()=>{}));});
  await page.goto(fixture.url+'/docs/pages');await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await Promise.all(pending);expect(fetched).toEqual([]);
  await page.getByRole('button',{name:/Open PRNext developer tools/}).click();await Promise.all(pending);expect(fetched).toEqual([]);
  await page.getByRole('button',{name:'Client console',exact:true}).click();await expect(page.getByRole('dialog',{name:'Client console',exact:true})).toBeVisible();
  await Promise.all(pending);expect(fetched).toContain(true);
 });
});
