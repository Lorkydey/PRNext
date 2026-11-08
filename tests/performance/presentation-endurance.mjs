import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile,appendFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {presentationFixture,presentationSecrets} from '../presentation-fixture.mjs';
import {startServer,binary,repositoryRoot} from '../support.mjs';
import {observeProcessTree} from './process-tree.mjs';
import {observeResourceControls,verifyResourcePolicy} from './release-regression-controls.mjs';
import {isMainModule} from '../../scripts/main-module.mjs';

export async function presentationEndurance({directory,affinity,seconds=1200}){
  assert.equal(process.platform,'linux');assert.equal(seconds,1200,'This scenario is an explicitly twenty-minute diagnostic');
  assert.match(affinity,/^\d+,\d+$/);assert.equal(new Set(affinity.split(',')).size,2);
  const source=execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim();
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),'');
  await mkdir(directory,{recursive:true});
  const report={source,complete:false,mode:'twenty-minute diagnostic',twoHourQualified:false,requestedSeconds:seconds,counters:{responses:0,compact:0,ordinary:0,cancelledStreams:0,browserChecks:0,samples:0,verifiedSamples:0},pageErrors:[],samples:[],node:process.version,nativeSha256:createHash('sha256').update(await readFile(binary)).digest('hex'),limitations:['A twenty-minute synthetic presentation workload does not replace a two-hour SaaS qualification.','Shared RSS is sampled and is not unique memory or a proof of no leak.','The driver shares two CPU cores with the owned server and browser.']};
  const policy={cpuLimit:2,memoryBytes:5*1024**3,affinityCpus:affinity};
  report.resourcesBefore=await observeResourceControls();report.resourceVerification=verifyResourcePolicy(policy,report.resourcesBefore);assert.equal(report.resourceVerification.verified,true);
  const save=()=>writeFile(path.join(directory,'presentation-endurance.json'),JSON.stringify(report,null,2)+'\n');
  let fixture,server,browser;
  try{
    fixture=await presentationFixture();const build=await fixture.build();
    assert.equal(build.presentationReport.components.find(item=>item.file==='app/Table.jsx')?.status,'compact');
    assert.ok(!(await readFile(path.join(fixture.root,'app/Table.jsx'),'utf8')).includes('use presentation'));
    assert.ok(!(await readFile(path.join(fixture.root,'prnext.config.mjs'),'utf8')).includes('presentationComponents'));
    server=await startServer(fixture.root,['--workers','2']);browser=await chromium.launch();
    const request=async(index)=>{
      const rows=[12,64,1000][index%3],rsc=index%2===0,owner=index%2?'Owned-B':'Owned-A';
      const response=await fetch(server.url+'/?rows='+rows,{headers:{cookie:'presentation_owner='+owner,...(rsc?{RSC:'1'}:{})},signal:AbortSignal.timeout(15000)});
      assert.equal(response.status,200);const text=await response.text();
      assert.ok(text.includes('Product '+(rows-1))&&text.includes(owner));assert.ok(!text.includes(owner==='Owned-A'?'Owned-B':'Owned-A'));
      for(const secret of presentationSecrets)assert.ok(!text.includes(secret));
      report.counters.responses++;
      if(rsc){const compact=text.includes('__prnextPresentation');assert.equal(compact,rows>=32);report.counters[compact?'compact':'ordinary']++;}
    };
    const sample=async()=>{
      const tree=await observeProcessTree(server.child.pid),fds=[];
      for(const process of tree.processes)try{fds.push({pid:process.pid,startId:process.startId,count:(await readdir('/proc/'+process.pid+'/fd')).length});}catch{}
      const value={at:new Date().toISOString(),processes:tree,descriptors:fds};
      await appendFile(path.join(directory,'samples.jsonl'),JSON.stringify(value)+'\n');
      report.counters.samples++;if(tree.state==='verified'&&fds.length===tree.processes.length)report.counters.verifiedSamples++;
      report.samples.push({at:value.at,state:tree.state,rssSumBytes:tree.rssSumBytes,fileDescriptors:fds.reduce((sum,row)=>sum+row.count,0)});await save();
    };
    const checkBrowser=async()=>{
      const context=await browser.newContext();
      try{const page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.name));await page.goto(server.url+'/?rows=1000');await page.getByTestId('counter').click();await page.waitForFunction(()=>document.querySelector('[data-testid=counter]').textContent==='Count 1');assert.equal(await page.locator('tbody tr').count(),1000);report.counters.browserChecks++;}
      finally{await context.close();}
    };
    await request(0);await request(1);await checkBrowser();await sample();
    const started=performance.now(),ends=started+seconds*1000;let index=0,nextSample=started+30000,nextBrowser=started+60000,nextAbort=started+5000;
    report.sustainedStartedAt=new Date().toISOString();await save();
    while(performance.now()<ends){
      await Promise.all(Array.from({length:4},()=>request(index++)));
      if(performance.now()>=nextAbort){const abort=new AbortController();const response=await fetch(server.url+'/stream',{signal:abort.signal});assert.equal(response.status,200);const reader=response.body.getReader();await reader.read();abort.abort();await reader.cancel().catch(()=>{});report.counters.cancelledStreams++;nextAbort=performance.now()+5000;}
      // Observe before creating/closing a fresh browser context. Its renderer
      // can still be exiting after context.close(), making an unclassified
      // /proc entry legitimately unknown to the conservative host observer.
      if(performance.now()>=nextSample){await sample();nextSample=performance.now()+30000;console.log(JSON.stringify({seconds:Math.floor((performance.now()-started)/1000),...report.counters}));}
      if(performance.now()>=nextBrowser){await checkBrowser();nextBrowser=performance.now()+60000;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    report.sustainedSeconds=(performance.now()-started)/1000;await sample();
    assert.ok(report.sustainedSeconds>=1200);assert.ok(report.counters.compact>0&&report.counters.ordinary>0&&report.counters.cancelledStreams>0);
    assert.ok(report.counters.samples>=38&&report.counters.verifiedSamples/report.counters.samples>=0.95);assert.deepEqual(report.pageErrors,[]);
    report.resourcesAfter=await observeResourceControls();assert.equal(verifyResourcePolicy(policy,report.resourcesAfter).verified,true);
    assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),'');
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),source);
  }catch(error){report.error={name:error.name,message:error.message};throw error;}
  finally{
    const cleanup=await Promise.allSettled([browser?.close(),server?.close()]);
    const failures=cleanup.filter(item=>item.status==='rejected').map(item=>item.reason);
    try{await fixture?.remove();}catch(error){failures.push(error);}
    if(failures.length){report.cleanupErrors=failures.map(error=>({name:error.name,message:error.message}));await save();throw new AggregateError(failures,'Presentation diagnostic cleanup failed');}
    await save();
  }
  report.complete=true;await save();
  return report;
}

if(isMainModule(import.meta.url)){
  const [directory,affinity]=process.argv.slice(2);assert.ok(directory&&affinity&&process.argv.length===4,'Expected output directory and two-CPU affinity');
  await presentationEndurance({directory:path.resolve(directory),affinity});
}
