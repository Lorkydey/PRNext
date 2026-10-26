import { test, expect } from '@playwright/test';
import { devFixture } from '../dev-fixture.mjs';

test.describe('movable developer logo and device frames', () => {
  test.setTimeout(90_000);
  let fixture;
  test.afterEach(async () => { await fixture?.close(); fixture = undefined; });
  const tools = page => page.locator('prnext-dev-tools');
  const logo = page => tools(page).getByRole('button', { name: /Open PRNext developer tools/ });
  const scrollFiles={
    'scrollbar.css':'html{scrollbar-width:thin;scrollbar-gutter:stable}body{margin:0;min-height:5000px;font:16px system-ui}main{min-height:5000px;padding:24px}.nested-scroll{width:180px;height:120px;overflow:auto;scrollbar-width:thin;scrollbar-gutter:stable}.nested-scroll>div{height:900px}html::-webkit-scrollbar,.nested-scroll::-webkit-scrollbar{display:block;width:13px;height:13px}',
    'components/AuthorSheet.jsx':`'use client';import{useEffect}from'react';export default function AuthorSheet(){useEffect(()=>{const sheet=new CSSStyleSheet();sheet.replaceSync(':root{--author-sheet:retained}');window.__authorSheet=sheet;document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];return()=>{document.adoptedStyleSheets=document.adoptedStyleSheets.filter(item=>item!==sheet);};},[]);return null;}`,
    'components/ScrollPage.jsx':`import Counter from'./Counter';export default function ScrollPage({title='Scroll page',next='/docs/next'}){return <main id="scroll-main" tabIndex={0}><h1>{title}</h1><Counter/><p><a href={next}>Next preview page</a></p><div className="nested-scroll" tabIndex={0}><div>Nested scroll content</div></div><p style={{marginTop:4500}}>End of page</p></main>}`,
    'pages/_app.jsx':`import'../scrollbar.css';import AuthorSheet from'../components/AuthorSheet';export default function App({Component,pageProps}){return <><AuthorSheet/><Component {...pageProps}/></>}`,
    'app/layout.jsx':`import'../scrollbar.css';import AuthorSheet from'../components/AuthorSheet';export default function Layout({children}){return <html><body><AuthorSheet/>{children}</body></html>}`,
    'pages/pages.jsx':`import ScrollPage from'../components/ScrollPage';export default function Page(){return <ScrollPage/>}`,
    'pages/next.jsx':`import ScrollPage from'../components/ScrollPage';export default function Page(){return <ScrollPage title="Next scroll page" next="/docs/pages"/>}`,
    'app/app/page.jsx':`import ScrollPage from'../../components/ScrollPage';export default function Page(){return <ScrollPage/>}`,
  };
  const documentStyles=scope=>scope.locator('html').evaluate(html=>({root:getComputedStyle(html).scrollbarWidth,gutter:getComputedStyle(html).scrollbarGutter,nested:getComputedStyle(document.querySelector('.nested-scroll')).scrollbarWidth,adopted:document.adoptedStyleSheets.length,author:document.adoptedStyleSheets.includes(window.__authorSheet),marker:getComputedStyle(html).getPropertyValue('--author-sheet').trim(),htmlStyle:html.getAttribute('style'),bodyStyle:document.body.getAttribute('style')}));
  async function scrollbarPolicy(frame,hidden){await expect.poll(()=>documentStyles(frame)).toEqual({root:hidden?'none':'thin',gutter:hidden?'auto':'stable',nested:hidden?'none':'thin',adopted:hidden?2:1,author:true,marker:'retained',htmlStyle:null,bodyStyle:null});}
  async function screenGeometry(preview){const shape=await preview.locator('.wb-screen').evaluate(screen=>{const frame=screen.querySelector('iframe'),a=screen.getBoundingClientRect(),b=frame.getBoundingClientRect(),screenStyle=getComputedStyle(screen),frameStyle=getComputedStyle(frame);return{screen:{x:a.x,y:a.y,width:a.width,height:a.height},frame:{x:b.x,y:b.y,width:b.width,height:b.height},clip:screenStyle.overflow,border:screenStyle.borderWidth,frameBorder:frameStyle.borderWidth,frameRadius:frameStyle.borderRadius};});expect(['hidden','clip']).toContain(shape.clip);expect(shape.border).toBe('0px');expect(shape.frameBorder).toBe('0px');expect(shape.frameRadius).toBe('0px');for(const key of['x','y','width','height'])expect(shape.frame[key]).toBeCloseTo(shape.screen[key],1);}
  async function settled(host) {
    await expect.poll(() => host.evaluate(node => node.getAnimations().every(animation => animation.playState === 'finished'))).toBe(true);
  }
  async function dragTo(page, corner) {
    const button = logo(page), box = await button.boundingBox(), size = page.viewportSize();
    await page.mouse.move(box.x + 22, box.y + 22); await page.mouse.down();
    await page.mouse.move(corner.endsWith('left') ? 40 : size.width - 40, corner.startsWith('top') ? 40 : size.height - 40, { steps: 8 });
    await page.mouse.up(); await settled(tools(page));
    await expect(tools(page)).toHaveAttribute('data-position', corner);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  }
  test('drag snaps to all four corners, reorients the bubble and persists through reload', async ({ page }) => {
    fixture = await devFixture(); await page.goto(fixture.url + '/docs/pages');
    await page.getByTestId('counter').click();
    for (const corner of ['top-right', 'bottom-right', 'top-left', 'bottom-left']) {
      await dragTo(page, corner);
      const button = logo(page); await button.click();
      const panel = tools(page).getByRole('dialog', { name: 'PRNext developer tools' });
      await expect(panel).toBeVisible();
      await expect.poll(() => tools(page).locator('.bubble-mask').evaluate(node => node.getAnimations().every(a => a.playState === 'finished'))).toBe(true);
      const b = await button.boundingBox(), p = await panel.boundingBox();
      if (corner.startsWith('top')) expect(p.y - b.y).toBeCloseTo(36);
      else expect(b.y + b.height - p.y - p.height).toBeCloseTo(36);
      if (corner.endsWith('left')) expect(p.x).toBe(b.x);
      else expect(p.x + p.width).toBeCloseTo(b.x + b.width);
      await page.keyboard.press('Escape');
    }
    await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await dragTo(page, 'top-right'); await page.reload();
    await expect(tools(page)).toHaveAttribute('data-position', 'top-right');
    await expect(logo(page)).toBeVisible();
    const b = await logo(page).boundingBox(); expect(b.y).toBe(18); expect(b.x + b.width).toBe(page.viewportSize().width - 18);
    await fixture.write('prnext.config.mjs', "export default{basePath:'/docs',devIndicators:{position:'top-left'}}");
    await expect(tools(page)).toHaveAttribute('data-position', 'top-left', { timeout: 25000 });
  });
  test('keyboard movement, cancelled drags, small click jitter and reduced motion stay usable without storage', async ({ page }) => {
    fixture = await devFixture();
    await page.addInitScript(() => { Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('Storage disabled'); }; });
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(fixture.url + '/docs/app');
    const host = tools(page), button = logo(page); await button.focus();
    await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Alt+ArrowUp');
    await expect(host).toHaveAttribute('data-position', 'top-right'); expect(await host.evaluate(node => node.getAnimations().length)).toBe(0);
    let box = await button.boundingBox(); await page.mouse.move(box.x + 22, box.y + 22); await page.mouse.down(); await page.mouse.move(40, 400);
    await expect(host).toHaveAttribute('data-dragging', 'true'); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(host).toHaveAttribute('data-position', 'top-right'); await expect(button).toHaveAttribute('aria-expanded', 'false');
    box = await button.boundingBox(); await page.mouse.move(box.x + 22, box.y + 22); await page.mouse.down(); await page.mouse.move(box.x + 24, box.y + 23); await page.mouse.up();
    await expect(host.getByRole('dialog', { name: 'PRNext developer tools' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.move(box.x + 22, box.y + 22); await page.mouse.down(); await page.mouse.move(40, 400);
    await button.dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
    await expect(host).toHaveAttribute('data-position', 'top-right');
    await page.setViewportSize({ width: 390, height: 844 });
    box = await button.boundingBox(); expect(box.x + box.width).toBe(372); expect(box.y).toBe(18);
    await button.click(); await host.getByRole('button', { name: 'Phone', exact: true }).click();
    const preview = host.getByRole('dialog', { name: 'Device preview' });
    await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();
    await preview.getByRole('button', { name: 'Device frame', exact: true }).click();
    await expect(preview.locator('.wb-device-top')).toBeHidden();
  });
  test('touch dragging moves the logo without scrolling the page or opening the menu', async ({ page, context }) => {
    fixture = await devFixture(); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(fixture.url + '/docs/pages');
    const session = await context.newCDPSession(page), box = await logo(page).boundingBox();
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 22, y: box.y + 22 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 350, y: 40 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settled(tools(page)); await expect(tools(page)).toHaveAttribute('data-position', 'top-right');
    await expect(logo(page)).toHaveAttribute('aria-expanded', 'false'); expect(await page.evaluate(() => scrollY)).toBe(0);
  });
  test('rotation really pivots the device, reverses continuously and keeps the live page upright',async({page})=>{
    fixture=await devFixture();await page.setViewportSize({width:1440,height:1000});await page.goto(fixture.url+'/docs/pages');
    await logo(page).click();await tools(page).getByRole('button',{name:'Phone',exact:true}).click();
    const preview=tools(page).getByRole('dialog',{name:'Device preview'}),wrap=preview.locator('.wb-frame-wrap'),frame=page.frameLocator('prnext-dev-tools iframe');
    await expect(frame.getByTestId('counter')).toBeVisible();await frame.getByTestId('counter').click();const origin=await frame.locator('body').evaluate(()=>performance.timeOrigin);
    const motionAt=progress=>wrap.evaluate(async(node,progress)=>{
      node.closest('dialog').querySelector('button[aria-label="Rotate"]').click();
      const motion=node.getAnimations().find(animation=>animation.effect.getKeyframes().some(keyframe=>keyframe.transform));
      if(!motion)throw Error('Rotate did not create a transform animation');node.__qaRotation=motion;motion.pause();motion.currentTime=Number(motion.effect.getTiming().duration)*progress;
      await new Promise(resolve=>requestAnimationFrame(resolve));const matrix=new DOMMatrixReadOnly(getComputedStyle(node).transform),bounds=node.getBoundingClientRect(),stage=node.parentElement.getBoundingClientRect();
      return{angle:Math.atan2(matrix.b,matrix.a)*180/Math.PI,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},stage:{x:stage.x,y:stage.y,width:stage.width,height:stage.height},keyframes:motion.effect.getKeyframes().length};
    },progress);
    const finish=async()=>{await wrap.evaluate(node=>node.__qaRotation.finish());await expect.poll(()=>wrap.evaluate(node=>getComputedStyle(node).transform)).toBe('none');};
    const assertLive=async(width,height)=>{expect(await frame.locator('body').evaluate(()=>({width:innerWidth,height:innerHeight,origin:performance.timeOrigin}))).toEqual({width,height,origin});await expect(frame.getByTestId('counter')).toHaveText('Original 1');const matrix=await preview.locator('iframe').evaluate(node=>{const m=new DOMMatrixReadOnly(getComputedStyle(node).transform);return{a:m.a,b:m.b,c:m.c,d:m.d};});expect(matrix.a).toBeGreaterThan(0);expect(matrix.d).toBeGreaterThan(0);expect(matrix.b).toBe(0);expect(matrix.c).toBe(0);};
    const inside=snapshot=>{expect(snapshot.bounds.x).toBeGreaterThanOrEqual(snapshot.stage.x-1);expect(snapshot.bounds.y).toBeGreaterThanOrEqual(snapshot.stage.y-1);expect(snapshot.bounds.x+snapshot.bounds.width).toBeLessThanOrEqual(snapshot.stage.x+snapshot.stage.width+1);expect(snapshot.bounds.y+snapshot.bounds.height).toBeLessThanOrEqual(snapshot.stage.y+snapshot.stage.height+1);};
    for(const[device,width,height]of[['Phone',390,844],['Tablet',768,1024]]){
      await preview.getByRole('button',{name:device,exact:true}).click();await expect.poll(()=>wrap.evaluate(node=>node.getAnimations().length)).toBe(0);
      const start=await motionAt(0);expect(start.angle).toBeCloseTo(90,2);expect(start.keyframes).toBeGreaterThan(2);inside(start);await assertLive(height,width);
      const middle=await wrap.evaluate(async node=>{node.__qaRotation.currentTime=Number(node.__qaRotation.effect.getTiming().duration)*.25;await new Promise(resolve=>requestAnimationFrame(resolve));const m=new DOMMatrixReadOnly(getComputedStyle(node).transform),b=node.getBoundingClientRect(),s=node.parentElement.getBoundingClientRect();return{angle:Math.atan2(m.b,m.a)*180/Math.PI,bounds:{x:b.x,y:b.y,width:b.width,height:b.height},stage:{x:s.x,y:s.y,width:s.width,height:s.height}};});expect(middle.angle).toBeGreaterThan(1);expect(middle.angle).toBeLessThan(89);inside(middle);await finish();await assertLive(height,width);
      const back=await motionAt(0);expect(back.angle).toBeCloseTo(-90,2);inside(back);await finish();await assertLive(width,height);
    }
    const before=await motionAt(.25),after=await motionAt(0);for(const key of['x','y','width','height'])expect(Math.abs(after.bounds[key]-before.bounds[key])).toBeLessThan(1);await finish();await assertLive(768,1024);
    await preview.getByRole('button',{name:'Device frame',exact:true}).click();const frameless=await motionAt(0);expect(frameless.angle).toBeCloseTo(90,2);inside(frameless);await finish();await assertLive(1024,768);
    await page.emulateMedia({reducedMotion:'reduce'});await preview.getByRole('button',{name:'Rotate',exact:true}).click();expect(await wrap.evaluate(node=>node.getAnimations().length)).toBe(0);expect(await wrap.evaluate(node=>getComputedStyle(node).transform)).toBe('none');await assertLive(768,1024);
    await page.emulateMedia({reducedMotion:'no-preference'});await motionAt(.25);await wrap.evaluate(node=>window.__cancelledRotation=node.__qaRotation);await preview.getByRole('button',{name:'Desktop',exact:true}).click();expect(await page.evaluate(()=>window.__cancelledRotation.playState)).toBe('idle');expect(await wrap.evaluate(node=>getComputedStyle(node).transform)).toBe('none');
    await preview.getByRole('button',{name:'Phone',exact:true}).click();await motionAt(.25);await wrap.evaluate(node=>window.__cancelledRotation=node.__qaRotation);await preview.getByRole('button',{name:'Close device preview'}).click();await expect.poll(()=>page.evaluate(()=>window.__cancelledRotation.playState)).toBe('idle');await expect(preview).toBeHidden();
    await logo(page).click();await tools(page).getByRole('button',{name:'Phone',exact:true}).click();await expect(frame.getByTestId('counter')).toBeVisible();await motionAt(.25);await wrap.evaluate(node=>window.__cancelledRotation=node.__qaRotation);await page.evaluate(()=>window.__PRNEXT_DEV__.indicator.dispose());expect(await page.evaluate(()=>window.__cancelledRotation.playState)).toBe('idle');await expect(tools(page)).toHaveCount(0);
  });
  test('frames toggle without reloading, keep real viewports and transfer through detach and dock', async ({ page }) => {
    fixture = await devFixture({files:scrollFiles}); await page.goto(fixture.url + '/docs/app');
    await logo(page).click(); await tools(page).getByRole('button', { name: 'Phone', exact: true }).click();
    const preview = tools(page).getByRole('dialog', { name: 'Device preview' }), frame = page.frameLocator('prnext-dev-tools iframe');
    await expect(frame.getByTestId('counter')).toBeVisible(); await frame.getByTestId('counter').click();
    const hud = preview.getByRole('button', { name: 'Device frame', exact: true });
    for (const device of ['Phone', 'Tablet', 'Desktop']) {
      await preview.getByRole('button', { name: device, exact: true }).click();
      await scrollbarPolicy(frame,device!=='Desktop');await screenGeometry(preview);
      const dimensions = await frame.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (device === 'Phone') expect(dimensions.width).toBe(390);
      if (device === 'Tablet') expect(dimensions.width).toBe(768);
      await expect(hud).toHaveAttribute('aria-pressed', 'true');
      await hud.click(); await expect(preview.locator('.wb-device-top')).toBeHidden();
      await scrollbarPolicy(frame,device!=='Desktop');await screenGeometry(preview);expect(await preview.locator('.wb-screen').evaluate(node=>getComputedStyle(node).borderRadius)).toBe('0px');
      if (device !== 'Desktop') expect(await frame.locator('body').evaluate(() => innerWidth)).toBe(dimensions.width);
      await expect(frame.getByTestId('counter')).toHaveText('Original 1');
      await hud.click(); await expect(preview.locator('.wb-device-top')).toBeVisible();
    }
    await preview.getByRole('button', { name: 'Tablet', exact: true }).click(); await hud.click();
    const opened = page.waitForEvent('popup'); await preview.getByRole('button', { name: 'Open device preview in new window' }).click();
    const popup = await opened, detached = popup.getByRole('dialog', { name: 'Device preview' });
    const popupFrame=popup.frameLocator('prnext-dev-window iframe');await scrollbarPolicy(popupFrame,true);await screenGeometry(detached);expect(await popupFrame.locator('body').evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual({width:768,height:1024});
    await expect(detached.getByRole('button', { name: 'Device frame' })).toHaveAttribute('aria-pressed', 'false');
    await expect(detached.locator('.wb-device-top')).toBeHidden();
    await detached.getByRole('button', { name: 'Dock device preview' }).click(); await expect.poll(() => popup.isClosed()).toBe(true);
    await scrollbarPolicy(frame,true);await screenGeometry(preview);
    await expect(hud).toHaveAttribute('aria-pressed', 'false');
    await preview.getByRole('button', { name: 'Close device preview' }).click(); await page.reload(); await logo(page).click();
    await tools(page).getByRole('button', { name: 'Phone', exact: true }).click();
    await scrollbarPolicy(frame,true);
    await expect(hud).toHaveAttribute('aria-pressed', 'false');
    expect(await preview.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(8, 8, 8)');
  });
  test('mobile scrollbar styling stays local while wheel, keyboard, navigation and reload keep working',async({page})=>{
    fixture=await devFixture({files:scrollFiles});await page.goto(fixture.url+'/docs/pages');await scrollbarPolicy(page,false);const original=await documentStyles(page);await page.getByTestId('counter').click();await logo(page).click();await tools(page).getByRole('button',{name:'Phone',exact:true}).click();const preview=tools(page).getByRole('dialog',{name:'Device preview'}),frame=page.frameLocator('prnext-dev-tools iframe');await scrollbarPolicy(frame,true);await screenGeometry(preview);
    const viewport=()=>frame.locator('body').evaluate(()=>({width:innerWidth,height:innerHeight}));expect(await viewport()).toEqual({width:390,height:844});await frame.getByTestId('counter').click();
    const bounds=await preview.locator('iframe').boundingBox();await page.mouse.move(bounds.x+bounds.width-20,bounds.y+bounds.height/2);await page.mouse.wheel(0,500);await expect.poll(()=>frame.locator('html').evaluate(()=>scrollY)).toBeGreaterThan(0);const before=await frame.locator('html').evaluate(()=>scrollY);await frame.locator('#scroll-main').evaluate(node=>node.focus({preventScroll:true}));await page.keyboard.press('PageDown');await expect.poll(()=>frame.locator('html').evaluate(()=>scrollY)).toBeGreaterThan(before);await frame.locator('.nested-scroll').focus();await page.keyboard.press('PageDown');await expect.poll(()=>frame.locator('.nested-scroll').evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
    const hud=preview.getByRole('button',{name:'Device frame',exact:true});await hud.click();await scrollbarPolicy(frame,true);await screenGeometry(preview);expect(await viewport()).toEqual({width:390,height:844});await hud.click();await preview.getByRole('button',{name:'Rotate',exact:true}).click();await scrollbarPolicy(frame,true);await screenGeometry(preview);expect(await viewport()).toEqual({width:844,height:390});await preview.getByRole('button',{name:'Tablet',exact:true}).click();await scrollbarPolicy(frame,true);expect(await viewport()).toEqual({width:768,height:1024});await preview.getByRole('button',{name:'Desktop',exact:true}).click();await scrollbarPolicy(frame,false);await screenGeometry(preview);await expect(frame.getByTestId('counter')).toHaveText('Original 1');
    await preview.getByRole('button',{name:'Phone',exact:true}).click();await frame.getByRole('link',{name:'Next preview page'}).click();await expect(frame.getByRole('heading',{name:'Next scroll page'})).toBeVisible();await scrollbarPolicy(frame,true);expect(await viewport()).toEqual({width:390,height:844});const prior=await frame.locator('html').evaluate(()=>performance.timeOrigin);await preview.getByRole('button',{name:'Reload preview',exact:true}).click();await expect(frame.getByRole('heading',{name:'Scroll page',exact:true})).toBeVisible();await expect.poll(()=>frame.locator('html').evaluate(()=>performance.timeOrigin)).not.toBe(prior);await scrollbarPolicy(frame,true);expect(await viewport()).toEqual({width:390,height:844});await screenGeometry(preview);
    await preview.getByRole('button',{name:'Close device preview'}).click();expect(await documentStyles(page)).toEqual(original);await expect(page.getByTestId('counter')).toHaveText('Original 1');expect(await page.evaluate(()=>scrollY)).toBe(0);
  });
  test('device and preview tooltips support hover, keyboard and small detached windows without clipping',async({page})=>{
    fixture=await devFixture();await page.setViewportSize({width:1440,height:1000});await page.goto(fixture.url+'/docs/pages');await logo(page).click();await tools(page).getByRole('button',{name:'Phone',exact:true}).click();
    const host=tools(page),preview=host.getByRole('dialog',{name:'Device preview'}),tooltip=host.locator('.wb-tooltip');await expect(page.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();await expect(tooltip).toHaveCount(1);
    const checkBounds=async(tip,owner)=>{await expect(tip).toBeVisible();await expect(tip).toHaveAttribute('data-open','true');await expect.poll(()=>tip.evaluate(node=>getComputedStyle(node).opacity)).toBe('1');const bounds=await tip.boundingBox(),size=owner.viewportSize();expect(bounds.x).toBeGreaterThanOrEqual(7);expect(bounds.y).toBeGreaterThanOrEqual(7);expect(bounds.x+bounds.width).toBeLessThanOrEqual(size.width-7);expect(bounds.y+bounds.height).toBeLessThanOrEqual(size.height-7);expect(await tip.evaluate(node=>node.matches(':popover-open'))).toBe(true);};
    for(const[name,text,detail]of[['Phone','Phone','390 × 844'],['Tablet','Tablet','768 × 1024'],['Desktop','Desktop'],['Rotate','Rotate device'],['Reload preview','Refresh preview'],['Open device preview in new window','Open in window'],['Close device preview','Close preview'],['Device frame','Hide device frame'],['Console','Console']]){
      const target=preview.getByRole('button',{name,exact:true});expect(await target.getAttribute('title')).toBeNull();await target.hover();await expect(tooltip.locator('.wb-tooltip-label')).toHaveText(text);if(detail)await expect(tooltip.locator('.wb-tooltip-detail')).toHaveText(detail);await checkBounds(tooltip,page);const id=await tooltip.getAttribute('id');await expect(target).toHaveAttribute('aria-describedby',id);
    }
    await page.mouse.move(1400,950);await expect(tooltip).toBeHidden();await page.keyboard.press('Tab');const phone=preview.getByRole('button',{name:'Phone',exact:true});await phone.focus();await expect(tooltip.locator('.wb-tooltip-label')).toHaveText('Phone');await checkBounds(tooltip,page);await phone.hover();await page.mouse.move(1400,950);await page.waitForTimeout(250);await checkBounds(tooltip,page);await phone.hover();await preview.getByRole('slider',{name:'Preview width'}).focus();await page.waitForTimeout(250);await expect(tooltip.locator('.wb-tooltip-label')).toHaveText('Phone');await checkBounds(tooltip,page);await page.keyboard.press('Escape');await expect(tooltip).toBeHidden();await expect(preview).toBeVisible();
    await page.mouse.move(1400,950);await phone.evaluate(node=>node.setAttribute('aria-describedby','existing-help'));await phone.focus();await expect(tooltip.locator('.wb-tooltip-label')).toHaveText('Phone');await checkBounds(tooltip,page);expect((await phone.getAttribute('aria-describedby')).split(' ')).toContain('existing-help');await page.keyboard.press('Escape');await expect(tooltip).toBeHidden();await expect(preview).toBeVisible();await expect(phone).toBeFocused();await expect(phone).toHaveAttribute('aria-describedby','existing-help');
    await phone.click();await expect(tooltip).toBeHidden();await page.waitForTimeout(350);await expect(tooltip).toBeHidden();await page.mouse.move(1400,950);await preview.getByRole('button',{name:'Rotate',exact:true}).click();await phone.hover();await expect(tooltip.locator('.wb-tooltip-detail')).toHaveText('844 × 390');await checkBounds(tooltip,page);
    for(const width of[390,320]){await page.setViewportSize({width,height:844});await expect(tooltip).toBeHidden();const close=preview.getByRole('button',{name:'Close device preview',exact:true});await close.hover();await expect(tooltip.locator('.wb-tooltip-label')).toHaveText('Close preview');await checkBounds(tooltip,page);await page.mouse.move(width-2,842);await expect(tooltip).toBeHidden();}
    await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Tab');await preview.getByRole('button',{name:'Reload preview',exact:true}).focus();await expect(tooltip.locator('.wb-tooltip-label')).toHaveText('Refresh preview');await checkBounds(tooltip,page);expect(await tooltip.evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');await page.keyboard.press('Escape');await expect(tooltip).toBeHidden();await expect(preview).toBeVisible();
    const opened=page.waitForEvent('popup');await preview.getByRole('button',{name:'Open device preview in new window'}).click();const popup=await opened;await popup.setViewportSize({width:320,height:640});const detached=popup.getByRole('dialog',{name:'Device preview'}),popupTip=popup.locator('prnext-dev-window .wb-tooltip');await expect(popup.frameLocator('prnext-dev-window iframe').getByTestId('counter')).toBeVisible();await expect(popupTip).toHaveCount(1);const dock=detached.getByRole('button',{name:'Dock device preview'});expect(await dock.getAttribute('title')).toBeNull();await dock.hover();await expect(popupTip.locator('.wb-tooltip-label')).toHaveText('Dock window');await checkBounds(popupTip,popup);await dock.click();await expect.poll(()=>popup.isClosed()).toBe(true);await expect(preview).toBeVisible();await expect(tooltip).toBeHidden();
    const touchContext=await page.context().browser().newContext({viewport:{width:320,height:720},isMobile:true,hasTouch:true});
    try{
      const touchPage=await touchContext.newPage();await touchPage.goto(fixture.url+'/docs/pages');const touchHost=tools(touchPage);await logo(touchPage).click();await touchHost.getByRole('button',{name:'Phone',exact:true}).click();const touchPreview=touchHost.getByRole('dialog',{name:'Device preview'});await expect(touchPage.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();const opened=touchPage.waitForEvent('popup');await touchPreview.getByRole('button',{name:'Open device preview in new window'}).click();const touchPopup=await opened;await touchPopup.setViewportSize({width:320,height:640});await expect.poll(()=>touchPopup.evaluate(()=>innerWidth)).toBe(320);const touchDock=touchPopup.getByRole('button',{name:'Dock device preview'}),touchTip=touchPopup.locator('prnext-dev-window .wb-tooltip');await touchPopup.keyboard.press('Tab');await touchDock.focus();await expect(touchTip.locator('.wb-tooltip-label')).toHaveText('Dock window');await checkBounds(touchTip,touchPopup);expect((await touchDock.boundingBox()).height).toBeGreaterThanOrEqual(44);await touchDock.click();await expect.poll(()=>touchPopup.isClosed()).toBe(true);await expect(touchPreview).toBeVisible();await expect(touchPage.frameLocator('prnext-dev-tools iframe').getByTestId('counter')).toBeVisible();expect(await touchPage.frameLocator('prnext-dev-tools iframe').locator('body').evaluate(()=>innerWidth)).toBe(390);
    }finally{await touchContext.close();}
    await preview.getByRole('button',{name:'Close device preview'}).hover();await checkBounds(tooltip,page);await preview.getByRole('button',{name:'Close device preview'}).click();await expect(tooltip).toBeHidden();await expect(preview).toBeHidden();await logo(page).click();await host.getByRole('button',{name:'Phone',exact:true}).click();await preview.getByRole('button',{name:'Rotate',exact:true}).hover();await expect(tooltip).toBeVisible();await tooltip.evaluate(node=>window.__qaTooltip=node);await page.evaluate(()=>window.__PRNEXT_DEV__.indicator.dispose());expect(await page.evaluate(()=>({connected:window.__qaTooltip.isConnected,open:window.__qaTooltip.matches(':popover-open')}))).toEqual({connected:false,open:false});await expect(host).toHaveCount(0);
  });
});
