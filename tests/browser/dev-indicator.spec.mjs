import { test, expect } from '@playwright/test';
import { devFixture, counterSource } from '../dev-fixture.mjs';

test.describe('PRNext development tools', () => {
  test.setTimeout(90_000);
  let fixture;
  test.afterEach(async () => { await fixture?.close(); fixture = undefined; });
  async function fullDiagnostic(page,text,options){
    const dialog=page.getByRole('alertdialog',{name:'PRNext development error'}),message=dialog.locator('#message');await expect(message).toContainText(text,options);if(await dialog.locator('#error-details').isHidden())await dialog.locator('.error-row[aria-pressed=true]').click();const disclosure=dialog.locator('#message-disclosure');if(!await disclosure.evaluate(node=>node.open))await disclosure.locator('summary').click();await expect(message).toBeVisible();return dialog;
  }
  async function issueEndpoint(host,phase){
    const motion=host.locator('.issue-motion');await expect(motion).toHaveAttribute('data-phase',phase);await expect(motion).toHaveAttribute('data-running','false');
    const geometry=await host.evaluate((node,phase)=>{const shadow=node.shadowRoot,path=shadow.querySelector(phase==='closed'?'.issue-motion-ring':'.issue-motion-path'),rect=element=>{const value=element.getBoundingClientRect();return{x:value.x,y:value.y,width:value.width,height:value.height};};let expected;if(phase==='closed'){const source=rect(shadow.querySelector('.ring svg')),diameter=source.width*34.5/36;expected={x:source.x+(source.width-diameter)/2,y:source.y+(source.height-diameter)/2,width:diameter,height:diameter};}else{const target=rect(shadow.querySelector('.action-issues'));expected={x:target.x+.5,y:target.y+.5,width:target.width-1,height:target.height-1};}return{actual:rect(path),expected};},phase);
    for(const key of['x','y','width','height'])expect(Math.abs(geometry.actual[key]-geometry.expected[key]),`${phase} outline ${key}`).toBeLessThan(1.1);
  }
  async function moveLogo(page,host,corner){
    const trigger=host.locator('.trigger');await trigger.focus();await page.keyboard.press(corner.startsWith('top')?'Alt+ArrowUp':'Alt+ArrowDown');await page.keyboard.press(corner.endsWith('left')?'Alt+ArrowLeft':'Alt+ArrowRight');await expect(host).toHaveAttribute('data-position',corner);await expect.poll(()=>host.evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);
  }
  async function streakState(svg,options=0){
    if(options.arm){
      const event=options.event||'click',target=svg.getRootNode().querySelector(event==='keydown'?'.panel':'.trigger');
      let started,completedAt;
      // Record the real terminal mutation before a later SVG snapshot can add work.
      const observer=new MutationObserver(()=>{
        const observedAt=performance.now();
        if(started!==undefined&&svg.dataset.phase===options.phase&&svg.dataset.running==='false'){
          completedAt=observedAt-started;observer.disconnect();
        }
      });
      observer.observe(svg,{attributes:true,attributeFilter:['data-phase','data-running']});
      window.__issueThreadSamples=new Promise((resolve,reject)=>{
        target.addEventListener(event,async()=>{
          started=performance.now();
          try{const samples=await streakState(svg,{times:options.times});samples.at(-1).completedAt=completedAt;resolve(samples);}
          catch(error){reject(error);}
          finally{observer.disconnect();}
        },{once:true,capture:true});
      });
      return;
    }
    if(options.times){
      const started=performance.now(),samples=[];
      for(const at of options.times){
        await new Promise(resolve=>setTimeout(resolve,Math.max(0,at-(performance.now()-started))));
        // Timers can run consecutively before the browser paints another frame.
        // Sample after the pending animation callback, keeping strict motion checks.
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const sampledAt=performance.now()-started,sample=await streakState(svg);sample.sampledAt=sampledAt;samples.push(sample);
      }
      return samples;
    }
    const delay=typeof options==='number'?options:options.delay||0,geometry=typeof options==='object'&&options.geometry;
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    const shadow=svg.getRootNode(),outline=svg.querySelector('.issue-motion-path'),ring=svg.querySelector('.issue-motion-ring'),streak=svg.querySelector('.issue-motion-streak'),panel=shadow.querySelector('.panel'),issues=shadow.querySelector('.action-issues'),rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};},alpha=node=>{const style=getComputedStyle(node),colorAlpha=Number(style.stroke.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/)?.[1]??1);return Number(style.opacity)*Number(style.strokeOpacity)*colorAlpha*Number(getComputedStyle(svg).opacity);},attributes=(node,names)=>Object.fromEntries(names.map(name=>[name,node.getAttribute(name)]));
    const length=streak.getTotalLength(),style=getComputedStyle(streak),dash=style.strokeDasharray.match(/[\d.]+/g)?.map(Number),start=Math.max(0,-parseFloat(style.strokeDashoffset)||0),visibleLength=Math.min(length-start,dash?.[0]??length),matrix=streak.getScreenCTM(),pointAt=distance=>{const point=streak.getPointAtLength(distance),screen=new DOMPoint(point.x,point.y).matrixTransform(matrix);return{x:screen.x,y:screen.y};},points=Array.from({length:9},(_,index)=>pointAt(start+visibleLength*index/8)),half=parseFloat(style.strokeWidth)/2;
    const sourceBox=rect(shadow.querySelector('.ring svg')),source={x:sourceBox.x+sourceBox.width/2,y:sourceBox.y+sourceBox.height/2,radius:sourceBox.width*17.25/36},first=pointAt(0),second=pointAt(.25),radial={x:first.x-source.x,y:first.y-source.y},direction={x:second.x-first.x,y:second.y-first.y},route=geometry?Array.from({length:129},(_,index)=>pointAt(length*index/128)):[];
    return{phase:svg.dataset.phase,stage:svg.dataset.stage,running:svg.dataset.running,progress:Number(svg.dataset.progress),fill:Number(svg.dataset.fill),visibility:getComputedStyle(svg).visibility,groupOpacity:Number(getComputedStyle(svg).opacity),d:outline.getAttribute('d'),borderAlpha:alpha(outline),ringAlpha:alpha(ring),panelHidden:panel.hidden,panel:rect(panel),issues:rect(issues),outlineBounds:rect(outline),nativeBorderColor:getComputedStyle(issues).borderTopColor,source:{...source,first,distance:Math.hypot(radial.x,radial.y),tangentCosine:(radial.x*direction.x+radial.y*direction.y)/(Math.hypot(radial.x,radial.y)*Math.hypot(direction.x,direction.y)),minimumRouteRadius:Math.min(...route.map(point=>Math.hypot(point.x-source.x,point.y-source.y)))},streak:{...attributes(streak,['d','stroke-dasharray','stroke-dashoffset','opacity','stroke-width']),stroke:style.stroke,width:parseFloat(style.strokeWidth),alpha:alpha(streak),strokeOpacity:Number(style.strokeOpacity),opacity:Number(style.opacity),linecap:style.strokeLinecap,length,visibleLength,points,bounds:{left:Math.min(...points.map(point=>point.x))-half,right:Math.max(...points.map(point=>point.x))+half,top:Math.min(...points.map(point=>point.y))-half,bottom:Math.max(...points.map(point=>point.y))+half}}};
  }

  for (const router of ['pages', 'app']) test(`${router} shows one isolated, keyboard-accessible tools panel across edits`, async ({ page }) => {
    fixture = await devFixture();
    await page.goto(fixture.url + '/docs/' + router);
    const host = page.locator('prnext-dev-tools');
    const trigger = host.getByRole('button', { name: 'Open PRNext developer tools', exact: true });
    const dialog = host.getByRole('dialog', { name: 'PRNext developer tools' });
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box.width).toBe(44); expect(box.height).toBe(44);
    expect(box.x).toBe(18);
    expect(page.viewportSize().height - box.y - box.height).toBe(18);
    expect(await trigger.evaluate(node => getComputedStyle(node).borderRadius)).toBe('999px');
    await expect.poll(() => host.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await trigger.focus(); await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible(); await expect(dialog).toBeFocused();
    await expect(dialog.locator('.heading,.details,.status-text')).toHaveCount(0);
    await expect(dialog).not.toContainText('/docs/' + router);
    await expect(dialog).not.toContainText(router === 'app' ? 'App Router' : 'Pages Router');
    await expect(trigger).toHaveAttribute('title', 'PRNext · Ready');
    expect(await dialog.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
    await expect(dialog.getByRole('button', { name: /View issues/ })).toBeHidden();
    await expect(dialog.getByText('Documentation', {exact:true})).toHaveCount(0);
    expect((await dialog.boundingBox()).height).toBeLessThan(390);
    await page.keyboard.press('Tab');
    const reload = dialog.getByRole('button', { name: 'Reload page' });
    await expect(reload).toBeFocused();
    const focus = await reload.evaluate(node => {
      const style = getComputedStyle(node);
      return { visible: node.matches(':focus-visible'), width: style.outlineWidth, offset: parseFloat(style.outlineOffset), background: style.backgroundColor };
    });
    expect(focus.visible).toBe(true); expect(focus.width).toBe('1px');
    expect(focus.offset).toBeLessThanOrEqual(0); expect(focus.background).not.toBe('rgba(0, 0, 0, 0)');
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    await trigger.click(); await page.getByTestId('counter').click();
    await expect(dialog).toBeHidden(); await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await fixture.write('components/Counter.jsx', counterSource('Indicator refreshed'));
    await expect(page.getByTestId('counter')).toHaveText('Indicator refreshed 1', { timeout: 25000 });
    await expect(host).toHaveCount(1);
    await trigger.click(); await dialog.getByRole('button', { name: 'Hide until reload' }).click();
    await expect(host).toBeHidden(); await expect(page.getByTestId('counter')).toBeFocused();
    await page.reload(); await expect(trigger).toBeVisible();
    await trigger.click(); await dialog.getByRole('button', { name: 'Reload page' }).click();
    await expect(page.getByTestId('counter')).toHaveText('Indicator refreshed 0');
    await expect(trigger).toBeVisible(); await expect(dialog).toBeHidden();
  });

  test('keeps dismissed errors available and recovers after a corrected build', async ({ page }) => {
    fixture = await devFixture();
    await page.goto(fixture.url + '/docs/pages');
    const host = page.locator('prnext-dev-tools'),trigger=host.locator('.trigger');
    await expect(trigger).toHaveAttribute('data-issue-severity','none');
    await fixture.write('components/Counter.jsx', counterSource('Broken', { eventError: true }));
    await expect(page.getByTestId('counter')).toHaveText('Broken 0', { timeout: 25000 });
    await page.getByTestId('counter').click();
    await expect(page.getByRole('alertdialog').locator('#error-summary')).toContainText('event refresh failure');
    await expect(trigger).toHaveAttribute('data-issue-severity','critical');
    await expect(trigger).toHaveAttribute('aria-description',/Critical error/);
    expect(await host.locator('.ring').evaluate(node=>node.getAnimations({subtree:true}).some(animation=>animation.effect.getTiming().iterations===Infinity))).toBe(false);
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(trigger).toHaveAttribute('data-issue-severity','critical');
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await expect(host.locator('.trigger')).toHaveAttribute('title', 'PRNext · 1 issue');
    await host.getByRole('button', { name: /View issues/ }).click();
    await expect(page.getByRole('alertdialog').locator('#error-summary')).toContainText('event refresh failure');
    await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused();
    await fixture.write('components/Counter.jsx', counterSource('Recovered'));
    await expect(page.getByTestId('counter')).toHaveText('Recovered 0', { timeout: 25000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('data-issue-severity','none');
    await host.getByRole('button', { name: /Open PRNext developer tools/ }).click();
    await expect(host.locator('.trigger')).toHaveAttribute('title', 'PRNext · Ready');
    await expect(host.getByRole('button', { name: /View issues/ })).toBeHidden();
    await fixture.write('components/Counter.jsx', 'export default function Counter(){ return <broken');
    await fullDiagnostic(page,'Counter.jsx',{timeout:25000});
    await expect(trigger).toHaveAttribute('data-issue-severity','critical');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('1');
    await expect(trigger).toHaveAttribute('data-issue-severity','critical');
  });

  test('real TypeScript diagnostics stay noncritical while the live application remains usable',async({page})=>{
    fixture=await devFixture({files:{'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',strict:true,skipLibCheck:true},include:['check.ts']}),'check.ts':'export const value:number=42;'}});
    await page.emulateMedia({reducedMotion:'reduce'});await page.goto(fixture.url+'/docs/pages');const host=page.locator('prnext-dev-tools'),trigger=host.locator('.trigger');await expect(trigger).toHaveAttribute('data-issue-severity','none');await page.getByTestId('counter').click();const origin=await page.evaluate(()=>performance.timeOrigin);
    await trigger.evaluate(node=>{window.__issueSeverities=[];new MutationObserver(records=>window.__issueSeverities.push(...records.map(record=>record.oldValue),node.getAttribute('data-issue-severity'))).observe(node,{attributes:true,attributeFilter:['data-issue-severity'],attributeOldValue:true});});
    await fixture.write('check.ts','export const value:number="wrong";');await fullDiagnostic(page,'TS2322',{timeout:25000});await expect(trigger).toHaveAttribute('data-issue-severity','error');await expect(trigger).toHaveAttribute('aria-description',/Non-blocking issue/);expect(await host.locator('.ring').evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(0);expect((await page.request.get(fixture.url+'/docs/pages')).status()).toBe(200);await page.getByRole('button',{name:'Dismiss',exact:true}).click();await expect(trigger).toHaveAttribute('data-issue-severity','error');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('1');await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 2');expect(await page.evaluate(()=>performance.timeOrigin)).toBe(origin);
    await trigger.click();await host.getByRole('button',{name:/View issues/}).click();await fullDiagnostic(page,'TS2322');await expect(trigger).toHaveAttribute('data-issue-severity','error');await fixture.write('check.ts','export const value:number=42;');await expect(page.getByRole('alertdialog')).toHaveCount(0,{timeout:25000});await expect(trigger).toHaveAttribute('data-issue-severity','none');await expect(page.getByTestId('counter')).toHaveText('Original 2');expect(await page.evaluate(()=>performance.timeOrigin)).toBe(origin);expect(await page.evaluate(()=>window.__issueSeverities)).not.toContain('critical');
  });

  for(const router of['pages','app'])test(`${router} retains real recoverable hydration issues without blocking the application`,async({page})=>{
    const mismatch=`'use client';export default function HydrationMismatch(){return <p data-testid="hydration-value">{typeof window==='undefined'?'Rendered on server':'Rendered in browser'}</p>}`;
    fixture=await devFixture({files:{'components/HydrationMismatch.jsx':mismatch,'pages/pages.jsx':`import Counter from'../components/Counter';import HydrationMismatch from'../components/HydrationMismatch';export default function Page(){return <><Counter/><HydrationMismatch/></>}`,'app/app/page.jsx':`import Counter from'../../components/Counter';import HydrationMismatch from'../../components/HydrationMismatch';export default function Page(){return <><Counter/><HydrationMismatch/></>}`}});
    const response=await page.goto(fixture.url+'/docs/'+router);expect(await response.text()).toContain('Rendered on server');await expect(page.getByTestId('hydration-value')).toHaveText('Rendered in browser');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);
    const host=page.locator('prnext-dev-tools'),trigger=host.locator('.trigger');await expect(trigger).toHaveAttribute('data-issue-severity','error');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('1');await expect(page.getByRole('alertdialog')).toHaveCount(0);await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');const origin=await page.evaluate(()=>performance.timeOrigin);
    await trigger.click();await host.getByRole('button',{name:/View issues/}).click();await fullDiagnostic(page,/hydrat|didn't match|did not match/i);await expect(trigger).toHaveAttribute('data-issue-severity','error');await page.getByRole('button',{name:'Dismiss',exact:true}).click();await expect(trigger).toHaveAttribute('data-issue-severity','error');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('1');await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 2');
    await fixture.write('components/HydrationMismatch.jsx',`'use client';export default function HydrationMismatch(){return <p data-testid="hydration-value">Rendered in browser</p>}`);await expect(trigger).toHaveAttribute('data-issue-severity','none',{timeout:25000});await expect(page.getByTestId('counter')).toHaveText('Original 2');expect(await page.evaluate(()=>performance.timeOrigin)).toBe(origin);await trigger.click();await expect(host.getByRole('button',{name:/View issues/})).toBeHidden();
  });

  test('attribute-only hydration warnings remain noncritical and never downgrade a simultaneous runtime error',async({page})=>{
    const hydrationWarnings=[];page.on('console',message=>{if(message.type()==='error'&&/attributes.*server|server.*attributes|tree hydrated/i.test(message.text()))hydrationWarnings.push(message.text());});
    await page.addInitScript(()=>{const Native=window.EventSource;window.__typeCheckBatches=[];window.EventSource=class extends Native{constructor(...args){super(...args);this.addEventListener('message',event=>{try{const message=JSON.parse(event.data);if(Array.isArray(message.typeErrors))window.__typeCheckBatches.push(message.typeErrors);}catch{}});}};});
    fixture=await devFixture({files:{'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',strict:true,skipLibCheck:true},include:['check.ts']}),'check.ts':'export const value:number=42;','components/HydrationMismatch.jsx':`'use client';export default function HydrationMismatch(){return <><span data-testid="hydration-attribute" data-version={typeof window==='undefined'?'server':'client'}>Stable text</span><button data-testid="runtime-failure" onClick={()=>{throw Error('mixed runtime failure')}}>Cause runtime error</button></>}`,'pages/pages.jsx':`import Counter from'../components/Counter';import HydrationMismatch from'../components/HydrationMismatch';export default function Page(){return <><Counter/><HydrationMismatch/></>}`}});
    await page.goto(fixture.url+'/docs/pages');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);await expect.poll(()=>hydrationWarnings.length).toBeGreaterThan(0);await expect.poll(()=>page.evaluate(()=>window.__typeCheckBatches.filter(errors=>!errors.length).length)).toBeGreaterThan(0);await expect(page.getByTestId('hydration-attribute')).toHaveAttribute('data-version','server');const host=page.locator('prnext-dev-tools'),trigger=host.locator('.trigger');await expect(trigger).toHaveAttribute('data-issue-severity','error');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('1');await expect(page.getByRole('alertdialog')).toHaveCount(0);await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');const origin=await page.evaluate(()=>performance.timeOrigin);
    await trigger.click();await host.getByRole('button',{name:/View issues/}).click();await fullDiagnostic(page,/attributes|tree hydrated/i);await expect(trigger).toHaveAttribute('data-issue-severity','error');const emptyBatches=await page.evaluate(()=>window.__typeCheckBatches.filter(errors=>!errors.length).length);await fixture.write('check.ts','export const value:number=43;');await expect.poll(()=>page.evaluate(()=>window.__typeCheckBatches.filter(errors=>!errors.length).length),{timeout:20000}).toBeGreaterThan(emptyBatches);await fullDiagnostic(page,/attributes|tree hydrated/i);await expect(trigger).toHaveAttribute('data-issue-severity','error');await page.getByRole('button',{name:'Dismiss',exact:true}).click();await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('1');
    await page.getByTestId('runtime-failure').click();await expect(page.getByRole('alertdialog').locator('#error-summary')).toContainText('mixed runtime failure');await expect(trigger).toHaveAttribute('data-issue-severity','critical');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('2');await page.getByRole('button',{name:'Dismiss',exact:true}).click();await expect(trigger).toHaveAttribute('data-issue-severity','critical');await fixture.write('check.ts','export const value:number="wrong";');await expect(host.locator('.action').filter({hasText:'View issues'}).locator('.hint')).toHaveText('3',{timeout:20000});await expect(trigger).toHaveAttribute('data-issue-severity','critical');await expect(page.getByRole('alertdialog')).toHaveCount(0);await trigger.click();await host.getByRole('button',{name:/View issues/}).click();await expect(page.getByRole('alertdialog').locator('#error-summary')).toContainText('mixed runtime failure');await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    await fixture.write('check.ts','export const value:number=42;');await fixture.write('components/HydrationMismatch.jsx',`'use client';export default function HydrationMismatch(){return <span data-testid="hydration-attribute" data-version="server">Stable text</span>}`);await expect(trigger).toHaveAttribute('data-issue-severity','none',{timeout:25000});await expect(page.getByTestId('counter')).toHaveText('Original 1');expect(await page.evaluate(()=>performance.timeOrigin)).toBe(origin);
  });

  test('mobile and reduced-motion layouts honor positioning and CSS isolation', async ({ page }) => {
    fixture = await devFixture({config:"export default {basePath:'/docs',devIndicators:{position:'top-left'}}",files:{'components/counter.module.css':':global(button){font-size:48px;background:red;border-radius:0} .counter{color:black}'}});
    await page.emulateMedia({ reducedMotion:'reduce' }); await page.setViewportSize({width:320,height:568});
    await page.goto(fixture.url + '/docs/app');
    const host = page.locator('prnext-dev-tools');
    const trigger = host.getByRole('button', {name:/Open PRNext developer tools/});
    const bounds = await trigger.boundingBox(); expect(bounds.x).toBe(18); expect(bounds.y).toBe(18);
    await trigger.click(); const panel = host.getByRole('dialog'); await expect(panel).toBeVisible();
    const box = await panel.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x+box.width).toBeLessThanOrEqual(320); expect(box.y+box.height).toBeLessThanOrEqual(568);
    expect(await panel.evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
    expect(await host.locator('.bubble-mask').evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
    expect(await trigger.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe('rgb(255, 0, 0)');
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  });

  test('critical issue streaks travel before stationary borders fill in every corner',async({page})=>{
    fixture=await devFixture({files:{'components/Counter.jsx':counterSource('Outline failure',{eventError:true})}});await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(fixture.url+'/docs/pages');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);await page.getByTestId('counter').click();await expect(page.getByRole('alertdialog').locator('#error-summary')).toHaveText('event refresh failure');await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    const host=page.locator('prnext-dev-tools'),trigger=host.locator('.trigger'),panel=host.getByRole('dialog',{name:'PRNext developer tools'}),issues=panel.getByRole('button',{name:/View issues/}),motion=host.locator('.issue-motion');await expect(trigger).toHaveAttribute('data-issue-severity','critical');
    for(const corner of['bottom-left','bottom-right','top-right','top-left']){
      await moveLogo(page,host,corner);await issueEndpoint(host,'closed');await expect(host.locator('.ring circle')).toHaveCSS('stroke','rgba(240, 92, 102, 0.5)');await expect.poll(()=>host.locator('.ring circle').evaluate(node=>getComputedStyle(node).strokeDasharray.match(/[\d.]+/g).map(Number))).toEqual([50,0,50,0]);await trigger.focus();if(corner==='bottom-left')await motion.evaluate(streakState,{arm:true,phase:'open',times:[20,100,170,240,300,400,540]});await page.keyboard.press('Enter');await expect(panel).toBeFocused();
      if(corner==='bottom-left'){
        const[initial,departing,travel,middle,arriving,filling,opened]=await motion.evaluate(async()=>{const samples=await window.__issueThreadSamples;delete window.__issueThreadSamples;return samples;});const destination=initial.d;const flight=[departing,travel,middle,arriving];console.log('motion-flight',JSON.stringify(flight.map(sample=>({at:sample.sampledAt,offset:Number(sample.streak['stroke-dashoffset']),length:sample.streak.visibleLength,stage:sample.stage}))));for(let index=1;index<flight.length;index++){expect(Number(flight[index].streak['stroke-dashoffset'])).toBeLessThan(Number(flight[index-1].streak['stroke-dashoffset']));expect(flight[index].streak.d).toBe(flight[0].streak.d);expect(flight[index].d).toBe(destination);}
        expect(travel.phase).toBe('opening');expect(travel.stage).toBe('travel');expect(travel.running).toBe('true');expect(travel.progress).toBeGreaterThan(0);expect(travel.progress).toBeLessThan(1);expect(travel.fill).toBe(0);expect(destination).toMatch(/^M/);expect(travel.d).toBe(destination);expect(travel.borderAlpha).toBe(0);expect(travel.ringAlpha).toBe(0);expect(travel.streak.visibleLength).toBeGreaterThan(10);expect(travel.streak.visibleLength).toBeLessThanOrEqual(20.1);expect(travel.streak.linecap).toBe('round');expect(travel.streak.width).toBeGreaterThanOrEqual(1);expect(travel.streak.width).toBeLessThanOrEqual(1.5);expect(travel.streak.alpha).toBeCloseTo(.5,3);expect(travel.groupOpacity).toBe(.5);expect(travel.streak.stroke).toBe('rgb(240, 92, 102)');expect(travel.streak.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y))).toBe(true);await expect(motion.locator('.issue-motion-dot')).toHaveCount(0);await expect(motion.locator('.issue-motion-streak')).toHaveCount(1);expect(travel.nativeBorderColor).toBe('rgba(0, 0, 0, 0)');
        await expect.poll(()=>host.locator('.bubble-mask').evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);await expect(panel).toBeVisible();
        console.log('motion-open',JSON.stringify({completedAt:opened.completedAt,sampledAt:opened.sampledAt}));expect(travel.sampledAt).toBeGreaterThanOrEqual(160);expect(travel.sampledAt).toBeLessThan(240);expect(filling.sampledAt).toBeGreaterThanOrEqual(390);expect(filling.sampledAt).toBeLessThan(470);expect(filling.stage).toBe('fill');expect(filling.fill).toBeGreaterThan(0);expect(filling.fill).toBeLessThan(1);expect(filling.running).toBe('true');expect(filling.borderAlpha).toBeCloseTo(.5,3);expect(filling.streak.width).toBeGreaterThanOrEqual(1);expect(filling.streak.width).toBeLessThanOrEqual(travel.streak.width);expect(filling.d).toBe(destination);expect(opened.phase).toBe('open');expect(opened.running).toBe('false');expect(opened.visibility).toBe('hidden');expect(opened.completedAt).toBeLessThan(620);for(const key of['x','y','width','height']){const expected=key==='x'||key==='y'?filling.issues[key]+.5:filling.issues[key]-1;expect(Math.abs(filling.outlineBounds[key]-expected),`stable fill border ${key}`).toBeLessThan(1.1);}
      }
      await issueEndpoint(host,'open');const departure=await motion.evaluate(streakState,{geometry:true});expect(departure.source.distance).toBeCloseTo(departure.source.radius,1);expect((departure.source.first.x-departure.source.x)*(corner.endsWith('right')?1:-1)).toBeCloseTo(departure.source.radius,1);expect(Math.abs(departure.source.tangentCosine)).toBeLessThan(.06);expect(departure.source.minimumRouteRadius).toBeGreaterThanOrEqual(departure.source.radius-.15);expect(departure.streak.width).toBeGreaterThanOrEqual(1);expect(departure.streak.width).toBeLessThanOrEqual(1.5);await expect(motion).toBeHidden();const border=await issues.evaluate(node=>getComputedStyle(node).borderTopColor);expect(border).toBe('rgba(240, 92, 102, 0.5)');await page.keyboard.press('Tab');await expect(issues).toBeFocused();if(corner==='bottom-left')await motion.evaluate(streakState,{arm:true,event:'keydown',phase:'closed',times:[150,420]});await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
      if(corner==='bottom-left'){
        const[returning,closed]=await motion.evaluate(async()=>{const samples=await window.__issueThreadSamples;delete window.__issueThreadSamples;return samples;});
        console.log('motion-close',JSON.stringify({completedAt:closed.completedAt,sampledAt:closed.sampledAt}));expect(returning.fill).toBe(0);expect(returning.borderAlpha).toBe(0);expect(returning.ringAlpha).toBe(0);expect(returning.streak.visibleLength).toBeGreaterThan(10);expect(returning.streak.visibleLength).toBeLessThanOrEqual(20.1);expect(returning.streak.alpha).toBeGreaterThan(0);expect(returning.phase).toBe('closing');expect(returning.running).toBe('true');expect(returning.visibility).toBe('visible');expect(returning.sampledAt).toBeGreaterThanOrEqual(140);expect(returning.sampledAt).toBeLessThan(230);expect(closed.panelHidden).toBe(true);expect(closed.phase).toBe('closed');expect(closed.running).toBe('false');expect(closed.visibility).toBe('hidden');expect(closed.progress).toBe(0);expect(closed.completedAt).toBeLessThan(500);expect(closed.d).toBe(returning.d);
      }
      await issueEndpoint(host,'closed');await expect(motion).toBeHidden();await expect(trigger).toHaveAttribute('data-issue-severity','critical');
    }
  });

  test('noncritical issue streaks reverse continuously and clean up on reduced motion, drag, resize and recovery',async({page})=>{
    fixture=await devFixture({files:{'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',strict:true,skipLibCheck:true},include:['check.ts']}),'check.ts':'export const value:number=42;','components/MotionRuntime.jsx':`'use client';export default function MotionRuntime(){return <button data-testid="motion-runtime" onClick={()=>{throw Error('motion runtime failure')}}>Trigger runtime failure</button>}`,'pages/pages.jsx':`import Counter from'../components/Counter';import MotionRuntime from'../components/MotionRuntime';export default function Page(){return <><Counter/><MotionRuntime/></>}`}});await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(fixture.url+'/docs/pages');await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);await fixture.write('check.ts','export const value:number="wrong";');await expect(page.getByRole('alertdialog').locator('#error-title')).toHaveText('TypeScript',{timeout:25000});await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    const host=page.locator('prnext-dev-tools'),trigger=host.locator('.trigger'),panel=host.getByRole('dialog',{name:'PRNext developer tools'}),motion=host.locator('.issue-motion');await expect(trigger).toHaveAttribute('data-issue-severity','error');await issueEndpoint(host,'closed');await expect(host.locator('.ring circle')).toHaveCSS('stroke','rgba(240, 92, 102, 0.5)');await expect.poll(()=>host.locator('.ring circle').evaluate(node=>getComputedStyle(node).strokeDasharray.match(/[\d.]+/g).map(Number))).toEqual([13,37,13,37]);
    const continuity=await trigger.evaluate(async button=>{
      const path=button.getRootNode().querySelector('.issue-motion-path'),layer=path.parentElement;
      const attributes=(node,names)=>Object.fromEntries(names.map(name=>[name,node.getAttribute(name)]));
      const snapshot=()=>({outline:attributes(path,['d','stroke-dasharray','stroke-dashoffset','opacity','stroke-opacity','stroke-width']),ring:attributes(layer.querySelector('.issue-motion-ring'),['d','stroke-dasharray','stroke-dashoffset','opacity','stroke-opacity','stroke-width']),streak:attributes(layer.querySelector('.issue-motion-streak'),['d','stroke-dasharray','stroke-dashoffset','opacity','stroke-width']),progress:Number(layer.dataset.progress)});
      const wait=async time=>{
        await new Promise(resolve=>setTimeout(resolve,time));
        // Observe the painted pose before testing continuity through a reversal.
        await new Promise(resolve=>requestAnimationFrame(resolve));
      };
      const closed=snapshot();button.click();
      const started=performance.now(),until=at=>wait(Math.max(0,at-(performance.now()-started)));
      await until(40);const early=snapshot();await until(150);const opening=snapshot();
      button.click();const reverse=snapshot();await wait(50);const closing=snapshot();button.click();
      return{closed,early,opening,reverse,closing,reopen:snapshot()};
    });
    expect(continuity.early.ring).not.toEqual(continuity.closed.ring);expect(continuity.early.ring.d).toBe(continuity.closed.ring.d);expect(continuity.opening.streak).not.toEqual(continuity.early.streak);expect(continuity.opening.progress).toBeGreaterThan(0);expect(continuity.opening.progress).toBeLessThan(1);for(const key of['outline','ring','streak']){expect(continuity.reverse[key]).toEqual(continuity.opening[key]);expect(continuity.reopen[key]).toEqual(continuity.closing[key]);}await issueEndpoint(host,'open');
    await trigger.evaluate(button=>{const shadow=button.getRootNode(),panel=shadow.querySelector('.panel'),svg=shadow.querySelector('.issue-motion'),started=performance.now();let runtimeAt,criticalAt;const severityEvents=[],severityObserver=new MutationObserver(()=>{severityEvents.push({at:performance.now()-started,severity:button.dataset.issueSeverity});if(button.dataset.issueSeverity==='critical'&&criticalAt===undefined)criticalAt=performance.now()-started;});severityObserver.observe(button,{attributes:true,attributeFilter:['data-issue-severity']});window.__motionSeverityClosed=new Promise(resolve=>{const observer=new MutationObserver(()=>{if(svg.dataset.phase!=='closed')return;observer.disconnect();severityObserver.disconnect();resolve({closedAt:performance.now()-started,running:svg.dataset.running,severity:button.dataset.issueSeverity});});observer.observe(svg,{attributes:true,attributeFilter:['data-phase']});});window.__motionSeverityHide=new Promise(resolve=>{const observer=new MutationObserver(()=>{if(!panel.hidden)return;observer.disconnect();const line=svg.querySelector('.issue-motion-path'),streak=svg.querySelector('.issue-motion-streak'),groupOpacity=Number(getComputedStyle(svg).opacity),effectiveAlpha=node=>{const style=getComputedStyle(node);return Number(style.opacity)*Number(style.strokeOpacity)*groupOpacity;};resolve({hiddenAt:performance.now()-started,runtimeAt,criticalAt,trigger:'runtime.reportError',severityEvents:severityEvents.slice(),issueMessage:window.__PRNEXT_DEV__?.issue?.message,severity:button.dataset.issueSeverity,phase:svg.dataset.phase,running:svg.dataset.running,fill:Number(svg.dataset.fill),alpha:effectiveAlpha(line),ringAlpha:effectiveAlpha(svg.querySelector('.issue-motion-ring')),streakAlpha:effectiveAlpha(streak)});});observer.observe(panel,{attributes:true,attributeFilter:['hidden']});});button.click();setTimeout(()=>{runtimeAt=performance.now()-started;window.__PRNEXT_DEV__.reportError(new Error('motion runtime failure'));},100);});const severityHide=await page.evaluate(()=>window.__motionSeverityHide);console.log('motion-severity',JSON.stringify(severityHide));await expect(page.getByRole('alertdialog').locator('#error-title')).toHaveText('Runtime error');await page.getByRole('button',{name:'Dismiss',exact:true}).click();expect(severityHide.runtimeAt).toBeGreaterThanOrEqual(90);expect(severityHide.runtimeAt).toBeLessThan(190);expect(severityHide.hiddenAt).toBeGreaterThanOrEqual(250);expect(severityHide.hiddenAt).toBeLessThan(360);expect(severityHide.criticalAt).toBeGreaterThanOrEqual(severityHide.runtimeAt);expect(severityHide.criticalAt).toBeLessThan(severityHide.hiddenAt);expect(severityHide.severity).toBe('critical');expect(severityHide.phase).toBe('closing');expect(severityHide.running).toBe('true');expect(severityHide.fill).toBe(0);expect(severityHide.alpha).toBe(0);expect(Math.max(severityHide.ringAlpha,severityHide.streakAlpha)).toBeGreaterThan(0);const severityClosed=await page.evaluate(()=>window.__motionSeverityClosed);console.log('motion-closed',JSON.stringify(severityClosed));expect(severityClosed.closedAt).toBeGreaterThanOrEqual(330);expect(severityClosed.closedAt).toBeLessThan(430);expect(severityClosed.running).toBe('false');expect(severityClosed.severity).toBe('critical');await issueEndpoint(host,'closed');await fixture.write('components/MotionRuntime.jsx',`'use client';export default function MotionRuntime(){return <button data-testid="motion-runtime">Recovered runtime</button>}`);await expect(page.getByTestId('motion-runtime')).toHaveText('Recovered runtime',{timeout:25000});await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);await expect(trigger).toHaveAttribute('data-issue-severity','error');if(await page.getByRole('alertdialog').count())await page.getByRole('button',{name:'Dismiss',exact:true}).click();await trigger.evaluate(button=>button.click());await issueEndpoint(host,'open');
    await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Escape');await issueEndpoint(host,'closed');await trigger.focus();await page.keyboard.press('Enter');await issueEndpoint(host,'open');await expect(motion).toHaveAttribute('data-running','false');await expect(panel).toBeFocused();await page.keyboard.press('Escape');await issueEndpoint(host,'closed');
    await page.emulateMedia({reducedMotion:'no-preference'});await trigger.evaluate(async button=>{button.click();await new Promise(resolve=>setTimeout(resolve,80));});let box=await trigger.boundingBox();await page.mouse.move(box.x+22,box.y+22);await page.mouse.down();await page.mouse.move(box.x+65,box.y-45,{steps:4});await expect(host).toHaveAttribute('data-dragging','true');await expect(trigger).toHaveAttribute('aria-expanded','false');await expect(motion).toHaveAttribute('data-running','false');await trigger.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();await expect.poll(()=>host.evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);await issueEndpoint(host,'closed');
    await trigger.evaluate(async button=>{button.click();await new Promise(resolve=>setTimeout(resolve,80));});await page.setViewportSize({width:390,height:844});await expect(motion).toHaveAttribute('data-phase','open');await expect(motion).toHaveAttribute('data-running','false');await expect(motion).toBeHidden();expect(await host.locator('.action-issues').evaluate(node=>getComputedStyle(node).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');await expect.poll(()=>panel.evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);await issueEndpoint(host,'open');const issues=panel.getByRole('button',{name:/View issues/});await issues.focus();await fixture.write('check.ts','export const value:number=42;');await expect(trigger).toHaveAttribute('data-issue-severity','none',{timeout:25000});await expect(motion).toHaveAttribute('data-phase','disabled');await expect(motion).toHaveAttribute('data-running','false');await expect(motion).toBeHidden();await expect(issues).toBeHidden();await expect(panel).toBeFocused();await expect(trigger).toHaveAttribute('aria-expanded','true');await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');await fixture.write('check.ts','export const value:number="wrong again";');await expect(page.getByRole('alertdialog').locator('#error-title')).toHaveText('TypeScript',{timeout:25000});await page.getByRole('button',{name:'Dismiss',exact:true}).click();await expect(trigger).toHaveAttribute('aria-expanded','false');await expect(motion).toHaveAttribute('data-progress','0');await issueEndpoint(host,'closed');await expect(motion).toBeHidden();
  });

  for(const position of ['bottom-left','bottom-right','top-left','top-right'])test(`dark bubble stays attached and reverses cleanly at ${position}`,async({page})=>{
    fixture=await devFixture({config:`export default {basePath:'/docs',devIndicators:{position:'${position}'}}`});
    await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(fixture.url+'/docs/pages');
    const host=page.locator('prnext-dev-tools'),trigger=host.getByRole('button',{name:/Open PRNext developer tools/}),panel=host.getByRole('dialog',{name:'PRNext developer tools'}),mask=host.locator('.bubble-mask');
    await trigger.click();await expect(panel).toBeFocused();
    await expect.poll(()=>mask.evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);
    const shape=host.locator('.bubble path');expect(await shape.evaluate(node=>getComputedStyle(node).fill)).toBe('rgb(8, 8, 8)');
    const logo=await trigger.boundingBox(),menu=await panel.boundingBox(),bubble=await host.locator('.bubble').boundingBox();
    if(position.startsWith('top')){expect(menu.y-logo.y).toBe(36);expect(bubble.y).toBe(logo.y);}
    else{expect(logo.y+logo.height-menu.y-menu.height).toBeCloseTo(36);expect(bubble.y+bubble.height).toBeCloseTo(logo.y+logo.height);}
    if(position.endsWith('left'))expect(menu.x).toBe(logo.x);else expect(menu.x+menu.width).toBeCloseTo(logo.x+logo.width);
    // Interrupt the closing transition and reopen immediately.
    await trigger.evaluate(node=>node.click());await trigger.evaluate(node=>node.click());
    await expect(trigger).toHaveAttribute('aria-expanded','true');await expect(panel).toBeFocused();
    await expect.poll(()=>mask.evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);
    await expect(host.locator('.bubble')).toBeVisible();await expect(panel.getByRole('button',{name:'Reload page',exact:true})).toBeEnabled();
    await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await expect(host.locator('.bubble')).toBeHidden();
  });

  test('explicit opt-out hides the indicator but preserves errors and Fast Refresh', async ({page}) => {
    fixture = await devFixture({config:"export default {basePath:'/docs',devIndicators:false}"});
    await page.goto(fixture.url + '/docs/pages'); await expect(page.locator('prnext-dev-tools')).toHaveCount(0);
    expect(await page.evaluate(()=>globalThis.__PRNEXT_DEV__.consoleCapture)).toBeNull();
    await fixture.write('components/Counter.jsx', 'export default function Counter(){return <broken');
    await fullDiagnostic(page,'Counter.jsx',{timeout:25000});
    await fixture.write('components/Counter.jsx', counterSource('Opt-out recovered'));
    await expect(page.getByTestId('counter')).toHaveText('Opt-out recovered 0', {timeout:25000});
    await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(page.locator('prnext-dev-tools')).toHaveCount(0);
    await page.goto(fixture.url + '/docs/app'); await expect(page.getByTestId('counter')).toHaveText('Opt-out recovered 0');
    await expect(page.locator('prnext-dev-tools')).toHaveCount(0);
  });

  test('reports disconnected SSE and pending updates without claiming readiness', async ({page}) => {
    fixture = await devFixture();
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.route('**/_prnext/dev?*', route=>route.abort('connectionrefused'));
    await page.goto(fixture.url+'/docs/pages');
    const host=page.locator('prnext-dev-tools');
    await host.getByRole('button',{name:/Open PRNext developer tools/}).click();
    await expect(host.locator('.trigger')).toHaveAttribute('title', 'PRNext · Connecting…');
    await page.unroute('**/_prnext/dev?*');
    await expect(host.locator('.trigger')).toHaveAttribute('title', 'PRNext · Ready',{timeout:15000});
    let release;
    const held=new Promise(resolve=>{release=resolve;});
    await page.route('**/dev-manifest-*.json',async route=>{await held;await route.continue();});
    try {
      await fixture.write('components/Counter.jsx',counterSource('Pending update'));
      await expect(host.locator('.trigger')).toHaveAttribute('title', 'PRNext · Compiling…',{timeout:25000});
      await expect.poll(()=>host.locator('.ring circle').evaluate(node=>getComputedStyle(node).stroke)).toBe('rgb(179, 193, 255)');
      await expect.poll(()=>host.locator('.ring').evaluate(node=>node.getAnimations({subtree:true}).some(animation=>animation.effect.getTiming().iterations===Infinity))).toBe(true);
      await page.emulateMedia({reducedMotion:'reduce'});
      await expect.poll(()=>host.locator('.ring').evaluate(node=>node.getAnimations({subtree:true}).some(animation=>animation.effect.getTiming().iterations===Infinity))).toBe(false);
    } finally {release();}
    await expect(page.getByTestId('counter')).toHaveText('Pending update 0',{timeout:25000});
    await expect(host.locator('.trigger')).toHaveAttribute('title', 'PRNext · Ready');
  });

  test('production pages and their browser assets exclude the developer tools', async ({page}) => {
    await page.goto('/'); await expect(page.locator('prnext-dev-tools')).toHaveCount(0);
    expect(await page.evaluate(()=>globalThis.__PRNEXT_DEV__)).toBeUndefined();
    const scripts=await page.locator('script[src]').evaluateAll(nodes=>nodes.map(node=>node.src));
    expect(scripts.length).toBeGreaterThan(0);
    for(const url of scripts){const response=await page.request.get(url);expect(response.ok()).toBe(true);const source=await response.text();expect(source).not.toContain('__prnext_dev_tools__');expect(source).not.toContain('prnext:preview-ready');expect(source).not.toContain('Console messages');expect(source).not.toContain('Fix all errors below.');}
  });
});
