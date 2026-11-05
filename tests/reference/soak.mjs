import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { referenceFixture } from './fixture.mjs';
import { referenceDeadline, closeReferenceResources } from './lifecycle.mjs';
import { captureReferenceAction, referenceBrowserOptions } from './security-scenarios.mjs';
import { qualifyIdempotentMutations } from './idempotency.mjs';
import { observeProcessTree } from '../performance/process-tree.mjs';
import { observeResourceControls, verifyResourcePolicy } from '../performance/release-regression-controls.mjs';
import { verifyArchiveSource, verifyComparisonPair } from '../performance/prepare-candidate-comparison.mjs';
import { isMainModule } from '../../scripts/main-module.mjs';
import { binary, repositoryRoot } from '../support.mjs';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const FULL_DURATION_SECONDS=7200;

// Included only in the disposable loopback consumer, never in the example or
// distributed framework. Authentication uses the same real PostgreSQL session.
export const soakRoute=`import{getAuth}from'../../../lib/auth.js';
export async function GET(request){const session=await getAuth().api.getSession({headers:request.headers});if(!session)return Response.json({error:'authentication'},{status:401});
if(new URL(request.url).searchParams.get('stream')==='1'){let timer,count=0;return new Response(new ReadableStream({pull(controller){return new Promise(resolve=>{timer=setTimeout(()=>{controller.enqueue(new Uint8Array(16384).fill(++count%251));resolve();},20);});},cancel(){clearTimeout(timer);}},{highWaterMark:0}),{headers:{'content-type':'application/octet-stream','cache-control':'private, no-store'}});}
return Response.json({pid:process.pid,userId:session.user.id,memory:process.memoryUsage()},{headers:{'cache-control':'private, no-store'}});}`;

export function soakSettings(argv=process.argv.slice(2)) {
  const {values}=parseArgs({args:argv,options:{run:{type:'boolean'},'diagnostic-seconds':{type:'string'},'output-directory':{type:'string'},affinity:{type:'string'},'candidate-archive':{type:'string'}},allowPositionals:false});
  const diagnostic=values['diagnostic-seconds']!==undefined;
  const seconds=diagnostic?Number(values['diagnostic-seconds']):FULL_DURATION_SECONDS;
  if(!Number.isSafeInteger(seconds)||seconds<1||seconds>FULL_DURATION_SECONDS||diagnostic&&seconds>=FULL_DURATION_SECONDS)throw new Error('A diagnostic duration must be from 1 to 7199 seconds. Full qualification always runs for two hours.');
  if(values.affinity!==undefined){
    const cpus=values.affinity.split(',');
    if(cpus.length!==2||cpus.some(value=>!/^\d{1,5}$/.test(value)||Number(value)>65535)||Number(cpus[0])===Number(cpus[1]))throw new Error('Endurance affinity requires two distinct CPU IDs.');
  }
  return {run:values.run===true,seconds,diagnostic,affinity:values.affinity,archive:values['candidate-archive'],directory:path.resolve(values['output-directory']||path.join(repositoryRoot,'artifacts/saas-endurance'))};
}

async function sourceState() {
  const {stdout:commit}=await execute('git',['rev-parse','HEAD'],{cwd:repositoryRoot,timeout:10000});
  const {stdout:dirty}=await execute('git',['status','--porcelain','--untracked-files=normal'],{cwd:repositoryRoot,timeout:10000,maxBuffer:8e6});
  return {commit:commit.trim(),clean:dirty.length===0};
}

