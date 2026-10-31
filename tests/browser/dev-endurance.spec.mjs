import {test,expect} from '@playwright/test';
import {writeFile,mkdir,readdir,realpath,open} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {devFixture,counterSource} from '../dev-fixture.mjs';
import {startProcessTreeSampling} from '../performance/process-tree.mjs';

const edits=Number(process.env.PRNEXT_STRESS_EDITS||0);
test('development endurance preserves two tabs, bounded generations and refresh state',async({page,context},info)=>{
  test.skip(!edits,'Run explicitly with PRNEXT_STRESS_EDITS=500');
  expect(Number.isInteger(edits)&&edits>=20&&edits<=2000).toBe(true);test.setTimeout(edits*4000+120000);
  const fixture=await devFixture(),other=await context.newPage(),errors=[],timings=[];
  // OS counters concern the owned CLI/server/compiler descendants. Keep this
  // separate from CDP browser heap, and sample sparsely to limit CIM overhead.
  const processSampling=startProcessTreeSampling(fixture.child.pid,{intervalMs:5000});
  const cdp=await context.newCDPSession(page);
  const heap=async()=>{await cdp.send('HeapProfiler.collectGarbage');return(await cdp.send('Runtime.getHeapUsage')).usedSize;};
  let baselineHeap,endHeap,session,compilerRestarts=0,lastCompilerBuilds=0,maxCompilerRssMb=0,complete=false,failure;
  try{
    for(const tab of [page,other])tab.on('pageerror',error=>errors.push(error.message));
    await page.goto(fixture.url+'/docs/pages');await other.goto(fixture.url+'/docs/app');
    for(const tab of [page,other]){await tab.waitForFunction(()=>window.__PRNEXT_DEV__?.confirmed===true);await tab.getByTestId('counter').click();await expect(tab.getByTestId('counter')).toHaveText('Original 1');await tab.evaluate(()=>window.__enduranceDocument=true);}
    await processSampling.ready;
    baselineHeap=await heap();session=JSON.parse(await fixture.read('.prnext-dev.json')).session;let label='Original';
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
    endHeap=await heap();
    const state=JSON.parse(await fixture.read('.prnext-dev.json'));
    const directories=await readdir(path.join(fixture.root,'.prnext-dev',state.session),{withFileTypes:true});
    expect(directories.filter(entry=>entry.isDirectory()&&/^[a-f\d-]{36}$/.test(entry.name)).length).toBeLessThanOrEqual(3);
    expect(directories.filter(entry=>entry.isDirectory()&&entry.name.startsWith('styles-')).length).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]);expect(endHeap-baselineHeap).toBeLessThan(128*1024*1024);
    complete=true;
  }catch(error){failure={name:error.name,message:error.message,stack:error.stack};throw error;}
  finally{
    // Persist partial evidence before fixture.close removes its snapshots, even
    // when an assertion or a browser operation failed midway through the run.
    try{
      const observationErrors=[],serverProcessTree=await processSampling.stop();
      const state=await fixture.read('.prnext-dev.json').then(JSON.parse).catch(error=>{observationErrors.push('state: '+error.message);return {};});
      session=state.session||session;
      let publicationJournal=null;
      if(session)try{
        if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(session))throw Error('Invalid owned session');
        // Inspect only the fixture's default private journal, never an external
        // PRNEXT_INSPECT_DIR. Bound the read even if a file grows after stat.
        const ownedRoot=await realpath(fixture.root),expected=path.join(ownedRoot,'.prnext-dev',session,'diagnostics','state-publication.json');
        const file=await realpath(expected);
        if(file!==expected)throw Error('Publication journal escaped its owned path');
        const handle=await open(file,'r');
        try{
          const info=await handle.stat();if(!info.isFile()||info.size>8192)throw Error('Publication journal exceeded its budget');
          const buffer=Buffer.alloc(8193),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
          if(bytesRead>8192)throw Error('Publication journal exceeded its budget');
          publicationJournal=JSON.parse(buffer.toString('utf8',0,bytesRead));
        }finally{await handle.close();}
      }catch(error){if(error.code!=='ENOENT')observationErrors.push('publication journal: '+(error.code||'invalid'));}
      const directories=session?await readdir(path.join(fixture.root,'.prnext-dev',session),{withFileTypes:true}).then(entries=>entries.filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort()).catch(error=>{observationErrors.push('directories: '+error.message);return null;}):null;
      if(endHeap===undefined&&baselineHeap!==undefined)endHeap=await heap().catch(error=>{observationErrors.push('heap: '+error.message);return undefined;});
      const quantile=(kind,p)=>{const values=timings.filter(t=>t.kind===kind).map(t=>t.ms).sort((a,b)=>a-b);return values.length?values[Math.min(values.length-1,Math.floor(values.length*p))]:null;};
      const report={version:3,complete,completedEdits:timings.length,fixture:'dev-fixture-v1',machine:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,node:process.version},edits,timings,
        metrics:{js:{p50:quantile('js',.5),p95:quantile('js',.95)},css:{p50:quantile('css',.5),p95:quantile('css',.95)},heapGrowthBytes:baselineHeap===undefined||endHeap===undefined?null:endHeap-baselineHeap},
        browserHeap:{baselineBytes:baselineHeap??null,endBytes:endHeap??null,growthBytes:baselineHeap===undefined||endHeap===undefined?null:endHeap-baselineHeap},serverProcessTree,
        compiler:{restarts:compilerRestarts,maxRssMb:maxCompilerRssMb,final:state.compiler?.health},finalSequence:state.sequence,finalState:state.state,buildError:state.error,publication:state.publication??null,publicationJournal,
        directories:directories?{names:directories,server:directories.filter(name=>/^[a-f\d-]{36}$/.test(name)).length,styles:directories.filter(name=>name.startsWith('styles-')).length}:null,pageErrors:errors,failure,observationErrors};
      if(failure)report.developmentOutput=fixture.output();
      const filename=process.env.PRNEXT_STRESS_REPORT||info.outputPath('dev-endurance.json');await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(report,null,2)+'\n');
      await info.attach('dev-endurance',{path:filename,contentType:'application/json'});
    }catch(error){if(!failure)throw error;console.error('Could not persist partial endurance report: '+error.message);}
    finally{try{await processSampling.stop();}finally{await fixture.close();}}
  }
});
