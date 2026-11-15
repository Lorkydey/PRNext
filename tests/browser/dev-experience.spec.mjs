import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {devFixture} from '../dev-fixture.mjs';

const counter=`'use client';import{useState,useEffect}from'react';import styles from'./counter.module.css';export default function Counter(){const[n,setN]=useState(0),[ready,setReady]=useState(false);useEffect(()=>setReady(true),[]);return <><button data-testid="counter" data-ready={ready} className={styles.counter} onClick={()=>setN(n+1)}>Count {n}</button><input aria-label="Draft" defaultValue=""/></>}`;
const css='html,body{margin:0;background:rgb(12,34,56)}header{position:fixed;top:0;left:0;width:100%;height:40px;background:rgb(20,190,70);z-index:20}footer{position:fixed;bottom:0;left:0;width:100%;height:32px;background:rgb(240,210,30);z-index:20}.first{height:400px;background:rgb(220,40,40)}.second{height:1400px;background:rgb(30,70,220)}';
test.describe('remembered tools, PNG export and hot reload',()=>{
  test.setTimeout(100000);let fixture;
  test.afterEach(async()=>{await fixture?.close();fixture=undefined;});
  async function start(page,files={}){fixture=await devFixture({files:{'components/Counter.jsx':counter,...files}});await page.goto(fixture.url+'/docs/app');await expect(page.getByTestId('counter')).toHaveAttribute('data-ready','true');return page.locator('prnext-dev-tools');}
  async function menu(host){await host.getByRole('button',{name:/Open PRNext developer tools/}).click();}
  async function phone(host){await menu(host);await host.locator('#tools').getByRole('button',{name:'Phone',exact:true}).click();return host.getByRole('dialog',{name:'Device preview'});}

  for(const owned of [false,true])test(`CSS refresh preserves app state and React root attributes (${owned?'app-owned':'absent'} marker)`,async({page})=>{
    const messages=[];page.on('console',message=>{if(/hydrat|didn.t match/i.test(message.text()))messages.push(message.text());});
    await start(page,{'app/layout.jsx':`export default function Layout({children}){return <html${owned?' data-prnext-dev-build="app-owned"':''}><body>{children}</body></html>}`});
    await page.getByTestId('counter').click();await page.getByRole('textbox',{name:'Draft'}).fill('keep my draft');await page.getByRole('textbox',{name:'Draft'}).focus();
    const origin=await page.evaluate(()=>performance.timeOrigin),attrs=await page.locator('html').evaluate(node=>[...node.attributes].map(a=>[a.name,a.value]));
    for(const color of ['rgb(100, 20, 30)','rgb(40, 150, 60)','rgb(20, 60, 180)']){
      await fixture.write('components/counter.module.css',`.counter{color:${color}}`);
      await expect(page.getByTestId('counter')).toHaveCSS('color',color,{timeout:25000});
      await expect.poll(()=>page.evaluate(()=>window.__PRNEXT_DEV__?.confirmed)).toBe(true);
      await expect(page.getByTestId('counter')).toHaveText('Count 1');await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('keep my draft');await expect(page.getByRole('textbox',{name:'Draft'})).toBeFocused();
      expect(await page.locator('html').evaluate(node=>[...node.attributes].map(a=>[a.name,a.value]))).toEqual(attrs);expect(await page.evaluate(()=>performance.timeOrigin)).toBe(origin);
    }
    expect(messages).toEqual([]);
  });

  test('console filters and window geometry, device pose and frame return after reload',async({page})=>{
    await page.setViewportSize({width:1440,height:1000});let host=await start(page);await menu(host);await host.locator('#tools').getByRole('button',{name:'Client console',exact:true}).click();
    let panel=host.getByRole('dialog',{name:'Client console',exact:true});await panel.getByLabel('Console level',{exact:true}).selectOption('warn');await panel.getByLabel('Console source',{exact:true}).selectOption('browser');await panel.getByRole('searchbox').fill('private search');
    await panel.locator('.wb-head').focus();await page.keyboard.press('Alt+ArrowUp');await page.keyboard.press('Alt+Shift+ArrowRight');const bounds=await panel.boundingBox();
    await panel.getByRole('button',{name:'Close console',exact:true}).click();await menu(host);await host.locator('#tools').getByRole('button',{name:'Duo',exact:true}).click();let preview=host.getByRole('dialog',{name:'Device preview'});
    await preview.getByRole('button',{name:'Fold device',exact:true}).click();await preview.getByRole('button',{name:'Rotate',exact:true}).click();await preview.getByRole('button',{name:'Device frame',exact:true}).click();
    const dimensions=await preview.locator('.wb-dimensions').textContent();await page.reload();host=page.locator('prnext-dev-tools');await menu(host);await host.locator('#tools').getByRole('button',{name:'Duo',exact:true}).click();preview=host.getByRole('dialog',{name:'Device preview'});
    await expect(preview.locator('.wb-dimensions')).toHaveText(dimensions);await expect(preview.getByRole('button',{name:'Unfold device',exact:true})).toHaveAttribute('aria-pressed','true');await expect(preview.getByRole('button',{name:'Device frame',exact:true})).toHaveAttribute('aria-pressed','false');
    await preview.getByRole('button',{name:'Close device preview',exact:true}).click();await menu(host);await host.locator('#tools').getByRole('button',{name:'Client console',exact:true}).click();panel=host.getByRole('dialog',{name:'Client console',exact:true});
    await expect(panel.getByLabel('Console level',{exact:true})).toHaveValue('warn');await expect(panel.getByLabel('Console source',{exact:true})).toHaveValue('browser');await expect(panel.getByRole('searchbox')).toHaveValue('');
    await panel.evaluate(async node=>{await Promise.all(node.getAnimations().map(a=>a.finished));});expect(await panel.boundingBox()).toEqual(bounds);
    const stored=await page.evaluate(()=>localStorage.getItem('prnext:dev-tools:v1'));expect(stored).not.toContain('private search');
    await page.setViewportSize({width:320,height:640});await expect.poll(async()=>{const small=await panel.boundingBox();return small.x>=0&&small.x+small.width<=320;}).toBe(true);
  });

  test('PNG captures scrolled viewport and fixed elements, respects Frame and recovers after embedded-content failure',async({page})=>{
    const host=await start(page,{'app/app/page.jsx':`import Counter from'../../components/Counter';import './export.css';export default function Page(){return <><header/><div className="first"><Counter/></div><div className="second"/><footer/></>}`,'app/app/export.css':css});
    const preview=await phone(host),child=page.frameLocator('prnext-dev-tools iframe');await expect(child.getByTestId('counter')).toHaveAttribute('data-ready','true');
    await child.locator('body').evaluate(()=>scrollTo(0,500));await expect.poll(()=>child.locator('body').evaluate(()=>scrollY)).toBe(500);
    await preview.getByRole('button',{name:'Device frame',exact:true}).click();
    async function capture(){const downloadPromise=page.waitForEvent('download');await preview.getByRole('button',{name:'Export preview as PNG',exact:true}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toMatch(/^prnext-phone-390x844\.png$/);const data=await readFile(await download.path());return page.evaluate(async base64=>{const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {width:image.width,height:image.height,pixels:[20,100,image.height-15].map(y=>[...ctx.getImageData(100,y,1,1).data])};},data.toString('base64'));}
    const plain=await capture();expect(plain).toEqual({width:390,height:844,pixels:[[20,190,70,255],[30,70,220,255],[240,210,30,255]]});
    await preview.getByRole('button',{name:'Device frame',exact:true}).click();const framed=await capture();expect(framed.width).toBeGreaterThan(390);expect(framed.height).toBeGreaterThan(844);expect(await child.locator('body').evaluate(()=>scrollY)).toBe(500);
    await child.locator('body').evaluate(()=>{const frame=document.createElement('iframe');frame.id='export-blocked';frame.style.cssText='position:fixed;top:50px;left:0;width:100px;height:100px';document.body.append(frame);});
    await preview.getByRole('button',{name:'Export preview as PNG',exact:true}).click();await expect(preview.locator('.wb-preview-note')).toContainText('Visible embedded frames');await expect(preview.getByRole('button',{name:'Export preview as PNG',exact:true})).toBeEnabled();
    await child.locator('#export-blocked').evaluate(node=>node.remove());await capture();await expect(preview.locator('.wb-preview-note')).toHaveText('PNG downloaded.');
  });

  test('PNG uses tablet and both Duo viewports without reloading the live app',async({page})=>{
    const host=await start(page),preview=await phone(host),child=page.frameLocator('prnext-dev-tools iframe');await expect(child.getByTestId('counter')).toHaveAttribute('data-ready','true');await child.getByTestId('counter').click();const origin=await child.locator('body').evaluate(()=>performance.timeOrigin);
    await preview.getByRole('button',{name:'Device frame',exact:true}).click();
    async function capture(width,height){const downloaded=page.waitForEvent('download');await preview.getByRole('button',{name:'Export preview as PNG',exact:true}).click();const download=await downloaded,data=await readFile(await download.path());expect(data.subarray(1,4).toString()).toBe('PNG');expect(data.readUInt32BE(16)).toBe(width);expect(data.readUInt32BE(20)).toBe(height);await expect(child.getByTestId('counter')).toHaveText('Count 1');expect(await child.locator('body').evaluate(()=>performance.timeOrigin)).toBe(origin);}
    await preview.locator('.wb-devices').getByRole('button',{name:'Tablet',exact:true}).click();await capture(768,1024);
    await preview.locator('.wb-devices').getByRole('button',{name:'Duo',exact:true}).click();await capture(890,626);
    await preview.getByRole('button',{name:'Device frame',exact:true}).click();await preview.getByRole('button',{name:'Fold device',exact:true}).click();await capture(490,702);
    await preview.getByRole('button',{name:'Rotate',exact:true}).click();await capture(702,490);
  });
});
