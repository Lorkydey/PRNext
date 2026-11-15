import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';

const counter=`'use client';import{useState,useEffect}from'react';export default function Counter(){const[n,set]=useState(0);const[ready,mark]=useState(false);useEffect(()=>mark(true),[]);return <button style={{position:'fixed',left:'50%',top:'50%',transform:'translate(-50%,-50%)'}} data-testid="counter" data-ready={ready} onClick={()=>set(n+1)}>Count {n}</button>}`;
test.describe('Duo folding preview',()=>{
  test.setTimeout(90000);let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function open(page){
    fixture=await devFixture({files:{'components/Counter.jsx':counter}});await page.goto(fixture.url+'/docs/app');
    const host=page.locator('prnext-dev-tools');await host.locator('.trigger').click();await host.locator('#tools').getByRole('button',{name:'Duo',exact:true}).click();
    const preview=host.getByRole('dialog',{name:'Device preview',exact:true}),toolbar=preview.locator('.wb-preview-head'),frame=page.frameLocator('prnext-dev-tools iframe');
    await expect(frame.getByTestId('counter')).toHaveAttribute('data-ready','true');
    await expect(host.locator('#tools')).toBeVisible();await expect(host.locator('.trigger')).toHaveAttribute('aria-expanded','true');
    return {host,preview,toolbar,frame,wrap:preview.locator('.wb-frame-wrap')};
  }
  const viewport=frame=>frame.locator('body').evaluate(()=>[innerWidth,innerHeight]);
  async function idle(wrap){await expect(wrap).not.toHaveAttribute('data-fold-animating','true');}
  for(const width of [1440,390])test(`folds, unfolds and rotates one persistent viewport at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});const {host,preview,toolbar,frame,wrap}=await open(page);
    expect(await viewport(frame)).toEqual([890,626]);await expect(preview.locator('.wb-duo-shell')).toBeVisible();await expect(preview.locator('.wb-duo-gap,.wb-duo-spine,.wb-duo-second')).toHaveCount(0);
    const centerReachesFrame=await wrap.evaluate(node=>{const screen=node.querySelector('.wb-screen').getBoundingClientRect();return node.getRootNode().elementFromPoint(screen.x+screen.width/2,screen.y+screen.height/2)===node.querySelector('iframe');});expect(centerReachesFrame).toBe(true);
    const origin=await frame.locator('body').evaluate(()=>performance.timeOrigin);await frame.getByTestId('counter').click();await expect(frame.getByTestId('counter')).toHaveText('Count 1');
    await toolbar.getByRole('button',{name:'Fold device',exact:true}).click();await expect(wrap).toHaveAttribute('data-fold-animating','true');
    expect(await wrap.evaluate(node=>node.getAnimations({subtree:true}).some(animation=>animation.playState==='running'))).toBe(true);
    await idle(wrap);expect(await viewport(frame)).toEqual([466,678]);await expect(preview.locator('.wb-duo-crease')).toBeHidden();await expect(frame.getByTestId('counter')).toHaveText('Count 1');
    await toolbar.getByRole('button',{name:'Rotate',exact:true}).click();expect(await viewport(frame)).toEqual([678,466]);
    await toolbar.getByRole('button',{name:'Unfold device',exact:true}).click();await idle(wrap);expect(await viewport(frame)).toEqual([626,890]);
    await expect(frame.getByTestId('counter')).toHaveText('Count 1');expect(await frame.locator('body').evaluate(()=>performance.timeOrigin)).toBe(origin);await expect(preview.locator('iframe')).toHaveCount(1);
    const bounds=await preview.locator('.wb-stage').boundingBox(),body=await wrap.boundingBox();expect(body.x).toBeGreaterThanOrEqual(bounds.x);expect(body.y).toBeGreaterThanOrEqual(bounds.y);expect(body.x+body.width).toBeLessThanOrEqual(bounds.x+bounds.width+1);expect(body.y+body.height).toBeLessThanOrEqual(bounds.y+bounds.height+1);
    await toolbar.getByRole('button',{name:'Phone',exact:true}).click();await expect(preview.locator('.wb-duo-layer')).toBeHidden();expect(await viewport(frame)).toEqual([390,844]);await expect(host.locator('.trigger')).toBeVisible();
  });
  test('rapid reversals preserve position and cleanup restores the live iframe',async({page})=>{
    const {preview,toolbar,wrap,frame}=await open(page);await toolbar.getByRole('button',{name:'Fold device',exact:true}).click();
    const continuity=await wrap.evaluate(node=>{
      for(const animation of node.getAnimations({subtree:true})){animation.pause();animation.currentTime=Number(animation.effect.getTiming().duration)*.4;}
      const first=node.querySelector('.wb-duo-panel'),before=first.getBoundingClientRect();
      node.closest('dialog').querySelector('[aria-label="Unfold device"]').click();const after=first.getBoundingClientRect();
      return {x:Math.abs(before.x-after.x),y:Math.abs(before.y-after.y),width:Math.abs(before.width-after.width),height:Math.abs(before.height-after.height)};
    });
    expect(continuity.x).toBeLessThan(1);expect(continuity.y).toBeLessThan(1);expect(continuity.width).toBeLessThan(1);expect(continuity.height).toBeLessThan(1);
    await idle(wrap);expect(await viewport(frame)).toEqual([890,626]);await expect(preview.locator('.wb-duo-leaf')).toBeHidden();
    await toolbar.getByRole('button',{name:'Fold device',exact:true}).click();await page.setViewportSize({width:320,height:640});await idle(wrap);expect(await viewport(frame)).toEqual([466,678]);
    await toolbar.getByRole('button',{name:'Close device preview',exact:true}).click();await expect(preview).toBeHidden();
  });
  test('keyboard, reduced motion, frame toggle and source access work in the folded preview',async({page})=>{
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.addInitScript(()=>{window.__duoEditor=[];const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(...args){if(/^(vscode|cursor):\/\/file\//.test(this.href)){window.__duoEditor.push(this.href);return;}return click.apply(this,args);};});
    const {preview,toolbar,frame,wrap}=await open(page);const fold=toolbar.getByRole('button',{name:'Fold device',exact:true});await fold.focus();await page.keyboard.press('Enter');
    expect(await viewport(frame)).toEqual([466,678]);await expect(wrap).not.toHaveAttribute('data-fold-animating','true');expect(await wrap.evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(0);
    await frame.locator('body').evaluate(()=>dispatchEvent(new CustomEvent('prnext:devtools:open-file',{detail:{file:'components/Counter.jsx'},cancelable:true})));
    await expect.poll(()=>page.evaluate(()=>window.__duoEditor.length)).toBe(1);expect(decodeURIComponent(await page.evaluate(()=>window.__duoEditor[0]))).toContain('/components/Counter.jsx:1:1');
    await toolbar.getByRole('button',{name:'Device frame',exact:true}).click();await expect(preview.locator('.wb-duo-layer')).toBeHidden();await toolbar.getByRole('button',{name:'Unfold device',exact:true}).click();expect(await viewport(frame)).toEqual([890,626]);
    await toolbar.getByRole('button',{name:'Device frame',exact:true}).click();await expect(preview.locator('.wb-duo-shell')).toBeVisible();
  });
  test('detaching and docking retain the folded orientation',async({page})=>{
    await page.emulateMedia({reducedMotion:'reduce'});const {preview,toolbar,frame}=await open(page);
    await toolbar.getByRole('button',{name:'Fold device',exact:true}).click();await toolbar.getByRole('button',{name:'Rotate',exact:true}).click();expect(await viewport(frame)).toEqual([678,466]);
    const opened=page.waitForEvent('popup');await toolbar.getByRole('button',{name:'Open device preview in new window',exact:true}).click();const popup=await opened;
    const detached=popup.locator('prnext-dev-window').getByRole('dialog',{name:'Device preview',exact:true}),child=popup.frameLocator('prnext-dev-window iframe');await expect(child.getByTestId('counter')).toHaveAttribute('data-ready','true');expect(await viewport(child)).toEqual([678,466]);
    await expect(detached.locator('.wb-preview-head').getByRole('button',{name:'Duo',exact:true})).toBeFocused();
    await detached.locator('.wb-preview-head').getByRole('button',{name:'Dock device preview',exact:true}).click();await expect(preview).toBeVisible();await expect(frame.getByTestId('counter')).toHaveAttribute('data-ready','true');expect(await viewport(frame)).toEqual([678,466]);
  });
  for(const rotated of [false,true])test(`closes inward and presents the live outer display on the reverse face${rotated?' after rotation':''}`,async({page})=>{
    const {toolbar,frame,wrap}=await open(page);if(rotated){await toolbar.getByRole('button',{name:'Rotate',exact:true}).click();await wrap.evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});}
    const origin=await frame.locator('body').evaluate(()=>performance.timeOrigin);await frame.getByTestId('counter').click();
    const seek=async fraction=>{await wrap.evaluate((node,t)=>{for(const a of node.getAnimations({subtree:true})){a.pause();a.effect.updateTiming({easing:'linear'});a.currentTime=Number(a.effect.getTiming().duration)*t;}},fraction);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
    await toolbar.getByRole('button',{name:'Fold device',exact:true}).click();await seek(.25);
    const hinge=await wrap.evaluate((node,isRotated)=>{const shell=getComputedStyle(node.querySelector('.wb-duo-shell')),inner=getComputedStyle(node.querySelector('.wb-duo-inner-face')),glass=getComputedStyle(node.querySelector('.wb-duo-inner-face .wb-duo-glass'));return {stationaryBorder:isRotated?shell.borderBottomWidth:shell.borderRightWidth,movingBorder:isRotated?inner.borderTopWidth:inner.borderLeftWidth,glassInset:isRotated?glass.top:glass.left,crease:getComputedStyle(node.querySelector('.wb-duo-crease')).display};},rotated);
    expect(hinge).toEqual({stationaryBorder:'0px',movingBorder:'0px',glassInset:'0px',crease:'none'});
    const depth=await wrap.locator('.wb-duo-leaf').evaluate(node=>new DOMMatrixReadOnly(getComputedStyle(node).transform).transformPoint(new DOMPoint(100,100,0)).z);expect(depth).toBeGreaterThan(40);
    expect(await viewport(frame)).toEqual(rotated?[626,890]:[890,626]);
    await seek(.8);expect(await viewport(frame)).toEqual(rotated?[678,466]:[466,678]);
    const face=await wrap.locator('.wb-duo-cover-face').boundingBox(),surface=await wrap.locator('.wb-screen').boundingBox();
    expect(Number(await wrap.locator('.wb-screen').evaluate(node=>getComputedStyle(node).opacity))).toBeGreaterThan(.9);
    expect(surface.width).toBeGreaterThan(0);expect(surface.height).toBeGreaterThan(0);expect(surface.x).toBeGreaterThanOrEqual(face.x-2);expect(surface.y).toBeGreaterThanOrEqual(face.y-2);expect(surface.x+surface.width).toBeLessThanOrEqual(face.x+face.width+2);expect(surface.y+surface.height).toBeLessThanOrEqual(face.y+face.height+2);
    const stage=await wrap.locator('..').boundingBox(),leaf=await wrap.locator('.wb-duo-leaf').boundingBox();expect(leaf.x).toBeGreaterThanOrEqual(stage.x);expect(leaf.y).toBeGreaterThanOrEqual(stage.y);expect(leaf.x+leaf.width).toBeLessThanOrEqual(stage.x+stage.width);expect(leaf.y+leaf.height).toBeLessThanOrEqual(stage.y+stage.height);
    await wrap.evaluate(node=>{for(const a of node.getAnimations({subtree:true}))a.play();});await idle(wrap);await expect(frame.getByTestId('counter')).toHaveText('Count 1');expect(await frame.locator('body').evaluate(()=>performance.timeOrigin)).toBe(origin);
    await toolbar.getByRole('button',{name:'Unfold device',exact:true}).click();await seek(.75);expect(await viewport(frame)).toEqual(rotated?[626,890]:[890,626]);
    await seek(.98);const reveal=await wrap.locator('.wb-screen').evaluate((node,isRotated)=>{const style=getComputedStyle(node),insets=style.clipPath.match(/[\d.]+px/g).map(value=>parseFloat(value));return {clip:isRotated?insets[2]:insets[1],size:parseFloat(isRotated?style.height:style.width)};},rotated);expect(reveal.clip).toBeLessThan(reveal.size/4);
    await wrap.evaluate(node=>{for(const a of node.getAnimations({subtree:true}))a.play();});await idle(wrap);await expect(frame.getByTestId('counter')).toHaveText('Count 1');
  });
});
