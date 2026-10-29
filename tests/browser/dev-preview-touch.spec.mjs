import { test, expect } from '@playwright/test';
import { devFixture } from '../dev-fixture.mjs';

const files = {
  'preview.css': 'body{margin:0;font:16px system-ui}main{padding:20px;min-height:5000px}a{display:block;margin:12px 0}.pan-area{height:160px;background:#ddd}.nested{height:120px;width:220px;overflow:auto;overscroll-behavior:contain;margin:12px 0}.nested>div{height:900px}.horizontal{width:220px;height:80px;overflow:auto;overscroll-behavior:contain}.horizontal>div{width:1400px;height:60px;background:linear-gradient(90deg,#777,#ddd)}textarea{display:block;margin:12px 0}input[type=range]{width:200px}.native{touch-action:none;height:80px;background:#eee}',
  'pages/_app.jsx': `import'../preview.css';export default function App({Component,pageProps}){return <Component {...pageProps}/>}`,
  'components/TouchPage.jsx': `import Counter from'./Counter';export default function TouchPage({title='Touch preview',next='/docs/next'}){return <main><h1>{title}</h1><Counter/><a href={next}>Next preview page</a><div className="pan-area" data-testid="pan-area">Swipe here</div><div className="nested" data-testid="nested"><div>Nested scrolling</div></div><div className="horizontal" data-testid="horizontal"><div/></div><textarea aria-label="Message"/><input type="range" aria-label="Volume" defaultValue="50"/><div className="native" data-testid="native">Application gesture</div></main>}`,
  'pages/pages.jsx': `import TouchPage from'../components/TouchPage';export default function Page(){return <TouchPage/>}`,
  'pages/next.jsx': `import TouchPage from'../components/TouchPage';export default function Page(){return <TouchPage title="Next touch preview" next="/docs/pages"/>}`,
};

