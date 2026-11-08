import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile,open,lstat,realpath,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {registryAbsenceUrls,confirmRegistryAbsenceViews} from './release-reconciliation.mjs';

const registry='https://registry.npmjs.org/';
export const releasePackages=[
  {name:'prnext-darwin-arm64',platform:'darwin-arm64',os:'darwin',cpu:'arm64'},
  {name:'prnext-darwin-x64',platform:'darwin-x64',os:'darwin',cpu:'x64'},
  {name:'prnext-linux-arm64-gnu',platform:'linux-arm64-gnu',os:'linux',cpu:'arm64',libc:'glibc'},
  {name:'prnext-linux-x64-gnu',platform:'linux-x64-gnu',os:'linux',cpu:'x64',libc:'glibc'},
  {name:'@thomas.f/prnext-win32-arm64-msvc',platform:'win32-arm64-msvc',os:'win32',cpu:'arm64'},
  {name:'@thomas.f/prnext-win32-x64-msvc',platform:'win32-x64-msvc',os:'win32',cpu:'x64'},
  {name:'@thomas.f/prnext',platform:null}
];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const integrity=bytes=>'sha512-'+createHash('sha512').update(bytes).digest('base64');
const shaPattern=/^[a-f0-9]{64}$/;
const gitPattern=/^[a-f0-9]{40}$/;
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha(?:\.(0|[1-9]\d*))?$/;
const fail=message=>{throw Error(message);};
const check=(condition,message)=>{if(!condition)fail(message);};
const ownKeys=(value,keys,label)=>{
  check(value&&typeof value==='object'&&!Array.isArray(value),`Invalid ${label}`);
  check(Object.keys(value).every(key=>keys.includes(key)),`Unsupported ${label} field`);
};

// Data-only USTAR reader. No extraction, package imports or lifecycle execution.
export function readPublishArchive(bytes){
  check(Buffer.isBuffer(bytes)&&bytes.length<=32*1024**2,'Archive size limit');
  const tar=gunzipSync(bytes,{maxOutputLength:256*1024**2});
  const entries=new Map();
  const string=b=>b.toString('utf8').replace(/\0.*$/s,'');
  const number=b=>{const n=string(b).trim();check(/^[0-7]+$/.test(n),'Invalid tar number');return parseInt(n,8);};
  let offset=0,terminated=false;
  while(offset+512<=tar.length){
    const header=tar.subarray(offset,offset+512);
    if(header.every(byte=>byte===0)){check(tar.subarray(offset).every(byte=>byte===0),'Trailing tar data');terminated=true;break;}
    check(entries.size<8192,'Tar entry limit');
    check(number(header.subarray(148,156))===header.reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0),'Tar checksum mismatch');
    check(string(header.subarray(257,263))==='ustar','Unsupported tar format');
    const prefix=string(header.subarray(345,500));
    const name=(prefix?prefix+'/':'')+string(header.subarray(0,100));
    check((string(header.subarray(156,157))||'0')==='0','Tar links or special entries refused');
    check(name.startsWith('package/')&&!name.includes('\\')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Unsafe tar path');
    check(!entries.has(name)&&name!=='package/.npmrc','Duplicate or npm configuration tar entry');
    const size=number(header.subarray(124,136));
    check(Number.isSafeInteger(size)&&size<=tar.length-offset-512,'Truncated tar entry');
    entries.set(name,tar.subarray(offset+512,offset+512+size));
    offset+=512+Math.ceil(size/512)*512;
  }
  check(terminated&&entries.has('package/package.json'),'Incomplete npm archive');
  return entries;
}

