import {test,expect} from '@playwright/test';
import {writeFile,mkdir,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {devFixture,counterSource} from '../dev-fixture.mjs';

const edits=Number(process.env.PRNEXT_STRESS_EDITS||0);
test('development endurance preserves two tabs, bounded generations and refresh state',async({page,context},info)=>{
  test.skip(!edits,'Run explicitly with PRNEXT_STRESS_EDITS=500');
  expect(Number.isInteger(edits)&&edits>=20&&edits<=2000).toBe(true);test.setTimeout(edits*4000+120000);
  const fixture=await devFixture(),other=await context.newPage(),errors=[],timings=[];
  const cdp=await context.newCDPSession(page);
  const heap=async()=>{await cdp.send('HeapProfiler.collectGarbage');return(await cdp.send('Runtime.getHeapUsage')).usedSize;};
  try{
    for(const tab of [page,other])tab.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.url+'/docs/pages');await other.goto(fixture.url+'/docs/app');
    for(const tab of [page,other]){await tab.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await tab.getByTestId('counter').click();await expect(tab.getByTestId('counter')).toHaveText('Original 1');await tab.evaluate(()=>window.__enduranceDocument=true);}
    const baselineHeap=await heap();let label='Original',compilerRestarts=0,lastCompilerBuilds=0,maxCompilerRssMb=0;
    for(let i=0;i<edits;i++){
      const kind=i%5===0?'js':'css',start=performance.now();
      if(kind==='js'){
        label='Edit'+i;await fixture.write('components/Counter.jsx',counterSource(label));
        await expect(page.getByTestId('counter')).toHaveText(label+' 1',{timeout:20000});
      }else{
        const color=`rgb(${20+i%200}, 40, 70)`;await fixture.write('components/counter.module.css',`.counter{color:${color}}`);
        await expect(page.getByTestId('counter')).toHaveCSS('color',color,{timeout:20000});
        await expect(other.getByTestId('counter')).toHaveCSS('color',color,{timeout:20000});
      }
      await expect(other.getByTestId('counter')).toHaveText(label+' 1');
      await page.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);
      timings.push({kind,ms:performance.now()-start});
      if(kind==='js'){
        const health=JSON.parse(await fixture.read('.prnext-dev.json')).compiler?.health;
        if(health){if(health.builds<lastCompilerBuilds)compilerRestarts++;lastCompilerBuilds=health.builds;maxCompilerRssMb=Math.max(maxCompilerRssMb,health.rssMb);}
      }
      if(i%25===0){expect(await page.evaluate(()=>window.__enduranceDocument)).toBe(true);expect(await other.evaluate(()=>window.__enduranceDocument)).toBe(true);}
    }
    const endHeap=await heap(),quantile=(kind,p)=>{const values=timings.filter(t=>t.kind===kind).map(t=>t.ms).sort((a,b)=>a-b);return values[Math.min(values.length-1,Math.floor(values.length*p))];};
    const state=JSON.parse(await fixture.read('.prnext-dev.json'));
    const directories=await readdir(path.join(fixture.root,'.prnext-dev',state.session),{withFileTypes:true});
    expect(directories.filter(entry=>entry.isDirectory()&&/^[a-f\d-]{36}$/.test(entry.name)).length).toBeLessThanOrEqual(3);
    expect(directories.filter(entry=>entry.isDirectory()&&entry.name.startsWith('styles-')).length).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]);expect(endHeap-baselineHeap).toBeLessThan(128*1024*1024);
    const report={version:1,complete:true,fixture:'dev-fixture-v1',machine:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,node:process.version},edits,timings,metrics:{js:{p50:quantile('js',.5),p95:quantile('js',.95)},css:{p50:quantile('css',.5),p95:quantile('css',.95)},heapGrowthBytes:endHeap-baselineHeap},compiler:{restarts:compilerRestarts,maxRssMb:maxCompilerRssMb,final:state.compiler?.health},finalSequence:state.sequence,pageErrors:errors};
    const filename=process.env.PRNEXT_STRESS_REPORT||info.outputPath('dev-endurance.json');await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(report,null,2)+'\n');
  }finally{await fixture.close();}
});
