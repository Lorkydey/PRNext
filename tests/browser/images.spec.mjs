import { test, expect } from '@playwright/test';
import { imagesFixture } from '../images-fixture.mjs';
import { startServer } from '../support.mjs';
test.describe('Optimized images',()=>{
  let fixture,server;
  test.beforeAll(async()=>{fixture=await imagesFixture();await fixture.build();server=await startServer(fixture.root,['--workers','1']);});
  test.afterAll(async()=>{await server?.close();await fixture?.remove();});
  for (const route of ['broken-image', 'broken-image-app']) test(`${route}: a 404 before hydration calls only onError and removes its placeholder`, async ({ page }) => {
    let release;
    const hydration = new Promise(resolve => { release = resolve; });
    await page.route('**/_prnext/assets/**', async route => {
      if (route.request().resourceType() === 'script') await hydration;
      await route.continue();
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const failed = page.waitForResponse(response => response.url().endsWith('/missing-before-hydration.png') && response.status() === 404);
    try {
      await page.goto(server.url + '/docs/' + route, { waitUntil: 'commit' });
      await failed;
      const image = page.getByTestId('broken-image');
      await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth === 0)).toBe(true);
      expect(await page.evaluate(() => window.__brokenImageHydrated)).toBeUndefined();
      await expect(page.getByTestId('broken-events')).toHaveText('');
      await expect(image).not.toHaveCSS('background-image', 'none');
      release();
      await page.waitForFunction(() => window.__brokenImageHydrated);
      await expect(page.getByTestId('broken-events')).toHaveText('error:error');
      await expect(image).toHaveCSS('background-image', 'none');
      await expect(image).toHaveCSS('color', 'rgb(0, 0, 0)');
      expect(errors).toEqual([]);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
  for(const route of ['gallery','gallery-app'])test(`${route}: static imports, real responsive decoding, blur completion and preload`,async({page})=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const responses=[];page.on('response',response=>{if(response.url().includes('/_prnext/image?'))responses.push(response);});
    const response=await page.goto(server.url+'/docs/'+route);expect(response.status()).toBe(200);
    const image=page.getByTestId('static-image');await expect.poll(()=>image.evaluate(node=>node.complete&&node.naturalWidth>0)).toBe(true);
    await expect(page.getByTestId('image-events')).toHaveText('load:IMG');await expect(image).toHaveCSS('background-image','none');
    expect(await image.getAttribute('width')).toBe('160');expect(await image.getAttribute('height')).toBe('80');expect(await image.getAttribute('srcset')).toContain('1x');
    await page.getByTestId('remote-image').scrollIntoViewIfNeeded();await expect.poll(()=>page.getByTestId('remote-image').evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
    await page.getByTestId('fill-image').scrollIntoViewIfNeeded();await expect.poll(()=>page.getByTestId('fill-image').evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
    expect(await page.getByTestId('fill-image').boundingBox()).toMatchObject({width:320,height:160});
    expect(responses.every(response=>response.status()===200)).toBe(true);expect(responses.some(response=>response.headers()['content-type']==='image/avif')).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('a configured CDN serves static imports while optimization stays on the application origin',async({page})=>{
  const fixture=await imagesFixture({cdn:true});let server;
  try {
    await fixture.build();server=await startServer(fixture.root);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url+'/docs/gallery-app');
    const image=page.getByTestId('static-image');await expect.poll(()=>image.evaluate(node=>node.naturalWidth)).toBeGreaterThan(0);
    expect(await image.evaluate(node=>node.currentSrc)).toContain(server.url+'/docs/_prnext/image?');
    expect(decodeURIComponent(await image.getAttribute('src'))).toContain(fixture.originURL+'/cdn/_prnext/assets/image-');
    await expect(page.getByTestId('image-events')).toHaveText('load:IMG');expect(errors).toEqual([]);
  }finally{await server?.close();await fixture.remove();}
});