export async function loadPublishInputs({plan:planFile,directory,planSha256}){
  check(shaPattern.test(planSha256),'Expected plan SHA-256 required');
  check((await lstat(planFile)).isFile(),'Plan must be a regular file');
  const bytes=await readFile(planFile);
  check(bytes.length<=2*1024**2&&sha(bytes)===planSha256,'Plan digest mismatch');
  const plan=JSON.parse(bytes.toString('utf8'));
  ownKeys(plan,['schemaVersion','repository','releaseVersion','sourceSha','sourceTree','releaseCommit','releaseTree','packages','runs','counts'],'plan');
  check(plan.schemaVersion===1&&plan.repository==='Lorkydey/PRNext','Wrong plan repository/schema');
  check(typeof plan.releaseVersion==='string'&&plan.releaseVersion.length<=64&&versionPattern.test(plan.releaseVersion),'Invalid release version');
  for(const key of ['sourceSha','sourceTree','releaseCommit','releaseTree'])check(gitPattern.test(plan[key]),'Invalid source identity');
  check(plan.sourceTree===plan.releaseTree,'Release tree differs from qualified source');
  ownKeys(plan.counts,['archives','installations','lifecycleReports','frameworkFiles'],'counts');
  check(plan.counts.archives===7&&plan.counts.installations===12&&plan.counts.lifecycleReports===18&&Number.isSafeInteger(plan.counts.frameworkFiles)&&plan.counts.frameworkFiles>0&&plan.counts.frameworkFiles<=8192,'Incomplete qualification counts');
  ownKeys(plan.runs,['ci','artifacts','performance'],'runs');
  for(const key of ['ci','artifacts',...(plan.runs.performance?['performance']:[])]){
    const run=plan.runs[key];ownKeys(run,['id','attempt','sha','conclusion','workflow','jobs'],'run');
    check(Number.isSafeInteger(run.id)&&run.id>0&&Number.isSafeInteger(run.attempt)&&run.attempt>0&&run.sha===plan.sourceSha&&run.conclusion==='success','Unqualified source run');
    if(run.workflow)check(run.workflow===`.github/workflows/${{ci:'ci.yml',artifacts:'npm-artifacts.yml',performance:'performance-qualification.yml'}[key]}`,'Unexpected qualification workflow');
    if(run.jobs){
      check(Array.isArray(run.jobs)&&run.jobs.length>0&&run.jobs.length<=128,'Invalid job provenance');
      for(const job of run.jobs){ownKeys(job,['id','name','conclusion'],'job');check(Number.isSafeInteger(job.id)&&job.id>0&&typeof job.name==='string'&&job.name.length<=200&&['success','skipped'].includes(job.conclusion),'Invalid job provenance');}
    }
  }
  check(Array.isArray(plan.packages)&&plan.packages.length===7,'Exactly seven packages required');
  const root=await realpath(directory),records=[];
  let total=0;
  for(const expected of releasePackages){
    const matches=plan.packages.filter(record=>record.name===expected.name);
    check(matches.length===1,'Missing or duplicate package');
    const record=matches[0];
    ownKeys(record,['name','version','filename','sha256','size','integrity','kind','platform','binarySha256','registry'],'package');
    check(record.version===plan.releaseVersion,'Package version mismatch');
    check(record.kind===(expected.platform?'native':'framework'),'Package kind mismatch');
    check((record.platform??null)===expected.platform,'Package platform mismatch');
    ownKeys(record.registry,['name','status','sha256','integrity'],'registry qualification');
    check(['absent','exact-existing'].includes(record.registry.status),'Invalid qualified registry status');
    if(record.registry.name)check(record.registry.name===record.name,'Qualified registry package mismatch');
    if(record.registry.status==='exact-existing')check(record.registry.sha256===record.sha256&&record.registry.integrity===record.integrity,'Qualified registry digest mismatch');
    check(typeof record.filename==='string'&&/^[a-z0-9.-]+\.tgz$/.test(record.filename),'Unsafe archive filename');
    check(record.filename===`${record.name.replace(/^@/,'').replaceAll('/','-')}-${record.version}.tgz`,'Unexpected archive filename');
    check(shaPattern.test(record.sha256)&&Number.isSafeInteger(record.size)&&record.size>0&&record.size<=32*1024**2,'Invalid archive digest/size');
    const filename=path.join(root,record.filename),stat=await lstat(filename);
    check(stat.isFile()&&stat.size===record.size,'Archive must be a matching regular file');
    const archive=await readFile(filename);
    check(sha(archive)===record.sha256&&integrity(archive)===record.integrity,'Archive digest mismatch');
    total+=archive.length;check(total<=128*1024**2,'Release archive budget exceeded');
    const entries=readPublishArchive(archive);
    const manifest=JSON.parse(entries.get('package/package.json').toString('utf8'));
    check(manifest.name===record.name&&manifest.version===record.version&&!manifest.private,'Archive package identity mismatch');
    check(manifest.repository?.url==='git+https://github.com/Lorkydey/PRNext.git','Archive repository mismatch');
    if(manifest.publishConfig){
      ownKeys(manifest.publishConfig,['access','tag','registry'],'publishConfig');
      check(manifest.publishConfig.registry===registry&&manifest.publishConfig.access==='public','Archive publishConfig refused');
      check(['alpha','latest'].includes(manifest.publishConfig.tag),'Archive tag refused');
    }
    if(expected.platform){
      const descriptor=JSON.parse(entries.get('package/native.json')?.toString('utf8')||'null');
      check(descriptor?.id===expected.platform&&descriptor.package===record.name&&descriptor.version===record.version,'Native descriptor identity mismatch');
      check(descriptor.os===expected.os&&descriptor.cpu===expected.cpu&&(descriptor.libc??null)===(expected.libc??null),'Native target mismatch');
      const binary=entries.get('package/bin/prnext'+(expected.os==='win32'?'.exe':''));
      check(binary&&shaPattern.test(record.binarySha256)&&sha(binary)===record.binarySha256&&descriptor.sha256===record.binarySha256,'Native executable digest mismatch');
      check(JSON.stringify(manifest.os)===JSON.stringify([expected.os])&&JSON.stringify(manifest.cpu)===JSON.stringify([expected.cpu]),'Native manifest target mismatch');
      if(expected.libc)check(JSON.stringify(manifest.libc)===JSON.stringify([expected.libc]),'Native libc mismatch');
    }else{
      const dependencies=manifest.optionalDependencies||{};
      check(Object.keys(dependencies).length===6&&releasePackages.filter(p=>p.platform).every(p=>dependencies[p.name]===record.version),'Framework native dependency alignment mismatch');
    }
    records.push({...record,archive});
  }
  return {plan,planSha256,records};
}

