import {test,expect} from '@playwright/test';
import { deploymentFixture } from '../deployment-coherence-fixture.mjs';

test('old tab rejects a stale action once, then recovers by document navigation to the current deployment',async({page})=>{
  test.setTimeout(120000);
  const f=await deploymentFixture();
  try{
    await page.goto(f.url+'/docs');await expect(page.getByRole('button',{name:'save'})).toBeEnabled();
    const firstId=f.first.manifest.config.deploymentId;
    const current=(await f.compile('two')).manifest;
    const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request.headers());});
    await page.getByRole('button',{name:'save'}).click();
    await expect(page.locator('output')).toHaveText('PRNEXT_DEPLOYMENT_CHANGED');
    expect(posts).toHaveLength(1);expect(posts[0]['x-prnext-deployment-id']).toBe(firstId);
    expect(f.counts().mutations).toBe(0);
    const documents=[];page.on('request',request=>{if(request.isNavigationRequest())documents.push(request.url());});
    await page.getByRole('link',{name:'next page'}).click();
    await expect(page.getByRole('heading',{name:'Next two'})).toBeVisible();
    expect(documents).toHaveLength(1);
    const response=await page.request.get(f.url+'/docs/next',{headers:{rsc:'1','x-prnext-deployment-id':current.config.deploymentId}});
    expect(response.status()).toBe(200);
  }finally{await f.close();}
});