test.describe('finger-style device preview panning', () => {
  test.setTimeout(90_000);
  let fixture;
  test.afterEach(async () => { await fixture?.close(); fixture = undefined; });
  const tools = page => page.locator('prnext-dev-tools');
  const frame = page => page.frameLocator('prnext-dev-tools iframe');
  const position = scope => scope.locator('html').evaluate(() => scrollY);
  async function open(page, device='Tablet') {
    fixture = await devFixture({files}); await page.setViewportSize({width:1440,height:1000}); await page.goto(fixture.url+'/docs/pages');
    await tools(page).locator('.trigger').click(); await tools(page).getByRole('button',{name:device,exact:true}).click();
    await expect(frame(page).getByRole('heading',{name:'Touch preview',exact:true})).toBeVisible();await expect.poll(()=>tools(page).locator('.wb-frame-wrap').evaluate(node=>node.getAnimations().every(animation=>animation.playState==='finished'))).toBe(true);
    await expect.poll(()=>frame(page).locator('html').evaluate(html=>getComputedStyle(html).cursor.includes('data:image/svg+xml'))).toBe(true);
    await expect(frame(page).locator('main')).toHaveCSS('min-height','5000px');
    await expect.poll(()=>frame(page).locator('html').evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);
    return tools(page).getByRole('dialog',{name:'Device preview'});
  }
  async function swipe(page, target, dx, dy) {
    await target.scrollIntoViewIfNeeded(); const box=await target.boundingBox(),x=box.x+box.width*(dx<0?.8:.5),y=box.y+box.height*.5;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:10});await page.mouse.up();
  }
  async function flick(target,dy){
    // Real input also focuses the iframe for the keyboard-cancellation check.
    await target.click();
    // Keep the final move/release and its baseline in one browser task. A slow
    // automation round trip is a pause, which correctly suppresses inertia.
    return target.evaluate((node,dy)=>{
      const view=node.ownerDocument.defaultView,box=node.getBoundingClientRect();
      const x=box.x+box.width/2,y=box.y+box.height/2;
      const emit=(type,step)=>node.dispatchEvent(new view.PointerEvent(type,{
        bubbles:true,composed:true,pointerId:42,pointerType:'mouse',isPrimary:true,
        button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y+dy*step,
      }));
      emit('pointerdown',0);for(let step=1;step<=10;step++)emit('pointermove',step/10);emit('pointerup',1);
      return view.scrollY;
    },dy);
  }
  test('mouse swipes pan both axes, preserve tap/keyboard/form controls, and never activate dragged links',async({page})=>{
    await page.emulateMedia({reducedMotion:'reduce'});const preview=await open(page),child=frame(page);
    for(const device of['Tablet','Phone']){
      await preview.getByRole('button',{name:device,exact:true}).click();await child.locator('html').evaluate(()=>scrollTo({top:0,behavior:'instant'}));
      const counter=child.getByTestId('counter');await swipe(page,counter,0,-100);expect(await position(child)).toBeGreaterThan(50);await expect(counter).toHaveText('Original 0');
      await child.locator('html').evaluate(()=>scrollTo({top:0,behavior:'instant'}));await counter.click();await expect(counter).toHaveText('Original 1');await page.keyboard.press('Space');await expect(counter).toHaveText('Original 2');
      const link=child.getByRole('link',{name:'Next preview page'});await swipe(page,link,0,-90);await expect(child.getByRole('heading',{name:'Touch preview',exact:true})).toBeAttached();
      const nested=child.getByTestId('nested');await nested.scrollIntoViewIfNeeded();const outer=await position(child);await swipe(page,nested,0,-65);expect(await nested.evaluate(node=>node.scrollTop)).toBeGreaterThan(40);expect(await position(child)).toBe(outer);
      await nested.evaluate(node=>node.scrollTop=node.scrollHeight-node.clientHeight-10);await swipe(page,nested,0,-65);expect(await position(child)).toBe(outer);
      const horizontal=child.getByTestId('horizontal');await horizontal.scrollIntoViewIfNeeded();const beforeHorizontal=await position(child);await swipe(page,horizontal,-85,0);expect(await horizontal.evaluate(node=>node.scrollLeft)).toBeGreaterThan(60);expect(await position(child)).toBe(beforeHorizontal);
      const message=child.getByRole('textbox',{name:'Message'});await message.fill('Still editable');await expect(message).toHaveValue('Still editable');
      const range=child.getByRole('slider',{name:'Volume'});await range.scrollIntoViewIfNeeded();await swipe(page,range,45,0);expect(Number(await range.inputValue())).toBeGreaterThan(50);
      const native=child.getByTestId('native');await native.scrollIntoViewIfNeeded();const beforeNative=await position(child);await swipe(page,native,0,-40);expect(await position(child)).toBe(beforeNative);
      // Reset the counter before the next device.
      await preview.getByRole('button',{name:'Reload preview',exact:true}).click();await expect(child.getByTestId('counter')).toHaveText('Original 0');await expect(child.locator('main')).toHaveCSS('min-height','5000px');await expect.poll(()=>child.locator('html').evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);
    }
    await child.getByRole('link',{name:'Next preview page'}).click();await expect(child.getByRole('heading',{name:'Next touch preview',exact:true})).toBeVisible();await swipe(page,child.getByTestId('pan-area'),0,-90);expect(await position(child)).toBeGreaterThan(50);
    expect(await page.evaluate(()=>scrollY)).toBe(0);
  });
  test('inertia stops on new input, reduced motion and Desktop; panning works detached and native touch remains native',async({page,context})=>{
    await page.emulateMedia({reducedMotion:'no-preference'});const preview=await open(page,'Phone'),child=frame(page);
    const released=await flick(child.getByTestId('pan-area'),-100);await expect.poll(()=>position(child)).toBeGreaterThan(released+5);
    await page.keyboard.press('Shift');const stopped=await position(child);await page.waitForTimeout(100);expect(await position(child)).toBe(stopped);
    await page.emulateMedia({reducedMotion:'reduce'});await swipe(page,child.getByTestId('pan-area'),0,-90);const reduced=await position(child);await page.waitForTimeout(100);expect(await position(child)).toBe(reduced);
    await preview.getByRole('button',{name:'Rotate',exact:true}).click();await swipe(page,child.getByTestId('pan-area'),0,-60);const rotated=await position(child);expect(rotated).toBeGreaterThan(0);
    await preview.getByRole('button',{name:'Desktop',exact:true}).click();await expect.poll(()=>child.locator('html').evaluate(html=>getComputedStyle(html).cursor.includes('data:image/svg+xml'))).toBe(false);
    await child.getByTestId('pan-area').scrollIntoViewIfNeeded();const desktop=await position(child);await swipe(page,child.getByTestId('pan-area'),0,-50);expect(await position(child)).toBe(desktop);
    await preview.getByRole('button',{name:'Tablet',exact:true}).click();const opened=page.waitForEvent('popup');await preview.getByRole('button',{name:'Open device preview in new window'}).click();const popup=await opened,detached=popup.getByRole('dialog',{name:'Device preview'}),popupChild=popup.frameLocator('prnext-dev-window iframe');
    await expect(popupChild.getByTestId('pan-area')).toBeVisible();await swipe(popup,popupChild.getByTestId('pan-area'),0,-90);expect(await position(popupChild)).toBeGreaterThan(50);
    await detached.getByRole('button',{name:'Dock device preview'}).click();await expect.poll(()=>popup.isClosed()).toBe(true);await expect(child.getByTestId('pan-area')).toBeVisible();
    await child.locator('html').evaluate(()=>scrollTo({top:0,behavior:'instant'}));const area=await child.getByTestId('pan-area').boundingBox(),x=area.x+area.width/2,y=area.y+area.height*.8;
    const session=await context.newCDPSession(page);await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let step=1;step<=6;step++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-step*15}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(()=>position(child)).toBeGreaterThan(40);expect(await page.evaluate(()=>scrollY)).toBe(0);
    await preview.getByRole('button',{name:'Close device preview'}).click();await expect(tools(page).locator('iframe')).toHaveCount(0);await expect(page.getByTestId('counter')).toHaveText('Original 0');
  });
});