export function checkOidcEnvironment(env,nodeVersion){
  check(nodeVersion==='24.22.1','Publisher requires Node 24.22.1');
  check(env.GITHUB_ACTIONS==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux','Publisher requires a standard GitHub-hosted Linux runner');
  check(env.GITHUB_REPOSITORY==='Lorkydey/PRNext'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_EVENT_NAME==='workflow_dispatch','Untrusted workflow context');
  check(env.GITHUB_WORKFLOW_REF==='Lorkydey/PRNext/.github/workflows/publish.yml@refs/heads/main','Untrusted publishing workflow');
  check(/^[1-9]\d{0,3}$/.test(env.GITHUB_RUN_ATTEMPT),'Invalid GitHub run attempt');
  check(typeof env.ACTIONS_ID_TOKEN_REQUEST_URL==='string'&&env.ACTIONS_ID_TOKEN_REQUEST_URL.startsWith('https://')&&!!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,'GitHub OIDC permission missing');
  for(const [key,value] of Object.entries(env)){
    if(value&&(/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN|COREPACK_NPM_TOKEN)$/i.test(key)||/^npm_config_.*(?:auth|token|password|username)/i.test(key)))fail('Legacy npm credentials are refused');
  }
}
export function checkNpmVersion(version){
  const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  check(match,'Invalid npm version');
  const [major,minor]=match.slice(1).map(Number);
  // Dist-tag OIDC support is newer than publish support (11.5.1).
  check((major===11&&minor>=21)||(major===12&&minor>=2)||major>12,'npm version lacks trusted dist-tag support');
}

export function isolatedNpmEnvironment(env,stage){
  const result={...env};
  for(const key of Object.keys(result))if(/^npm_config_/i.test(key)||/^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key))delete result[key];
  Object.assign(result,{NPM_CONFIG_USERCONFIG:path.join(stage,'user.npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(stage,'global.npmrc'),NPM_CONFIG_CACHE:path.join(stage,'cache'),NPM_CONFIG_REGISTRY:registry,NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_PROVENANCE:'true',NPM_CONFIG_UPDATE_NOTIFIER:'false',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'});
  return result;
}

const npmCodePattern=/^[A-Z][A-Z0-9_]{0,63}$/;
const npmSubprocessFailures=new WeakMap();
function preserveNpmFailure(source,target){
  if(npmCodePattern.test(source.npmCode))target.npmCode=source.npmCode;
  if(Number.isInteger(source.exitCode))target.exitCode=source.exitCode;
  const diagnostic=npmSubprocessFailures.get(source);
  if(diagnostic){target.npmSubprocessFailure=diagnostic;npmSubprocessFailures.set(target,diagnostic);}
}

