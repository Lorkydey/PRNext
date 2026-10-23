import {test,expect} from '@playwright/test';
import {devFixture,counterSource} from '../dev-fixture.mjs';

test.describe('On-demand development platform',()=>{
  test.setTimeout(100_000);let fixture;
  test.afterEach(async()=>{await fixture?.close();});
  for(const router of ['pages','app'])test(`${router} compiles a cold link only on navigation and keeps the document`,async({page})=>{
    const initial=router==='pages'?'pages/pages.jsx':'app/app/page.jsx';
    const destination=router==='pages'?'pages/destination.jsx':'app/destination/page.jsx';
    fixture=await devFixture({files:{
      [initial]:`import Link from 'next/link';import Counter from '${router==='pages'?'../components/Counter':'../../components/Counter'}';export default function Page(){return <><Counter/><Link href="/destination">Open destination</Link></>}`,
      [destination]:`export default function Destination(){return <h1>Cold destination</h1>}`,
    }});
    const errors=[],documents=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
    await page.goto(fixture.url+'/docs/'+router);await page.getByTestId('counter').click();
    await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await page.evaluate(()=>{window.__sameDocument=true;});
    await page.getByRole('link',{name:'Open destination'}).hover();
    expect(JSON.parse(await fixture.read('.prnext/manifest.json')).routes.some(route=>route.pattern==='/destination')).toBe(false);
    // Force readiness to arrive through SSE before the ensure HTTP response.
    await page.route(/\/_prnext\/ensure\?/,async route=>{
      const response=await route.fetch(),update=await response.json();
      await page.waitForFunction(buildId=>globalThis.__PRNEXT_DEV__?.buildId===buildId,update.buildId,{timeout:10000});
      await route.fulfill({response});
    });
    await page.getByRole('link',{name:'Open destination'}).click();
    await expect(page.getByRole('heading',{name:'Cold destination'})).toBeVisible({timeout:25000});
    expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);expect(documents).toHaveLength(1);expect(errors).toEqual([]);
  });
  test('open tabs stay pinned during inactive-route eviction and share one permanent SSE listener',async({context})=>{
    const files={};for(let i=0;i<4;i++)files[`pages/tab${i}.jsx`]=`import Counter from '../components/Counter';export default function Page(){return <><h1>Tab ${i}</h1><Counter/></>}`;
    fixture=await devFixture({config:`export default{basePath:'/docs',onDemandEntries:{pagesBufferLength:0,maxInactiveAge:0}}`,files});
    await context.addInitScript(()=>{const Original=window.EventSource;window.__eventOpens=0;window.EventSource=class extends Original{constructor(...args){super(...args);this.addEventListener('open',()=>window.__eventOpens++);}};});
    const tabs=[];for(let i=0;i<3;i++){const page=await context.newPage();tabs.push(page);await page.goto(fixture.url+'/docs/tab'+i);await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');await expect.poll(()=>page.evaluate(()=>window.__eventOpens)).toBe(1);}
    const before=JSON.parse(await fixture.read('.prnext-dev.json'));
    await fixture.write('components/Counter.jsx',counterSource('All updated'));
    for(const page of tabs){await expect(page.getByTestId('counter')).toHaveText('All updated 1',{timeout:25000});expect(await page.evaluate(()=>window.__eventOpens)).toBe(1);}
    const after=JSON.parse(await fixture.read('.prnext-dev.json'));expect(after.listenerPid).toBe(before.listenerPid);
    for(let i=0;i<3;i++)expect(after.routes).toContain('/tab'+i);
    await tabs[2].close();await tabs[1].close();
    const last=await context.newPage();await last.goto(fixture.url+'/docs/tab3');await expect(last.getByRole('heading',{name:'Tab 3'})).toBeVisible();
    const retained=JSON.parse(await fixture.read('.prnext-dev.json')).routes;expect(retained).toContain('/tab0');expect(retained).toContain('/tab3');expect(retained).not.toContain('/tab1');expect(retained).not.toContain('/tab2');
  });
  test('semantic TypeScript errors are nonblocking and clear after a corrected edit',async({page})=>{
    fixture=await devFixture({files:{'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',strict:true,skipLibCheck:true},include:['check.ts']}),'check.ts':'export const value:number="wrong";'}});
    await page.goto(fixture.url+'/docs/pages');await expect(page.getByTestId('counter')).toHaveText('Original 0');
    await expect(page.getByRole('alertdialog')).toContainText('TS2322',{timeout:20000});
    expect((await fetch(fixture.url+'/docs/pages')).status).toBe(200);
    await fixture.write('check.ts','export const value:number=42;');await expect(page.getByRole('alertdialog')).toHaveCount(0,{timeout:20000});
    await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');
  });
  test('a cold-route compile failure waits for a corrected build without a reload loop',async({page})=>{
    fixture=await devFixture({files:{'pages/broken.jsx':'export default function Page(){return <bad'}});
    const documents=[];page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
    expect((await page.goto(fixture.url+'/docs/broken')).status()).toBe(500);
    await expect(page.locator('pre')).toContainText('broken.jsx');
    // A previous successful build must not reload this failed document.
    await page.waitForTimeout(700);expect(documents).toHaveLength(1);
    await fixture.write('pages/broken.jsx','export default function Page(){return <h1>Cold route recovered</h1>}');
    await expect(page.getByRole('heading',{name:'Cold route recovered'})).toBeVisible({timeout:25000});
    expect(documents).toHaveLength(2);
  });

});
