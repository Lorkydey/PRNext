import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {deploymentFixture} from '../deployment-coherence-fixture.mjs';

test('automatic templates keep old assets usable and reject stale mutations through cutover and rollback',async({page})=>{
  test.setTimeout(120000);
  const fixture=await deploymentFixture({presentation:true});
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  try{
    await page.goto(fixture.url+'/docs');
    await expect(page.getByRole('button',{name:'save',exact:true})).toBeEnabled();
    await expect(page.getByTestId('deployment-presentation').locator('p')).toHaveCount(100);
    const scripts=await page.evaluate(()=>performance.getEntriesByType('resource').filter(item=>item.name.endsWith('.js')).map(item=>item.name));
    expect(scripts.length).toBeGreaterThan(0);
    const originals=await Promise.all(scripts.map(async url=>{const response=await page.request.get(url);expect(response.status()).toBe(200);return{url,sha256:hash(await response.body())};}));
    const second=await fixture.compile('two');
    expect(second.manifest.config.deploymentId).not.toBe(fixture.first.manifest.config.deploymentId);
    for(const original of originals){const response=await page.request.get(original.url);expect(response.status()).toBe(200);expect(hash(await response.body())).toBe(original.sha256);}
    const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request.url());});
    await page.getByRole('button',{name:'save',exact:true}).click();
    await expect(page.locator('output')).toHaveText('PRNEXT_DEPLOYMENT_CHANGED');
    expect(posts).toHaveLength(1);expect(fixture.counts().mutations).toBe(0);
    await page.getByRole('link',{name:'next page',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Next two',exact:true})).toBeVisible();
    await expect(page.getByTestId('deployment-presentation')).toHaveClass('generation-two');
    fixture.activate(fixture.first.server);
    await page.getByRole('button',{name:'save',exact:true}).click();
    await expect(page.locator('output')).toHaveText('PRNEXT_DEPLOYMENT_CHANGED');
    expect(posts).toHaveLength(2);expect(fixture.counts().mutations).toBe(0);
    await page.getByRole('link',{name:'home page',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Deployment one',exact:true})).toBeVisible();
    await expect(page.getByTestId('deployment-presentation')).toHaveClass('generation-one');
    await expect(page.getByTestId('deployment-presentation').locator('p')).toHaveCount(100);
    await page.getByRole('button',{name:'save',exact:true}).click();
    await expect(page.locator('output')).toHaveText('saved');
    expect(posts).toHaveLength(3);expect(fixture.counts().mutations).toBe(1);
  }finally{await fixture.close();}
});