export async function runNpm(args,{env,cwd,npmCli}){
  const cli=await realpath(npmCli),runnerTemp=await realpath(env.RUNNER_TEMP);
  const relative=path.relative(runnerTemp,cli);
  check(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&cli.replaceAll('\\','/').endsWith('/node_modules/npm/bin/npm-cli.js'),'npm CLI must be the isolated runner tool');
  check((await lstat(cli)).isFile(),'npm CLI must be a regular file');
  return new Promise((resolve,reject)=>{
    const started=performance.now(),outputHash=createHash('sha256');
    const child=spawn(process.execPath,[cli,...args],{env,cwd,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const chunks=[];let size=0,exceeded=false,timedOut=false,settled=false;
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{size+=chunk.length;outputHash.update(chunk);if(size<=128*1024)chunks.push(chunk);else{exceeded=true;child.kill('SIGTERM');}});
    let killTimeout;
    const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killTimeout=setTimeout(()=>child.kill('SIGKILL'),5000);},180000);
    const failure=(message,code,signal)=>{
      const error=Error(message);
      error.exitCode=code;
      const text=stripVTControlCharacters(Buffer.concat(chunks).toString('utf8'));
      const match=/(?:npm (?:ERR!|error) code\s+|"code"\s*:\s*")([A-Z][A-Z0-9_]{0,63})(?=\s|"|$)/.exec(text);
      if(match)error.npmCode=match[1];
      // Only process metadata leaves this boundary, never captured text or environment.
      const diagnostic=Object.freeze({exitCode:code,signal,elapsedMs:Math.round(performance.now()-started),timedOut,outputLimitExceeded:exceeded,outputBytes:size,outputSha256:outputHash.copy().digest('hex')});
      error.npmSubprocessFailure=diagnostic;npmSubprocessFailures.set(error,diagnostic);
      return error;
    };
    child.once('error',()=>{
      if(settled)return;settled=true;
      clearTimeout(timeout);clearTimeout(killTimeout);
      reject(failure('npm subprocess could not start',null,null));
    });
    child.once('close',(code,signal)=>{
      if(settled)return;settled=true;
      clearTimeout(timeout);clearTimeout(killTimeout);
      if(code!==0||exceeded||timedOut)reject(failure('npm subprocess failed; outcome requires registry reconciliation',code,signal));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const registryReadFailures=new WeakMap();
const transientStatuses=new Set([408,429,500,502,503,504]);
const transientCodes=new Set(['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);

function registryReader(fetcher,pause,now){
  const state={budgetMs:180000,elapsedMs:0,retries:[],omittedRetries:0,propagation:{budgetMs:360000,waitedMs:0,rounds:0}};
  const failure=(context,code,message='Registry read failed')=>{
    const error=Error(message);
    registryReadFailures.set(error,{...context,code});
    return error;
  };
  const contextFor=(record,phase,operation,attempt=0,status=null)=>({phase,operation,package:record.name,status,attempt});
  const elapsedSince=start=>Math.max(0,now()-start);
  const validate=(condition,context,code,message)=>{
    if(!condition)throw failure(context,code,message);
  };
  // Cancellation is bounded separately: a broken stream must not retain the
  // publisher indefinitely or start overlapping retries while still active.
  const cancel=async(body,context)=>{
    if(!body)return;
    let timer;
    try{
      const completed=await Promise.race([
        Promise.resolve().then(()=>body.cancel()).then(()=>true,()=>true),
        new Promise(resolve=>{timer=setTimeout(()=>resolve(false),250);})
      ]);
      validate(completed,context,'CANCEL_TIMEOUT','Registry read failed');
    }finally{clearTimeout(timer);}
  };
  const get=async(record,phase,operation,url,maximum)=>{
    const started=now(),remaining=state.budgetMs-state.elapsedMs,allowance=Math.min(30000,remaining);
    let context=contextFor(record,phase,operation),timer,rejectDeadline;
    if(allowance<=0)throw failure(context,'READ_BUDGET_EXHAUSTED');
    const controller=new AbortController();
    const timeoutCode=remaining<=30000?'READ_BUDGET_EXHAUSTED':'REQUEST_TIMEOUT';
    const interrupted=new Promise((_,reject)=>{rejectDeadline=reject;});
    const expired=()=>elapsedSince(started)>=allowance;
    const guard=()=>{if(expired())throw failure(context,timeoutCode);};
    const wait=async promise=>{
      guard();
      const value=await Promise.race([promise,interrupted]);
      guard();
      return value;
    };
    timer=setTimeout(()=>{
      const error=failure(context,timeoutCode);
      controller.abort(error);
      rejectDeadline(error);
    },allowance);
    try{
      for(let attempt=1;attempt<=3;attempt++){
        context=contextFor(record,phase,operation,attempt);
        try{
          const headers={Accept:operation==='archive'?'application/octet-stream':'application/json',...((operation==='metadata'||operation==='tags'||phase==='reconciliation'&&operation==='packument')?{'Cache-Control':'no-cache'}:{})};
          const fetching=Promise.resolve().then(()=>fetcher(url,{redirect:'error',signal:controller.signal,headers}));
          // If a fetch adapter settles after cancellation, discard its body too.
          fetching.then(response=>{if(controller.signal.aborted)void cancel(response.body,context).catch(()=>{});},()=>{});
          const response=await wait(fetching);
          validate(Number.isInteger(response.status)&&response.status>=100&&response.status<=599,context,'INVALID_RESPONSE','Registry read failed');
          context={...context,status:response.status};
          if(response.status!==200){
            await cancel(response.body,context);
            guard();
            if(response.status===404)return {status:404,context};
            throw failure(context,transientStatuses.has(response.status)?'HTTP_TRANSIENT':'HTTP_STATUS');
          }
          validate(response.body,context,'INVALID_RESPONSE','Registry response missing');
          const reader=response.body.getReader(),chunks=[];
          let length=0,done=false;
          try{
            for(;;){
              const item=await wait(reader.read());
              if(item.done){done=true;break;}
              length+=item.value.byteLength;
              validate(length<=maximum,context,'RESPONSE_LIMIT','Registry response exceeds bound');
              chunks.push(item.value);
            }
          }finally{
            try{if(!done)await cancel(reader,context);}
            finally{reader.releaseLock();}
          }
          const bytes=Buffer.concat(chunks,length);
          guard();
          return {status:200,bytes,context};
        }catch(error){
          let diagnostic=registryReadFailures.get(error);
          if(!diagnostic){
            const code=transientCodes.has(error?.code)?error.code:transientCodes.has(error?.cause?.code)?error.cause.code:'NETWORK_FAILURE';
            error=failure(context,code);
            diagnostic=registryReadFailures.get(error);
          }
          const retryable=diagnostic.code==='HTTP_TRANSIENT'||transientCodes.has(diagnostic.code);
          if(!retryable||attempt===3||expired())throw error;
          if(state.retries.length<64)state.retries.push(diagnostic);
          else state.omittedRetries++;
          await wait(pause(250*attempt));
        }
      }
    }finally{
      clearTimeout(timer);
      controller.abort();
      state.elapsedMs+=elapsedSince(started);
    }
  };
  const propagationWait=async(record,phase)=>{
    const context=contextFor(record,phase,'metadata');
    validate(state.elapsedMs+5000<=state.budgetMs,context,'READ_BUDGET_EXHAUSTED','Registry read failed');
    const started=now();
    try{await pause(5000);}
    finally{state.elapsedMs+=elapsedSince(started);}
    validate(state.elapsedMs<state.budgetMs,context,'READ_BUDGET_EXHAUSTED','Registry read failed');
  };
  const json=response=>{
    try{return JSON.parse(response.bytes.toString('utf8'));}
    catch{throw failure(response.context,'INVALID_JSON','Invalid registry JSON');}
  };
  const postBatchWait=async(record,phase='post-batch')=>{
    const p=state.propagation,context=contextFor(record,phase,phase==='tag-final'?'tags':'metadata');
    validate(p.waitedMs<p.budgetMs,context,'PROPAGATION_BUDGET_EXHAUSTED','Published archives are accepted; registry verification is still pending');
    const delay=Math.min(5000*2**Math.min(p.rounds,3),30000,p.budgetMs-p.waitedMs);
    // Waiting for accepted writes has its own bounded allowance. The unchanged
    // network-read budget still bounds GET work and excludes npm subprocesses.
    await pause(delay);p.waitedMs+=delay;p.rounds++;
  };
  return {state,get,validate,json,propagationWait,postBatchWait};
}
function registryUrl(record){return registry+encodeURIComponent(record.name)+'/'+encodeURIComponent(record.version);}
async function registryVersion(record,reads,phase){
  const response=await reads.get(record,phase,'metadata',registryUrl(record),2*1024**2);
  if(response.status===404)return {status:'absent'};
  const manifest=reads.json(response);
  reads.validate(manifest?.name===record.name&&manifest.version===record.version,response.context,'PACKAGE_IDENTITY','Registry package identity conflict');
  reads.validate(manifest.dist?.integrity===record.integrity,response.context,'INTEGRITY_CONFLICT','Registry integrity conflict');
  let url;
  try{url=new URL(manifest.dist.tarball);}catch{}
  reads.validate(url?.origin==='https://registry.npmjs.org'&&!url.username&&!url.password&&!url.search&&!url.hash,response.context,'ARCHIVE_URL','Untrusted registry archive URL');
  const archive=await reads.get(record,phase,'archive',url.href,record.size);
  if(archive.status===404)return {status:'pending-existing'};
  const bytes=archive.bytes;
  reads.validate(bytes.length===record.size&&sha(bytes)===record.sha256,archive.context,'ARCHIVE_CONFLICT','Registry archive byte conflict');
  return {status:'exact-existing'};
}
async function registryTags(record,reads,phase){
  const response=await reads.get(record,phase,'tags',registry+'-/package/'+encodeURIComponent(record.name)+'/dist-tags',128*1024);
  reads.validate(response.status===200,response.context,'HTTP_STATUS','Registry dist-tags unavailable');
  const tags=reads.json(response);
  reads.validate(tags&&typeof tags==='object'&&!Array.isArray(tags),response.context,'INVALID_TAGS','Invalid dist-tags');
  return tags;
}
async function observeVersions(records,reads,onVerified=async()=>{},verified=[]){
  const pending=new Set(records);
  while(pending.size){
    for(const record of pending){
      const status=await registryVersion(record,reads,'post-batch');
      if(status.status!=='exact-existing')continue;
      await onVerified(record);
      verified.push({name:record.name,version:record.version,filename:record.filename,size:record.size,sha256:record.sha256,integrity:record.integrity});
      pending.delete(record);
    }
    if(pending.size)await reads.postBatchWait(pending.values().next().value);
  }
  verified.sort((a,b)=>records.findIndex(r=>r.name===a.name)-records.findIndex(r=>r.name===b.name));
  return verified;
}
async function observeTags(records,reads,verified,packages=[]){
  const pending=new Set(records);
  while(pending.size){
    for(const record of pending){
      const tags=await registryTags(record,reads,'tag-final');checkTagMonotonicity(tags,record.version);
      if(tags.alpha!==record.version||tags.latest!==record.version)continue;
      packages.push({...verified.find(p=>p.name===record.name),tags:{alpha:tags.alpha,latest:tags.latest}});
      pending.delete(record);
    }
    if(pending.size)await reads.postBatchWait(pending.values().next().value,'tag-final');
  }
  packages.sort((a,b)=>records.findIndex(r=>r.name===a.name)-records.findIndex(r=>r.name===b.name));
  return packages;
}
// Read-only observation shared with finalization. No npm subprocess, journal
// mutation, credentials or publication permission is available on this path.
export async function observePublishedRegistry(records,adapters={}){
  check(records.length===7&&new Set(records.map(r=>r.name)).size===7,'Seven distinct registry packages are required');
  const pause=adapters.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  const reads=registryReader(adapters.fetch||fetch,pause,adapters.now||(()=>performance.now()));
  const verified=await observeVersions(records,reads);
  return {packages:await observeTags(records,reads,verified),registryReads:reads.state};
}

export function checkTagMonotonicity(tags,version){
  const target=versionPattern.exec(version);
  check(target,'Unsupported alpha version');
  const parts=match=>match.slice(1).map((part,index)=>part===undefined?-1:Number(part));
  const expected=parts(target);
  check(expected.every(Number.isSafeInteger),'Version exceeds comparison bound');
  for(const tag of ['alpha','latest']){
    const match=typeof tags[tag]==='string'&&versionPattern.exec(tags[tag]);
    check(match,'Missing or incomparable registry tag');
    const current=parts(match);
    check(current.every(Number.isSafeInteger),'Tag exceeds comparison bound');
    const first=current.findIndex((part,index)=>part!==expected[index]);
    check(first===-1||current[first]<expected[first],'Registry tag is newer; refusing downgrade');
  }
}

export async function appendJournal(filename,event){
  const handle=await open(filename,'a',0o600);
  try{await handle.writeFile(JSON.stringify(event)+'\n','utf8');await handle.sync();}
  finally{await handle.close();}
}
async function journalState(filename,identity,records){
  let bytes;
  try{bytes=await readFile(filename);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!bytes){
    const handle=await open(filename,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({type:'init',...identity})+'\n');await handle.sync();}finally{await handle.close();}
    return [];
  }
  check(bytes.length<=2*1024**2&&bytes.at(-1)===10,'Incomplete or excessive durable journal');
  const events=bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(events.shift(),{type:'init',...identity},'Journal belongs to different release inputs');
  const names=new Map(records.map(p=>[p.name,p.sha256])),started=new Set(),completed=new Set(),tagsStarted=new Set();
  let done=false;
  for(const event of events){
    check(!done,'Journal contains events after completion');
    ownKeys(event,['type','name','sha256','tag'],'journal event');
    check(['publish-started','publish-completed','publish-uncertain','registry-verified','tag-started','tag-completed','done'].includes(event.type),'Unknown journal event');
    if(event.type==='done'){check(Object.keys(event).length===1,'Invalid journal completion');done=true;continue;}
    if(event.type!=='done')check(names.has(event.name),'Invalid journal package');
    if(event.tag)check(['alpha','latest'].includes(event.tag),'Invalid journal tag');
    if(event.type.startsWith('publish-')||event.type==='registry-verified')check(event.sha256===names.get(event.name),'Journal archive identity mismatch');
    if(event.type==='publish-started'){check(!started.has(event.name),'Repeated publication attempt in journal');started.add(event.name);}
    if(event.type==='publish-completed'){check(started.has(event.name)&&!completed.has(event.name),'Invalid publication completion');completed.add(event.name);}
    if(event.type==='publish-uncertain')check(started.has(event.name)&&!completed.has(event.name),'Invalid uncertain publication');
    if(event.type==='tag-started'){check(event.tag,'Missing journal tag');tagsStarted.add(event.name+':'+event.tag);}
    if(event.type==='tag-completed')check(event.tag&&tagsStarted.has(event.name+':'+event.tag),'Invalid tag completion');
  }
  return events;
}

async function loadReconciliation(options,input,env){
  if(options.provenanceSha256!==undefined)check(shaPattern.test(options.provenanceSha256),'Invalid provenance digest');
  if(options.reconcileRun===undefined||options.reconcileRun==='')return null;
  check(typeof options.reconcileRun==='string'&&/^[1-9]\d*$/.test(options.reconcileRun)&&Number.isSafeInteger(Number(options.reconcileRun)),'Invalid reconciliation run');
  check(shaPattern.test(options.provenanceSha256),'Reconciliation requires the exact provenance digest');
  const filename=path.join(path.dirname(path.resolve(options.plan)),'receipts','provenance.json'),info=await lstat(filename);
  check(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=2*1024**2,'Physical bounded provenance required');
  check(await realpath(filename)===filename,'Canonical provenance required');
  const bytes=await readFile(filename);
  check(bytes.length===info.size&&sha(bytes)===options.provenanceSha256,'Provenance digest mismatch');
  const provenance=JSON.parse(bytes.toString('utf8'));
  for(const [kind,run]of Object.entries(input.plan.runs))for(const key of ['id','attempt','sha','conclusion'])check(provenance.runs?.[kind]?.[key]===run[key],'Provenance source run differs');
  const history=provenance.publicationHistory,currentRunId=Number(env.GITHUB_RUN_ID),runId=Number(options.reconcileRun);
  check(Number.isSafeInteger(currentRunId)&&currentRunId>0&&currentRunId!==runId&&history?.currentRunId===currentRunId,'Provenance current run differs');
  check(Array.isArray(history.attempts)&&history.attempts.length<=1000,'Invalid publication history');
  const matches=history.attempts.filter(row=>row.reconciliation);
  check(matches.length===1,'Exactly one explicit reconciliation required');
  const parent=matches[0],value=parent.reconciliation;
  ownKeys(value,['kind','runId','attempt','source','sourceTree','releaseCommit','version','name','sha256','previousPlanSha256','journalSha256','previousState','requestedBy','requiresApproval','observation'],'reconciliation');
  for(const [key,wanted]of Object.entries({kind:'explicit-uncertain-absence',runId,attempt:1,source:input.plan.sourceSha,sourceTree:input.plan.sourceTree,releaseCommit:input.plan.releaseCommit,version:input.plan.releaseVersion,previousState:'uncertain',requiresApproval:'npm-release'}))check(value[key]===wanted,'Reconciliation identity differs');
  assert.deepEqual(value.requestedBy,{login:'Lorkydey',id:57268822},'Reconciliation owner differs');
  check(parent.runId===runId&&parent.attempt===1&&parent.status==='reconciled'&&parent.done===false,'Historical attempt differs');
  check(shaPattern.test(value.previousPlanSha256)&&value.previousPlanSha256===parent.planSha256&&shaPattern.test(value.journalSha256)&&value.journalSha256===parent.journalSha256,'Historical digest differs');
  const record=input.records.find(row=>row.name===value.name);
  check(record&&record.sha256===value.sha256,'Reconciliation archive differs');
  assert.deepEqual(parent.started,[record.name],'Only one uncertain upload can be reconciled');
  assert.deepEqual(parent.accepted,[record.name],'Historical reservation differs');
  assert.deepEqual(parent.completed,[],'A completed upload cannot be reconciled as absent');
  const observation=value.observation;
  check(observation?.name===record.name&&observation.version===record.version,'Reconciliation observation differs');
  if(observation.status==='exact-existing'){
    check(record.registry.status==='exact-existing'&&observation.sha256===record.sha256&&observation.integrity===record.integrity,'Known existing archive differs');
  }else{
    check(observation.status==='absent'&&record.registry.status==='absent','Only qualified absence can be rechecked');
    check(!history.attempts.some(row=>row!==parent&&(row.done===true||row.completed?.includes(record.name)||row.accepted?.includes(record.name))),'Another historical reservation cannot be reconciled as absent');
  }
  return {record,value};
}

export async function publishRelease(options,adapters={}){
  const env=adapters.env||process.env,fetcher=adapters.fetch||fetch,npm=adapters.runNpm||runNpm;
  const pause=adapters.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  const append=adapters.appendJournal||appendJournal;
  const reads=registryReader(fetcher,pause,adapters.now||(()=>performance.now()));
  checkOidcEnvironment(env,adapters.nodeVersion||process.versions.node);
  const input=await loadPublishInputs(options);
  const reconciliation=await loadReconciliation(options,input,env);
  try{await lstat(options.summary);fail('Summary already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  let journalExists=false;
  try{check((await lstat(options.journal)).isFile(),'Journal must be a regular file');journalExists=true;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  check(Number(env.GITHUB_RUN_ATTEMPT)===1||journalExists,'A job rerun without its journal is refused; start a newly qualified dispatch');
  const identity={schemaVersion:1,planSha256:input.planSha256,releaseVersion:input.plan.releaseVersion,sourceSha:input.plan.sourceSha,releaseCommit:input.plan.releaseCommit};
  await mkdir(path.dirname(options.journal),{recursive:true});
  await mkdir(path.dirname(options.summary),{recursive:true});
  const events=await journalState(options.journal,identity,input.records);
  const terminal=events.some(event=>event.type==='done');
  const log=async event=>{await append(options.journal,event);events.push(event);};
  const stage=await mkdtemp(path.join(tmpdir(),'prnext-publish-'));
  const npmEnv=isolatedNpmEnvironment(env,stage);
  const npmContext={env:npmEnv,cwd:stage,npmCli:options.npmCli};
  let result={schemaVersion:1,status:'incomplete',passed:false,version:input.plan.releaseVersion,sourceSha:input.plan.sourceSha,sourceTree:input.plan.sourceTree,releaseCommit:input.plan.releaseCommit,planSha256:input.planSha256,complete:false,publishedPackages:[],verifiedPackages:[],packages:[],distTagsVerified:false,registryReads:reads.state};
  let failure;
  try{
    await writeFile(path.join(stage,'user.npmrc'),'',{flag:'wx',mode:0o600});
    await writeFile(path.join(stage,'global.npmrc'),'',{flag:'wx',mode:0o600});
    for(const record of input.records)await writeFile(path.join(stage,record.filename),record.archive,{flag:'wx',mode:0o400});
    checkNpmVersion(await npm(['--version'],npmContext));
    const pending=[];
    // Finish every preflight before the first upload. Prior attempts that are
    // still absent are ambiguous, never permission to replay a publication.
    for(const record of input.records){
      const attempted=terminal||record.registry.status==='exact-existing'||events.some(event=>event.name===record.name&&(event.type.startsWith('publish-')||event.type==='registry-verified'));
      let status=await registryVersion(record,reads,'preflight');
      const requireExisting=attempted||status.status==='pending-existing';
      if(requireExisting)for(let retry=0;retry<12&&status.status!=='exact-existing';retry++){await reads.propagationWait(record,'preflight');status=await registryVersion(record,reads,'preflight');}
      check(!requireExisting||status.status==='exact-existing','Prior publication remains ambiguous; refusing replay');
      if(status.status==='absent')pending.push(record);
      else if(!terminal)await log({type:'registry-verified',name:record.name,sha256:record.sha256});
    }
    let tagMutationNeeded=false;
    for(const record of input.records){
      const tags=await registryTags(record,reads,'tag-preflight');checkTagMonotonicity(tags,record.version);
      if(terminal)check(tags.alpha===record.version&&tags.latest===record.version,'Completed publication tags changed; refusing mutation');
      if(tags.alpha!==record.version||tags.latest!==record.version)tagMutationNeeded=true;
    }
    if(pending.length||tagMutationNeeded)for(const record of input.records){
      const output=await npm(['publish',path.join(stage,record.filename),'--dry-run','--ignore-scripts','--tag','latest','--access','public','--registry',registry,'--loglevel','verbose','--json'],npmContext);
      const lines=stripVTControlCharacters(output).split(/\r?\n/);
      // A successful dry-run alone permits missing credentials. Require the pinned
      // CLI's successful OIDC exchange trace; this does not validate provenance.
      const confirmed=lines.includes('npm verbose oidc Successfully retrieved and set token');
      const rejected=lines.some(line=>/^npm (?:warn publish This command requires you to be logged in to |ERR! |error )/.test(line));
      if(!confirmed||rejected){
        const error=Error('npm dry-run did not confirm trusted OIDC authentication');
        error.npmCode='OIDC_AUTH_UNCONFIRMED';throw error;
      }
    }
    if(reconciliation){
      const {record,value:old}=reconciliation,pendingIndex=pending.indexOf(record);
      // Authentication can take time. Refresh the selected version and canonical
      // views afterwards, immediately before the uninterrupted upload batch.
      const status=await registryVersion(record,reads,'reconciliation-final');
      let observation;
      if(status.status==='exact-existing'){
        if(pendingIndex!==-1){
          pending.splice(pendingIndex,1);
          if(!terminal)await log({type:'registry-verified',name:record.name,sha256:record.sha256});
        }
        observation={name:record.name,version:record.version,status:'exact-existing',sha256:record.sha256,integrity:record.integrity};
      }else{
        const attempted=terminal||record.registry.status==='exact-existing'||events.some(event=>event.name===record.name&&(event.type.startsWith('publish-')||event.type==='registry-verified'));
        check(status.status==='absent'&&pendingIndex!==-1&&!attempted&&old.observation.status==='absent','A new or known accepted attempt cannot be reconciled as absent');
        const bodies=[];let context;
        for(const url of registryAbsenceUrls(record)){
          const response=await reads.get(record,'reconciliation','packument',url,2*1024**2);
          context=response.context;
          reads.validate(response.status===200,context,'RECONCILIATION_UNAVAILABLE','Registry reconciliation unavailable');
          bodies.push(response.bytes);
        }
        try{observation=confirmRegistryAbsenceViews(record,...bodies);}
        catch{reads.validate(false,context,'RECONCILIATION_CONFLICT','Registry reconciliation conflict');}
      }
      reads.state.reconciliation={runId:old.runId,attempt:old.attempt,name:old.name,version:old.version,sha256:old.sha256,previousPlanSha256:old.previousPlanSha256,journalSha256:old.journalSha256,previousState:'uncertain',observation};
    }
    for(const record of pending){
      // No registry downloads, installs or additional validation between uploads.
      await log({type:'publish-started',name:record.name,sha256:record.sha256});
      try{
        await npm(['publish',path.join(stage,record.filename),'--ignore-scripts','--tag','latest','--access','public','--registry',registry],npmContext);
      }catch(error){
        await log({type:'publish-uncertain',name:record.name,sha256:record.sha256});
        const failure=Error('Publication failed or uncertain; retain journal and reconcile before resuming');
        preserveNpmFailure(error,failure);
        throw failure;
      }
      await log({type:'publish-completed',name:record.name,sha256:record.sha256});
      result.publishedPackages.push(record.name);
    }
    // Observe the accepted batch as a whole. Verified packages are removed
    // from the pending set; a stale metadata/tarball response is read again,
    // never permission to upload again or to advance dist-tags early.
    await observeVersions(input.records,reads,async record=>{if(!terminal)await log({type:'registry-verified',name:record.name,sha256:record.sha256});},result.verifiedPackages);
    for(const record of input.records){
      const tags=await registryTags(record,reads,'tag-update');
      checkTagMonotonicity(tags,record.version);
      if(terminal){check(tags.alpha===record.version&&tags.latest===record.version,'Completed publication tags changed; refusing mutation');continue;}
      for(const tag of ['alpha','latest']){
        if(tags[tag]===record.version)continue;
        check(!events.some(event=>event.type==='tag-completed'&&event.name===record.name&&event.tag===tag),'Previously completed tag changed; refusing overwrite');
        await log({type:'tag-started',name:record.name,tag});
        await npm(['dist-tag','add',`${record.name}@${record.version}`,tag,'--registry',registry],npmContext);
        await log({type:'tag-completed',name:record.name,tag});
      }
    }
    await observeTags(input.records,reads,result.verifiedPackages,result.packages);
    result.distTagsVerified=true;
    if(!terminal)await log({type:'done'});
    result.complete=true;
  }catch(error){
    failure=error;result.failure='Publication or verification incomplete; inspect durable journal';
    const diagnostic=registryReadFailures.get(error);
    if(diagnostic)result.registryReadFailure=diagnostic;
    if(npmCodePattern.test(error.npmCode))result.npmCode=error.npmCode;
    if(Number.isInteger(error.exitCode))result.subprocessExitCode=error.exitCode;
    const npmDiagnostic=npmSubprocessFailures.get(error);
    if(npmDiagnostic)result.npmSubprocessFailure=npmDiagnostic;
  }
  finally{
    try{check(path.dirname(stage)===tmpdir()&&path.basename(stage).startsWith('prnext-publish-'),'Unexpected staging cleanup target');await rm(stage,{recursive:true,force:true});}
    catch{result.complete=false;result.cleanupFailed=true;failure||=Error('Publisher staging cleanup failed');}
    result.passed=result.complete&&!failure;
    result.status=result.passed?'passed':'incomplete';
    await writeFile(options.summary,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(failure)throw failure;
  return result;
}

export function parsePublishArguments(args){
  const required=['plan','directory','planSha256','journal','summary','npmCli'];
  const allowed=new Map([['--plan','plan'],['--directory','directory'],['--plan-sha256','planSha256'],['--journal','journal'],['--summary','summary'],['--npm-cli','npmCli'],['--reconcile-run','reconcileRun'],['--provenance-sha256','provenanceSha256']]);
  const options={};
  for(let i=0;i<args.length;i++){
    const key=allowed.get(args[i]);
    check(key&&!Object.hasOwn(options,key)&&typeof args[i+1]==='string'&&(args[i+1]!==''||key==='reconcileRun')&&!args[i+1].startsWith('--'),'Invalid publisher arguments');
    options[key]=args[++i];
  }
  check(required.every(key=>Object.hasOwn(options,key))&&shaPattern.test(options.planSha256),'Missing publisher arguments');
  if(options.provenanceSha256!==undefined)check(shaPattern.test(options.provenanceSha256),'Invalid provenance digest');
  if(options.reconcileRun!==undefined&&options.reconcileRun!=='')check(/^[1-9]\d*$/.test(options.reconcileRun)&&Number.isSafeInteger(Number(options.reconcileRun))&&shaPattern.test(options.provenanceSha256),'Invalid reconciliation arguments');
  check(path.resolve(options.journal)!==path.resolve(options.summary),'Journal and summary must differ');
  return options;
}
function isMain(){
  if(!process.argv[1])return false;
  try{return realpathSync.native(process.argv[1])===realpathSync.native(fileURLToPath(import.meta.url));}
  catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return false;throw error;}
}
if(isMain()){
  try{const result=await publishRelease(parsePublishArguments(process.argv.slice(2)));console.log(JSON.stringify(result));}
  catch{console.error('Release publication did not complete; retain the durable journal and summary.');process.exitCode=1;}
}