export async function qualifySaasSoak(settings=soakSettings()) {
  if(!settings.run)throw new Error('SaaS endurance is opt-in; use --run.');
  await mkdir(settings.directory,{recursive:true});
  const report={version:1,complete:false,qualified:false,mode:settings.diagnostic?'diagnostic':'release-qualification',startedAt:new Date().toISOString(),requestedSeconds:settings.seconds,node:process.version,platform:process.platform,
    counters:{cycles:0,noteWrites:0,authenticatedReads:0,cancelledStreams:0,rotations:0,samples:0,verifiedProcessSamples:0,verifiedDescriptorSamples:0,renewedSessions:0},pageErrors:[],faults:{},
    policy:{minimumObservationCoverage:0.95,sampleIntervalSeconds:30,workerRotationSeconds:600,mutationRetries:'explicit original-key retry only'},
    limitations:['A diagnostic run never qualifies the two-hour gate.','Summed RSS counts shared resident pages repeatedly; samples are observations, not a proof of no leak.','Process rotations make aggregate process CPU deltas incomparable; individual PID/start identities are retained.','The owned fixture certificate is accepted only by its browser contexts. No machine trust store or global TLS setting changes.','Visible kernel cgroup limits and affinity are checked; namespace-hidden parent limits and unrelated host contention remain outside verification.']};
  const save=()=>referenceDeadline(writeFile(path.join(settings.directory,'soak.json'),JSON.stringify(report,null,2)+'\n'),'SaaS endurance report persistence timed out.',5000);
  let fixture,pool,browser,browserServer,active=false,primaryError;
  const contexts=[];
  const stop=new AbortController();
  const interrupt=()=>stop.abort(new Error('SaaS endurance was interrupted.'));
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const deadline=setTimeout(()=>stop.abort(new Error('SaaS endurance exceeded its duration plus setup/cleanup budget.')),(settings.seconds+900)*1000);
  deadline.unref?.();
  try {
    report.sourceBefore=await sourceState();
    if(!settings.diagnostic){
      assert.equal(report.sourceBefore.clean,true,'Freeze a clean candidate commit before the full endurance qualification.');
      assert.equal(process.platform,'linux','The release endurance requires observed Linux CPU/RAM limits.');
      assert.ok(settings.affinity,'The release endurance requires an explicit fixed CPU affinity.');
    }
    report.resourcesBefore=await observeResourceControls();
    const resourcePolicy=settings.affinity?{cpuLimit:2,memoryBytes:5*1024**3,affinityCpus:settings.affinity}:undefined;
    report.resourceVerification=verifyResourcePolicy(resourcePolicy,report.resourcesBefore);
    await save();
    fixture=await referenceFixture({candidateArchive:settings.archive,artifactsDirectory:settings.directory,extraFiles:{'app/api/reference-soak/route.js':soakRoute},onProgress:message=>console.log(message)});
    report.installation=fixture.evidence;
    const archives=path.join(settings.directory,'archives');
    const framework=path.resolve(settings.archive||path.join(archives,fixture.evidence.framework.archive));
    report.archives=verifyComparisonPair(await readFile(framework),await readFile(path.join(archives,fixture.evidence.native.archive)));
    report.nativeSha256=sha(await readFile(binary));
    assert.equal(report.nativeSha256,report.archives.binarySha256);
    report.nodeSha256=sha(await readFile(process.execPath));report.fixtureRouteSha256=sha(soakRoute);
    if(!settings.diagnostic)report.archiveSource=await verifyArchiveSource(framework,report.sourceBefore.commit);
    else report.archiveSource={associationVerified:false,reason:'Diagnostic source can contain uncommitted changes.'};
    report.nativeBuildAssociation={declaredSource:process.env.PRNEXT_SAAS_NATIVE_SOURCE||null,verifiedByWorkflow:process.env.GITHUB_ACTIONS==='true'&&process.env.PRNEXT_SAAS_NATIVE_SOURCE===report.sourceBefore.commit,note:'Archive metadata proves exact native bytes; source association additionally depends on the preceding workflow build at this clean checkout.'};
    if(!settings.diagnostic)assert.equal(report.nativeBuildAssociation.verifiedByWorkflow,true,'Release qualification requires the workflow native build source association.');
    await fixture.build();await fixture.start({workers:2});active=true;
    pool=await fixture.pool({max:2});
    browserServer=await chromium.launchServer({headless:true,host:'127.0.0.1'});
    report.browserProcess=browserServer.process().pid;
    browser=await chromium.connect(browserServer.wsEndpoint());
    const users=[];
    for(let index=0;index<2;index++){
      const context=await browser.newContext({...referenceBrowserOptions,locale:'en-US'});contexts.push(context);
      context.setDefaultTimeout(15000);
      context.on('page',page=>page.on('pageerror',error=>report.pageErrors.push(error.name)));
      const page=await context.newPage(),email='soak-'+index+'@example.test',password='Reference-soak-password-'+randomUUID();
      await page.goto(fixture.origin+'/en/sign-up');
      await page.getByLabel('Name',{exact:true}).fill('Soak '+index);await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
      await page.getByRole('button',{name:'Create account',exact:true}).click();await expect(page).toHaveURL(fixture.origin+'/en/dashboard');
      await expect(page.getByTestId('account')).toContainText(email);
      users.push({context,page,email,password,writes:0,userId:(await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id});
    }
    const first=users[0],initialBody='SOAK_INITIAL_NOTE';
    await first.page.getByLabel('Note',{exact:true}).fill(initialBody);
    await expect(first.page.getByRole('button',{name:'Save note',exact:true})).toBeEnabled();
    const initialKey=await first.page.locator('input[name="requestKey"]').inputValue();
    const action=await captureReferenceAction(first.page,()=>first.page.getByRole('button',{name:'Save note',exact:true}).click());
    await expect(first.page.getByText(initialBody,{exact:true})).toBeVisible();
    await qualifyIdempotentMutations({context:first.context,fixture,pool,action,key:initialKey,body:initialBody,email:first.email,proof:report.faults});
    // Fault qualification leaves deliberate committed rows; freeze each owner's
    // baseline before the sustained phase rather than counting them as load.
    for(const user of users)user.baseline=Number((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1',[user.userId])).rows[0].count);
    const sample=async()=>{
      stop.signal.throwIfAborted();
      const processes=await observeProcessTree(fixture.serverPid);
      const descriptors=[];
      if(process.platform==='linux')for(const process of processes.processes){
        try{descriptors.push({pid:process.pid,startId:process.startId,count:(await readdir('/proc/'+process.pid+'/fd')).length});}
        catch(error){descriptors.push({pid:process.pid,startId:process.startId,count:null,unavailable:error.code||'UNKNOWN'});}
      }
      const connections=(await pool.query("SELECT application_name,state,count(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database() GROUP BY application_name,state ORDER BY application_name,state")).rows;
      const value={at:new Date().toISOString(),processes,descriptors,connections};
      await appendFile(path.join(settings.directory,'samples.jsonl'),JSON.stringify(value)+'\n');
      const verifiedDescriptors=process.platform==='linux'&&processes.state==='verified'&&descriptors.length===processes.processes.length&&descriptors.every(row=>row.count!==null);
      report.counters.samples++;
      if(processes.state==='verified')report.counters.verifiedProcessSamples++;
      if(verifiedDescriptors)report.counters.verifiedDescriptorSamples++;
      report.latestSample={at:value.at,state:processes.state,rssSumBytes:processes.rssSumBytes,connections:connections.reduce((total,row)=>total+row.connections,0),fileDescriptors:verifiedDescriptors?descriptors.reduce((total,row)=>total+row.count,0):null};
      report.peakObservedRssBytes=Math.max(report.peakObservedRssBytes||0,processes.rssSumBytes||0);await save();
    };
    const authenticatedProbe=async user=>{
      const response=await user.context.request.get(fixture.origin+'/api/reference-soak',{timeout:15000});assert.equal(response.status(),200);
      const value=await response.json();assert.equal(value.userId,user.userId);report.counters.authenticatedReads++;return value;
    };
    const cancelStream=async user=>{
      const result=await user.page.evaluate(async origin=>{
        const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000);
        try{const response=await fetch(origin+'/api/reference-soak?stream=1',{signal:abort.signal});if(response.status!==200)throw new Error('Stream authentication failed');const reader=response.body.getReader();const chunk=await reader.read();if(chunk.done||!chunk.value?.length)throw new Error('Missing stream chunk');await reader.cancel();return chunk.value.length;}finally{clearTimeout(timer);}
      },fixture.origin);
      assert.ok(result>0);report.counters.cancelledStreams++;
    };
    const rotate=async user=>{
      const before=await authenticatedProbe(user),tree=await observeProcessTree(fixture.serverPid);
      assert.equal(tree.state,'verified');
      const selected=tree.processes.find(row=>row.pid===before.pid);
      assert.ok(selected&&selected.pid!==fixture.serverPid&&selected.pid!==process.pid,'Only a verified descendant API worker can be rotated.');
      if(process.platform==='linux'){
        const stat=await readFile('/proc/'+selected.pid+'/stat','utf8');
        assert.equal(stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19],selected.startId,'Do not signal a reused process identity.');
      }
      process.kill(selected.pid,'SIGTERM');
      const expires=performance.now()+30000;let after,readOnlyFailures=0;
      while(performance.now()<expires){
        stop.signal.throwIfAborted();
        try{after=await authenticatedProbe(user);if(after.pid!==before.pid)break;}catch{readOnlyFailures++;}
        await delay(100);
      }
      assert.ok(after&&after.pid!==before.pid,'A fresh owned worker must resume authenticated reads.');
      report.counters.rotations++;
      await appendFile(path.join(settings.directory,'rotations.jsonl'),JSON.stringify({at:new Date().toISOString(),before:{pid:selected.pid,startId:selected.startId},afterPid:after.pid,readOnlyRecoveryFailures:readOnlyFailures,mutationsReplayed:0})+'\n');
    };
    await sample();
    report.sustainedStartedAt=new Date().toISOString();const started=performance.now(),ends=started+settings.seconds*1000;
    let nextSample=started+30000,nextRotation=started+(settings.diagnostic?Math.min(15000,settings.seconds*250):600000);
    while(performance.now()<ends){
      stop.signal.throwIfAborted();
      for(const user of users){
        const marker='SOAK_'+user.userId+'_'+randomUUID();
        await user.page.getByLabel('Note',{exact:true}).fill(marker);await user.page.getByRole('button',{name:'Save note',exact:true}).click();
        await expect(user.page.getByText(marker,{exact:true})).toBeVisible();user.writes++;report.counters.noteWrites++;
        const count=Number((await pool.query('SELECT count(*) FROM prnext_reference_notes WHERE user_id=$1',[user.userId])).rows[0].count);
        assert.equal(count,user.baseline+user.writes,'Each confirmed browser mutation must have exactly one SQL row.');
        await user.page.getByRole('link',{name:'PRNext workspace',exact:true}).click();await expect(user.page).toHaveURL(fixture.origin+'/en');
        await user.page.getByRole('link',{name:'Dashboard',exact:true}).click();await expect(user.page.getByTestId('account')).toContainText(user.email);
        await authenticatedProbe(user);await cancelStream(user);
      }
      report.counters.cycles++;
      if(report.counters.cycles%60===0)for(const user of users){
        await user.page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(user.page).toHaveURL(fixture.origin+'/en/sign-in');
        await user.page.getByLabel('Email',{exact:true}).fill(user.email);await user.page.getByLabel('Password',{exact:true}).fill(user.password);
        await user.page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(user.page.getByTestId('account')).toContainText(user.email);report.counters.renewedSessions++;
      }
      if(performance.now()>=nextRotation){await rotate(users[0]);nextRotation=performance.now()+600000;}
      if(performance.now()>=nextSample){await sample();nextSample=performance.now()+30000;console.log('SaaS endurance: '+Math.floor((performance.now()-started)/1000)+' seconds, '+report.counters.noteWrites+' committed notes.');}
      await delay(Math.max(0,Math.min(1000,ends-performance.now())));
    }
    report.sustainedSeconds=(performance.now()-started)/1000;
    assert.ok(report.sustainedSeconds>=settings.seconds);assert.ok(report.counters.cycles>0);assert.ok(report.counters.cancelledStreams>0);
    if(!settings.diagnostic){assert.ok(report.counters.rotations>=10);assert.ok(report.counters.samples>=200);assert.ok(report.counters.renewedSessions>0);}
    await sample();assert.deepEqual(report.pageErrors,[]);
    report.observationCoverage={processes:report.counters.verifiedProcessSamples/report.counters.samples,descriptors:report.counters.verifiedDescriptorSamples/report.counters.samples};
    if(!settings.diagnostic){
      assert.ok(report.observationCoverage.processes>=report.policy.minimumObservationCoverage,'Process observations did not meet the declared coverage gate.');
      assert.ok(report.observationCoverage.descriptors>=report.policy.minimumObservationCoverage,'File descriptor observations did not meet the declared coverage gate.');
    }
    await fixture.stop();active=false;
    for(let attempt=0;;attempt++){
      const count=Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'prnext-saas-reference:%'")).rows[0].count);
      if(count===0){report.databaseConnectionsAfterStop=0;break;}
      if(attempt>=50)throw new Error('Stopped SaaS workers retained database connections.');await delay(100);
    }
    report.resourcesAfter=await observeResourceControls();verifyResourcePolicy(resourcePolicy,report.resourcesAfter);
    report.sourceAfter=await sourceState();assert.deepEqual(report.sourceAfter,report.sourceBefore,'The candidate source must remain frozen throughout endurance.');
    report.workflowsComplete=true;
  } catch(error) {primaryError=error;report.failure={name:error.name,message:String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'<database>').slice(0,500)};}
  finally {
    clearTimeout(deadline);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
    if(primaryError)await fixture?.writeServerLog().catch(()=>{});
    report.cleanup=await closeReferenceResources([
      {name:'browser',timeout:10000,close:async()=>{await Promise.allSettled(contexts.map(context=>context.close()));await browser?.close();await browserServer?.close();},force:async()=>{await browserServer?.kill();}},
      {name:'pool',timeout:5000,close:async()=>{await pool?.end();}},
      {name:'fixture',timeout:45000,close:async()=>{await fixture?.close();active=false;}},
    ],async outcomes=>{report.cleanup=outcomes;await save();});
    report.complete=report.workflowsComplete===true&&!primaryError&&report.cleanup.every(value=>value.phase==='closed'&&!value.progressPersistenceFailed);
    report.qualified=report.complete&&!settings.diagnostic&&report.sustainedSeconds>=FULL_DURATION_SECONDS&&report.resourceVerification.verified===true;
    report.finishedAt=new Date().toISOString();await save();
    if(active)throw new Error('Owned SaaS fixture cleanup did not complete.');
  }
  if(primaryError)throw primaryError;
  if(!report.complete)throw new Error('SaaS endurance cleanup or report persistence was incomplete.');
  return report;
}

if(isMainModule(import.meta.url)){
  const settings=soakSettings();
  if(!settings.run)console.log('Opt-in: node tests/reference/soak.mjs --run --affinity <two CPU IDs> --output-directory artifacts/saas-endurance. Full release qualification runs for two hours under 2 CPU / 5 GiB. --diagnostic-seconds <1..7199> never qualifies that gate.');
  else await qualifySaasSoak(settings);
}
