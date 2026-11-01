import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile,open,lstat,realpath,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

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

export async function runNpm(args,{env,cwd,npmCli}){
  const cli=await realpath(npmCli),runnerTemp=await realpath(env.RUNNER_TEMP);
  const relative=path.relative(runnerTemp,cli);
  check(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&cli.replaceAll('\\','/').endsWith('/node_modules/npm/bin/npm-cli.js'),'npm CLI must be the isolated runner tool');
  check((await lstat(cli)).isFile(),'npm CLI must be a regular file');
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{env,cwd,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const chunks=[];let size=0,exceeded=false;
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{size+=chunk.length;if(size<=128*1024)chunks.push(chunk);else{exceeded=true;child.kill('SIGTERM');}});
    let killTimeout;
    const timeout=setTimeout(()=>{child.kill('SIGTERM');killTimeout=setTimeout(()=>child.kill('SIGKILL'),5000);},180000);
    child.once('error',()=>{clearTimeout(timeout);clearTimeout(killTimeout);reject(Error('npm subprocess could not start'));});
    child.once('close',code=>{
      clearTimeout(timeout);clearTimeout(killTimeout);
      const text=Buffer.concat(chunks).toString('utf8');
      if(code!==0||exceeded){
        const error=Error('npm subprocess failed; outcome requires registry reconciliation');
        error.exitCode=code;
        const match=/(?:npm (?:ERR!|error) code\s+|"code"\s*:\s*")(E[A-Z0-9_]{1,32})/.exec(text);
        if(match)error.npmCode=match[1];
        reject(error);
      }else resolve(text);
    });
  });
}

