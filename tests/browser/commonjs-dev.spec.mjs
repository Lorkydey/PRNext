import {test,expect} from '@playwright/test';
import {devFixture} from '../dev-fixture.mjs';

for (const compiler of ['esbuild','webpack']) test(`${compiler} dev imports CommonJS metadata in Pages and App and reloads edits`, async ({page}) => {
  test.setTimeout(90_000);
  const fixture=await devFixture({
    config: compiler==='webpack' ? `export default{basePath:'/docs',webpack(config){config.plugins.push({apply(){}});return config}}` : undefined,
    files:{
      'package.json':'{"name":"commonjs-dev-fixture"}',
      'data/siteMetadata.js':"module.exports={title:'CommonJS original',subtitle:require('./fields.cjs').subtitle}",
      'data/fields.cjs':"exports.subtitle='Named CommonJS field'",
      'components/Counter.jsx':`'use client';import{useState}from'react';import siteMetadata from'../data/siteMetadata';export default function Counter(){const[count,setCount]=useState(0);return <><p data-testid="metadata">{siteMetadata.title} / {siteMetadata.subtitle}</p><button data-testid="counter" onClick={()=>setCount(count+1)}>Count {count}</button></>}`,
    },
  });
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  try {
    for (const route of ['pages','app']) {
      const response=await page.goto(fixture.url+'/docs/'+route);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain('CommonJS original');
      await expect(page.getByTestId('metadata')).toHaveText('CommonJS original / Named CommonJS field');
      await page.waitForFunction(()=>globalThis.__PRNEXT_DEV__?.modules.has('data/siteMetadata.js'));
      await page.getByTestId('counter').click();
      await expect(page.getByTestId('counter')).toHaveText('Count 1');
    }
    await page.evaluate(()=>window.commonjsDocument='before-edit');
    await fixture.write('data/siteMetadata.js',"module.exports={title:'CommonJS updated',subtitle:require('./fields.cjs').subtitle}");
    await expect(page.getByTestId('metadata')).toHaveText('CommonJS updated / Named CommonJS field',{timeout:30_000});
    expect(await page.evaluate(()=>window.commonjsDocument)).toBeUndefined();
    await page.goto(fixture.url+'/docs/pages');
    await expect(page.getByTestId('metadata')).toHaveText('CommonJS updated / Named CommonJS field');
    expect(fixture.output()).not.toMatch(/export .* was not found|module has no exports/);
    expect(errors).toEqual([]);
  } catch(error) {
    throw new Error(error.message+'\n'+fixture.output()+'\n'+errors.join('\n'),{cause:error});
  } finally {await fixture.close();}
});
