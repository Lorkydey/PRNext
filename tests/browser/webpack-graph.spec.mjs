import {test,expect} from '@playwright/test';
import {webpackGraphFixture} from '../webpack-graph-fixture.mjs';
import {startServer} from '../support.mjs';
import {devFixture,counterSource} from '../dev-fixture.mjs';

test('real webpack graph plugins preserve CSS, lazy chunks, both routers, Edge and Server Actions',async({page})=>{
  test.setTimeout(90_000);
  const fixture=await webpackGraphFixture();let server;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  try{
    await fixture.build();server=await startServer(fixture.root);
    expect(await(await fetch(server.url+'/edge')).json()).toEqual({message:'Replaced by graph plugin',number:7});
    for(const [route,link,heading]of [['/legacy','Other legacy page','Other legacy'],['/','Other app page','Other app']]){
      const response=await page.goto(server.url+route);
      const ssrId=(await response.text()).match(/data-testid="id-input" id="([^"]+)"/)?.[1];
      expect(ssrId).toBeTruthy();
      await expect(page.getByRole('heading')).toHaveText('Replaced by graph plugin 7');
      const button=page.getByRole('button',{name:'Count 0',exact:true});
      await expect(button).toHaveCSS('color','rgb(12, 34, 56)');await button.click();
      await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
      await expect(page.getByTestId('id-input')).toHaveAttribute('id',ssrId);
      await expect(page.getByTestId('id-label')).toHaveAttribute('for',ssrId);
      await expect(page.getByRole('button',{name:'Count 1',exact:true})).toHaveCSS('background-image',/data:image\/svg\+xml/);
      await expect(page.getByTestId('lazy')).toHaveText('Lazy chunk works');
      await page.evaluate(()=>{window.graphDocument='preserved';});
      if(route==='/'){
        await page.getByRole('button',{name:'Rename',exact:true}).click();
        await expect(page.getByTestId('visitor')).toHaveText('graph action');
      }
      await page.getByRole('link',{name:link}).click();await expect(page.getByRole('heading')).toHaveText(heading);
      expect(await page.evaluate(()=>window.graphDocument)).toBe('preserved');
      await page.getByRole('link',{name:'Back',exact:true}).click();await expect(page.getByRole('heading')).toHaveText('Replaced by graph plugin 7');
    }
    const response=await page.goto(server.url+'/static-id');
    const ssrId=(await response.text()).match(/data-testid="id-input" id="([^"]+)"/)?.[1];
    expect(ssrId).toBeTruthy();
    await page.getByRole('button',{name:'Count 0',exact:true}).click();
    await expect(page.getByRole('button',{name:'Count 1',exact:true})).toBeVisible();
    await expect(page.getByTestId('id-input')).toHaveAttribute('id',ssrId);
    expect(errors).toEqual([]);
  }catch(error){throw new Error(error.message+'\nBrowser errors: '+errors.join('\n')+'\nServer: '+server?.output(),{cause:error});}
  finally{await server?.close();await fixture.remove();}
});

for(const router of ['pages','app'])test(`webpack graph rebuilds preserve ${router} Fast Refresh state`,async({page})=>{
  test.setTimeout(90_000);
  const fixture=await devFixture({config:`export default{basePath:'/docs',webpack(config){config.plugins.push({apply(compiler){compiler.hooks.compilation.tap('Graph',compilation=>{compilation.hooks.optimizeModules.tap('Graph',()=>{});});}});return config}}`});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(fixture.url+'/docs/'+router);
    await page.getByTestId('counter').click();await expect(page.getByTestId('counter')).toHaveText('Original 1');
    await page.evaluate(()=>{window.graphDocument='preserved';});
    await fixture.write('components/Counter.jsx',counterSource('Rebuilt'));
    await expect(page.getByTestId('counter'),fixture.output()).toHaveText('Rebuilt 1',{timeout:25_000});
    expect(await page.evaluate(()=>window.graphDocument)).toBe('preserved');
    expect(errors).toEqual([]);
  }catch(error){
    const state=await page.evaluate(()=>({kind:globalThis.__RUSTYX_DEV__?.currentKind,build:globalThis.__RUSTYX_DEV__?.buildId,applying:globalThis.__RUSTYX_DEV__?.applying,modules:[...(globalThis.__RUSTYX_DEV__?.modules || [])],overlay:document.getElementById('__rustyx_dev_error__')?.shadowRoot?.textContent}));
    throw new Error(error.message+'\n'+fixture.output()+'\n'+JSON.stringify(state)+'\n'+errors.join('\n'),{cause:error});
  }finally{await fixture.close();}
});