async function boundedResponse(response,maximum){
  check(response.body,'Registry response missing');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;check(length<=maximum,'Registry response exceeds bound');chunks.push(item.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,length);
}
function registryUrl(record){return registry+encodeURIComponent(record.name)+'/'+encodeURIComponent(record.version);}
async function registryVersion(record,fetcher){
  const response=await fetcher(registryUrl(record),{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/json'}});
  if(response.status===404){await response.body?.cancel();return {status:'absent'};}
  check(response.status===200,'Registry preflight unavailable');
  const manifest=JSON.parse((await boundedResponse(response,2*1024**2)).toString('utf8'));
  check(manifest.name===record.name&&manifest.version===record.version,'Registry package identity conflict');
  check(manifest.dist?.integrity===record.integrity,'Registry integrity conflict');
  const url=new URL(manifest.dist.tarball);
  check(url.origin==='https://registry.npmjs.org'&&!url.username&&!url.password&&!url.search&&!url.hash,'Untrusted registry archive URL');
  const archive=await fetcher(url.href,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(archive.status===404){await archive.body?.cancel();return {status:'pending-existing'};}
  check(archive.status===200,'Registry archive unavailable');
  const bytes=await boundedResponse(archive,record.size);
  check(bytes.length===record.size&&sha(bytes)===record.sha256,'Registry archive byte conflict');
  return {status:'exact-existing'};
}
async function registryTags(record,fetcher){
  const response=await fetcher(registry+'-/package/'+encodeURIComponent(record.name)+'/dist-tags',{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'application/json'}});
  check(response.status===200,'Registry dist-tags unavailable');
  const tags=JSON.parse((await boundedResponse(response,128*1024)).toString('utf8'));
  check(tags&&typeof tags==='object'&&!Array.isArray(tags),'Invalid dist-tags');
  return tags;
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

export async function publishRelease(options,adapters={}){
  const env=adapters.env||process.env,fetcher=adapters.fetch||fetch,npm=adapters.runNpm||runNpm;
  const pause=adapters.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  const append=adapters.appendJournal||appendJournal;
  checkOidcEnvironment(env,adapters.nodeVersion||process.versions.node);
  const input=await loadPublishInputs(options);
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
  let result={schemaVersion:1,status:'incomplete',passed:false,version:input.plan.releaseVersion,sourceSha:input.plan.sourceSha,sourceTree:input.plan.sourceTree,releaseCommit:input.plan.releaseCommit,planSha256:input.planSha256,complete:false,publishedPackages:[],verifiedPackages:[],packages:[],distTagsVerified:false};
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
      let status=await registryVersion(record,fetcher);
      const requireExisting=attempted||status.status==='pending-existing';
      if(requireExisting)for(let retry=0;retry<12&&status.status!=='exact-existing';retry++){await pause(5000);status=await registryVersion(record,fetcher);}
      check(!requireExisting||status.status==='exact-existing','Prior publication remains ambiguous; refusing replay');
      if(status.status==='absent')pending.push(record);
      else if(!terminal)await log({type:'registry-verified',name:record.name,sha256:record.sha256});
    }
    for(const record of input.records){
      const tags=await registryTags(record,fetcher);checkTagMonotonicity(tags,record.version);
      if(terminal)check(tags.alpha===record.version&&tags.latest===record.version,'Completed publication tags changed; refusing mutation');
    }
    for(const record of pending){
      // No registry downloads, installs or additional validation between uploads.
      await log({type:'publish-started',name:record.name,sha256:record.sha256});
      try{
        await npm(['publish',path.join(stage,record.filename),'--ignore-scripts','--tag','latest','--access','public','--registry',registry],npmContext);
      }catch(error){
        await log({type:'publish-uncertain',name:record.name,sha256:record.sha256});
        const failure=Error('Publication failed or uncertain; retain journal and reconcile before resuming');
        if(/^E[A-Z0-9_]{1,32}$/.test(error.npmCode))failure.npmCode=error.npmCode;
        if(Number.isInteger(error.exitCode))failure.exitCode=error.exitCode;
        throw failure;
      }
      await log({type:'publish-completed',name:record.name,sha256:record.sha256});
      result.publishedPackages.push(record.name);
    }
    // Only after the complete upload batch: bounded propagation then exact bytes.
    for(const record of input.records){
      let status=await registryVersion(record,fetcher);
      for(let retry=0;retry<12&&status.status!=='exact-existing';retry++){await pause(5000);status=await registryVersion(record,fetcher);}
      check(status.status==='exact-existing','Published archive has not propagated');
      if(!terminal)await log({type:'registry-verified',name:record.name,sha256:record.sha256});
      result.verifiedPackages.push({name:record.name,version:record.version,filename:record.filename,size:record.size,sha256:record.sha256,integrity:record.integrity});
    }
    for(const record of input.records){
      const tags=await registryTags(record,fetcher);
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
    for(const record of input.records){
      const tags=await registryTags(record,fetcher);check(tags.alpha===record.version&&tags.latest===record.version,'Final registry tags mismatch');
      result.packages.push({...result.verifiedPackages.find(p=>p.name===record.name),tags:{alpha:tags.alpha,latest:tags.latest}});
    }
    result.distTagsVerified=true;
    if(!terminal)await log({type:'done'});
    result.complete=true;
  }catch(error){
    failure=error;result.failure='Publication or verification incomplete; inspect durable journal';
    if(/^E[A-Z0-9_]{1,32}$/.test(error.npmCode))result.npmCode=error.npmCode;
    if(Number.isInteger(error.exitCode))result.subprocessExitCode=error.exitCode;
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
  const allowed=new Map([['--plan','plan'],['--directory','directory'],['--plan-sha256','planSha256'],['--journal','journal'],['--summary','summary'],['--npm-cli','npmCli']]);
  const options={};
  for(let i=0;i<args.length;i++){
    const key=allowed.get(args[i]);
    check(key&&!Object.hasOwn(options,key)&&args[i+1]&&!args[i+1].startsWith('--'),'Invalid publisher arguments');
    options[key]=args[++i];
  }
  check(Object.keys(options).length===allowed.size&&shaPattern.test(options.planSha256),'Missing publisher arguments');
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
