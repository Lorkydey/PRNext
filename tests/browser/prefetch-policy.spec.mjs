import {test,expect} from '@playwright/test';
import {pagesNavigationFixture} from '../pages-navigation-fixture.mjs';
import {startServer} from '../support.mjs';

let fixture,server;
test.beforeAll(async()=>{
  fixture=await pagesNavigationFixture({withRouting:false});
  await fixture.write('pages/policy.jsx',`import Link from 'next/link';export default function Page(){return <main><h1>Prefetch policy</h1><Link href="/isr/policy-viewport" data-testid="viewport">Viewport</Link><Link href="/isr/policy-intent" data-testid="intent">Intent</Link><Link href="/isr/policy-disabled" prefetch={false} data-testid="disabled">Disabled</Link></main>}`);
  await fixture.build();server=await startServer(fixture.root);
});
test.afterAll(async()=>{await server?.close();await fixture?.remove();});

async function connection(page,{saveData=false,effectiveType='4g'}={}){
  await page.addInitScript(values=>{
    const state=new EventTarget();Object.assign(state,values);
    Object.defineProperty(navigator,'connection',{configurable:true,value:state});
  },{saveData,effectiveType});
}
async function ready(page){
  await page.goto(server.url+'/policy');
  await page.waitForFunction(()=>Boolean(window.__pagesRouter));
  await page.evaluate(()=>{window.__policyDocument=true;});
}
const count=key=>fixture.counts.get('static-'+key)||0;
// Give the real IntersectionObserver and input handlers time to deliver their
// requests. Negative assertions alone must not pass before hydration starts.
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,200)))));

test('data saver blocks viewport, intent and explicit speculation while a real click still navigates',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await connection(page,{saveData:true});await ready(page);
  await page.getByTestId('viewport').focus();
  await page.getByTestId('viewport').hover();
  await page.evaluate(()=>window.__pagesRouter.prefetch('/isr/policy-programmatic'));
  await settle(page);
  expect(count('policy-viewport')).toBe(0);
  expect(count('policy-intent')).toBe(0);
  expect(count('policy-programmatic')).toBe(0);
  await page.getByTestId('viewport').click();
  await expect(page.getByRole('heading',{name:'Static policy-viewport',exact:true})).toBeVisible();
  expect(count('policy-viewport')).toBe(1);
  expect(await page.evaluate(()=>window.__policyDocument)).toBe(true);
  expect(errors).toEqual([]);
});

test('3g skips viewport work, keyboard intent warms its route, and prefetch false remains inert',async({page})=>{
  await connection(page,{effectiveType:'3g'});await ready(page);await settle(page);
  expect(count('policy-intent')).toBe(0);
  await page.getByTestId('intent').focus();
  await expect.poll(()=>count('policy-intent')).toBe(1);
  await page.getByTestId('disabled').focus();
  await page.getByTestId('disabled').hover();await settle(page);
  expect(count('policy-disabled')).toBe(0);
  await page.getByTestId('intent').click();
  await expect(page.getByRole('heading',{name:'Static policy-intent',exact:true})).toBeVisible();
  expect(count('policy-intent')).toBe(1);
  expect(await page.evaluate(()=>window.__policyDocument)).toBe(true);
});
