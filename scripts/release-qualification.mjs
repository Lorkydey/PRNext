// The qualification job reads candidate data. It never imports candidate code,
// runs a candidate script, publishes a package, or changes GitHub state.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,mkdtemp,rm,lstat,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {isDeepStrictEqual} from 'node:util';
import {unzipSync} from 'fflate';
import {isMainModule} from './main-module.mjs';
import {platforms} from '../packages/prnext/native/resolve.mjs';
import {archiveFilename,archiveDigest,readArchive,verifyExactArtifacts,verifyLifecycleArtifacts} from './verify-npm-artifacts.mjs';
import {checkReleaseRegression} from '../tests/performance/release-regression-check.mjs';

export const repository='Lorkydey/PRNext';
const shaPattern=/^[a-f0-9]{40}$/;
const compare=(a,b)=>a<b?-1:a>b?1:0;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const blobHash=bytes=>createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
const json=bytes=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
const maxPayload=512*1024**2,maxArchive=64*1024**2;
const safeName=name=>typeof name==='string'&&name.length<=240&&!name.includes('\0')&&!name.includes('\\')&&!name.includes(':')&&!name.startsWith('/')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
const fail=message=>{throw new Error(message);};

export function validateInputs(input){
  const value={...input};
  assert.match(value.version||'',/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,'Provide one exact release version.');
  assert.ok(value.version.length<=100&&!value.version.split('-').slice(1).join('-').split('.').some(v=>/^0\d+$/.test(v)),'Invalid prerelease version.');
  for(const key of ['source','releaseCommit'])assert.match(value[key]||'',shaPattern,`Provide a full lowercase ${key} SHA.`);
  for(const key of ['ciRun','artifactRun','performanceRun']){
    if(key==='performanceRun'&&(value[key]===undefined||value[key]===null||value[key]==='')){value[key]=null;continue;}
    assert.ok(/^[1-9]\d*$/.test(String(value[key]))&&Number.isSafeInteger(Number(value[key])),`Provide a positive integer ${key} ID.`);value[key]=Number(value[key]);
  }
  assert.ok(typeof value.output==='string'&&value.output.trim()&&!value.output.includes('\0'),'Provide a dedicated output directory.');
  value.output=path.resolve(value.output);return value;
}

export async function boundedBody(response,limit){
  const length=response.headers.get('content-length');if(length!==null)assert.ok(/^\d+$/.test(length)&&Number(length)<=limit,'Downloaded evidence exceeds its bound.');
  assert.ok(response.body,'Evidence response has no body.');const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit){await reader.cancel();fail('Downloaded evidence exceeds its bound.');}chunks.push(part.value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}

export function githubReader({token=process.env.GITHUB_TOKEN,fetchImpl=fetch}={}){
  assert.ok(typeof token==='string'&&token,'A read-only GitHub token is required.');
  async function response(resource){
    assert.ok(resource.startsWith(`repos/${repository}/`)&&!resource.includes('..'),'GitHub repository boundary rejected.');
    const r=await fetchImpl('https://api.github.com/'+resource,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(60000)});
    assert.ok(r.ok,`GitHub evidence request failed (HTTP ${r.status}).`);assert.equal(new URL(r.url||'https://api.github.com').protocol,'https:');return r;
  }
  return {json:async resource=>json(await boundedBody(await response(resource),48*1024**2)),zip:async resource=>boundedBody(await response(resource),128*1024**2)};
}

// Inspect ZIP metadata before inflation. File bytes are written only under
// fixed allowlisted basenames; Unix links and special files are never accepted.
export function inspectZip(bytes,{allowed,limits=new Map(),maxEntries=100,maxBytes=maxPayload}={}){
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length<=128*1024**2,'ZIP evidence is too large.');let end=-1;
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(bytes.readUInt32LE(p)===0x06054b50&&p+22+bytes.readUInt16LE(p+20)===bytes.length){end=p;break;}
  assert.ok(end>=0,'ZIP directory is missing.');assert.equal(bytes.readUInt16LE(end+4),0);assert.equal(bytes.readUInt16LE(end+6),0);
  const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),central=bytes.readUInt32LE(end+16);
  assert.equal(bytes.readUInt16LE(end+8),count);assert.ok(count>0&&count<=maxEntries&&count<65535&&central+centralSize===end,'Unsupported or incomplete ZIP directory.');
  let at=central,total=0;const files=new Map(),basenames=new Set();
  for(let i=0;i<count;i++){
    assert.ok(at+46<=end&&bytes.readUInt32LE(at)===0x02014b50,'Invalid ZIP entry.');
    const nameLength=bytes.readUInt16LE(at+28),extraLength=bytes.readUInt16LE(at+30),commentLength=bytes.readUInt16LE(at+32),next=at+46+nameLength+extraLength+commentLength;
    assert.ok(next<=end,'Truncated ZIP entry.');const name=new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(at+46,at+46+nameLength));
    const type=(bytes.readUInt32LE(at+38)>>>16)&0xf000,directory=name.endsWith('/'),clean=directory?name.slice(0,-1):name;
    assert.ok(safeName(clean)&&![0xa000].includes(type)&&(type===0||type===(directory?0x4000:0x8000)),'Unsafe ZIP path or link.');
    assert.ok(!(bytes.readUInt16LE(at+8)&1)&&[0,8].includes(bytes.readUInt16LE(at+10)),'Unsupported ZIP encryption/compression.');
    const size=bytes.readUInt32LE(at+24),compressed=bytes.readUInt32LE(at+20);assert.ok(compressed<=bytes.length&&bytes.readUInt32LE(at+42)<central,'Invalid ZIP extent.');
    if(!directory){const base=path.posix.basename(name);assert.ok(!files.has(name)&&!basenames.has(base),'Duplicate ZIP file.');
      assert.ok(!allowed||allowed.has(base),'Unexpected ZIP file.');const limit=limits.get(name)??limits.get(base)??(base.endsWith('.tgz')?maxArchive:1024**2);
      total+=size;assert.ok(size>0&&size<=limit&&total<=maxBytes,'ZIP payload exceeds its bound.');files.set(name,{base,size});basenames.add(base);
    }else assert.equal(size,0,'ZIP directory has payload.');at=next;
  }
  assert.equal(at,end);const extracted=unzipSync(bytes,{filter:entry=>files.has(entry.name)}),result=new Map();
  assert.equal(Object.keys(extracted).length,files.size);
  for(const [name,record]of files){const value=Buffer.from(extracted[name]);assert.equal(value.length,record.size,'ZIP size mismatch.');result.set(name,value);}
  return result;
}

export function validateRun(run,jobs,{id,source,workflow,archives=false}){
  assert.equal(run.id,id);assert.equal(run.repository?.full_name,repository);assert.equal(run.head_repository?.full_name,repository);
  assert.equal(run.head_sha,source,'Workflow source differs.');assert.equal(run.status,'completed');assert.equal(run.conclusion,'success','Workflow has not passed.');
  assert.equal(run.path,`.github/workflows/${workflow}`,'Unexpected qualification workflow.');assert.ok(Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0);
  assert.equal(jobs.jobs.length,jobs.total_count,'Incomplete job inventory.');assert.ok(jobs.jobs.length>0&&jobs.jobs.length<=100);
  assert.ok(jobs.jobs.every(j=>j.head_sha===source&&j.status==='completed'&&['success','skipped'].includes(j.conclusion)),'A workflow job did not pass.');
  if(archives){assert.equal(jobs.jobs.length,6);assert.ok(jobs.jobs.every(j=>j.conclusion==='success'));for(const target of platforms)assert.equal(jobs.jobs.filter(j=>j.name.includes(target.id)).length,1,'Missing or ambiguous native target job.');}
  if(workflow==='ci.yml')assert.equal(jobs.jobs.filter(j=>j.name==='CI result'&&j.conclusion==='success').length,1,'Required CI result gate did not pass.');
  return {id,attempt:run.run_attempt,sha:source,conclusion:'success',workflow:run.path,jobs:jobs.jobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion})).sort((a,b)=>a.id-b.id)};
}

async function list(api,resource,key){const value=await api.json(resource+'?per_page=100');assert.equal(value[key].length,value.total_count,`Incomplete ${key} inventory.`);return value[key];}
async function artifactBytes(api,artifact){assert.ok(!artifact.expired&&Number.isSafeInteger(artifact.id)&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest||''),'Artifact is expired or has no immutable digest.');const bytes=await api.zip(`repos/${repository}/actions/artifacts/${artifact.id}/zip`);assert.equal('sha256:'+hash(bytes),artifact.digest,'GitHub ZIP digest differs.');return bytes;}

export async function collectPackageArtifacts(api,{runId,attempt,version}){
  const listing=await list(api,`repos/${repository}/actions/runs/${runId}/artifacts`,'artifacts');
  assert.deepEqual(listing.map(a=>a.name).sort(),platforms.map(p=>'npm-alpha-'+p.id).sort(),'Expected exactly six native artifacts.');
  const payload=new Map(),evidence=[];let total=0;
  for(const target of [...platforms].sort((a,b)=>compare(a.id,b.id))){
    const artifact=listing.find(a=>a.name==='npm-alpha-'+target.id);
    const allowed=new Set([archiveFilename('@thomas.f/prnext',version),archiveFilename(target.package,version),`verified-${target.id}.json`,`verified-${target.id}-nested.json`,...[22,24,26].map(n=>`lifecycle-${target.id}-node${n}.json`)]);
    const zip=await artifactBytes(api,artifact),entries=inspectZip(zip,{allowed});assert.deepEqual([...entries.keys()].map(n=>path.posix.basename(n)).sort(),[...allowed].sort(),'Incomplete artifact payload.');
    for(const [name,value]of entries){const base=path.posix.basename(name);if(payload.has(base))assert.ok(payload.get(base).equals(value),'Conflicting framework archives.');else{total+=value.length;assert.ok(total<=maxPayload);payload.set(base,value);}}
    evidence.push({id:artifact.id,name:artifact.name,runId,attempt,zipSha256:hash(zip),digest:artifact.digest});
  }
  assert.equal(payload.size,37);return {payload,evidence};
}

async function mapLimit(values,limit,fn){const result=new Array(values.length);let at=0;await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{for(;;){const i=at++;if(i>=values.length)return;result[i]=await fn(values[i],i);}}));return result;}

export async function readSource(api,{source,releaseCommit,version}){
  const [candidate,release,main]=await Promise.all([api.json(`repos/${repository}/git/commits/${source}`),api.json(`repos/${repository}/git/commits/${releaseCommit}`),api.json(`repos/${repository}/git/ref/heads/main`)]);
  assert.equal(candidate.sha,source);assert.equal(release.sha,releaseCommit);assert.match(candidate.tree?.sha||'',shaPattern);assert.equal(release.tree.sha,candidate.tree.sha,'Release commit tree differs from tested source.');assert.match(main.object?.sha||'',shaPattern);
  const ancestry=await api.json(`repos/${repository}/compare/${releaseCommit}...${main.object.sha}`);assert.equal(ancestry.merge_base_commit?.sha,releaseCommit,'Release commit is not on main.');assert.ok(['ahead','identical'].includes(ancestry.status));
  const tree=await api.json(`repos/${repository}/git/trees/${candidate.tree.sha}?recursive=1`);assert.equal(tree.sha,candidate.tree.sha);assert.equal(tree.truncated,false,'Source tree was truncated.');assert.ok(Array.isArray(tree.tree)&&tree.tree.length<=30000);
  const selected=tree.tree.filter(e=>e.type==='blob'&&(e.path.startsWith('packages/prnext/')||['package.json','crates/prnext/Cargo.toml','Cargo.lock'].includes(e.path)));
  assert.ok(selected.length>0&&selected.length<=10000);const files=new Map();let total=0;
  await mapLimit(selected,6,async entry=>{
    assert.ok(safeName(entry.path)&&['100644','100755'].includes(entry.mode)&&shaPattern.test(entry.sha),'Unsafe source entry or symbolic link.');assert.ok(Number.isInteger(entry.size)&&entry.size<=32*1024**2);
    const value=await api.json(`repos/${repository}/git/blobs/${entry.sha}`);assert.equal(value.sha,entry.sha);assert.equal(value.encoding,'base64');assert.equal(value.size,entry.size);
    const data=Buffer.from(value.content.replace(/\s/g,''),'base64');assert.equal(data.length,entry.size);assert.equal(blobHash(data),entry.sha,'Git source blob differs.');total+=data.length;assert.ok(total<=256*1024**2,'Source data exceeds its bound.');assert.ok(!files.has(entry.path),'Duplicate Git source path.');files.set(entry.path,{data,sha:entry.sha,mode:entry.mode});
  });
  const manifest=json(files.get('packages/prnext/package.json')?.data);assert.equal(manifest.name,'@thomas.f/prnext');assert.equal(manifest.version,version);assert.equal(json(files.get('package.json')?.data).version,version);
  assert.deepEqual(manifest.optionalDependencies,Object.fromEntries(platforms.map(p=>[p.package,version])),'The seven package versions are not aligned.');
  assert.deepEqual(json(files.get('packages/prnext/native/platforms.json')?.data),platforms,'Native platform identities changed.');
  const cargo=files.get('crates/prnext/Cargo.toml')?.data.toString('utf8'),section=cargo?.match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];assert.equal(section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],version,'Cargo source version differs.');
  return {source,tree:candidate.tree.sha,releaseCommit,releaseTree:release.tree.sha,main:main.object.sha,files,manifest};
}

export async function npmFileList(files,{npmCli}={}){
  if(!npmCli){
    const nodeDirectory=path.dirname(process.execPath);
    for(const candidate of [path.join(nodeDirectory,'node_modules/npm/bin/npm-cli.js'),path.resolve(nodeDirectory,'../lib/node_modules/npm/bin/npm-cli.js')]){
      try{if((await lstat(candidate)).isFile()){npmCli=candidate;break;}}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    }
    assert.ok(npmCli,'Use a Node distribution with bundled npm for the independent package file list.');
  }
  const parent=path.resolve(tmpdir()),work=await mkdtemp(path.join(parent,'prnext-release-qualification-'));
  try{
    for(const [name,{data,mode}]of files){if(!name.startsWith('packages/prnext/'))continue;const relative=name.slice('packages/prnext/'.length);assert.ok(safeName(relative));if(relative==='.npmrc')continue;const target=path.join(work,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data,{flag:'wx',mode:parseInt(mode,8)&0o777});}
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_|^NPM_|^GITHUB_TOKEN$|^GH_TOKEN$|^ACTIONS_.*TOKEN|^ACTIONS_ID_TOKEN_REQUEST_URL$|^NODE_AUTH_TOKEN$|^NODE_OPTIONS$|^NODE_PATH$|^NODE_TEST_CONTEXT$/i.test(k)));
    Object.assign(env,{npm_config_userconfig:path.join(work,'.unused-user-config'),npm_config_globalconfig:path.join(work,'.unused-global-config'),npm_config_cache:path.join(work,'.npm-cache'),npm_config_registry:'https://registry.npmjs.org/'});
    const {stdout}=await promisify(execFile)(process.execPath,[npmCli,'pack','--dry-run','--ignore-scripts','--json'],{cwd:work,env,windowsHide:true,timeout:120000,maxBuffer:8*1024**2});
    const result=JSON.parse(stdout);assert.equal(result.length,1);assert.ok(Array.isArray(result[0].files)&&result[0].files.length<=10000);return result[0].files.map(f=>{assert.ok(safeName(f.path));return 'package/'+f.path;}).sort();
  }finally{assert.equal(path.dirname(work),parent);assert.ok(path.basename(work).startsWith('prnext-release-qualification-'));await rm(work,{recursive:true,force:true});}
}

export function verifySourceArchive(bytes,sourceFiles,expectedFiles){
  const archive=readArchive(bytes);assert.deepEqual([...archive.keys()].sort(),[...expectedFiles].sort(),'Framework pack file list differs from independent npm selection.');
  const proof=[];for(const [name,entry]of archive){const file='packages/prnext/'+name.slice('package/'.length),source=sourceFiles.get(file);assert.ok(source,`Archive has no source blob: ${name}`);assert.equal(blobHash(entry.data),source.sha,`Archive source bytes differ: ${name}`);assert.ok(entry.data.equals(source.data));proof.push({file,gitBlob:source.sha,sha256:hash(entry.data),bytes:entry.data.length});}return proof.sort((a,b)=>compare(a.file,b.file));
}

export async function registryPreflight(packages,{fetchImpl=fetch}={}){
  const result=[];for(const pkg of packages){
    const response=await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,{signal:AbortSignal.timeout(30000)});
    if(response.status===404){await response.body?.cancel();result.push({name:pkg.name,status:'absent'});continue;}
    assert.equal(response.status,200,`${pkg.name}: registry preflight failed.`);const metadata=json(await boundedBody(response,2*1024**2));assert.equal(metadata.name,pkg.name);assert.equal(metadata.version,pkg.version);
    assert.equal(metadata.dist?.integrity,pkg.integrity,'Existing version has conflicting integrity.');const url=new URL(metadata.dist.tarball);assert.equal(url.origin,'https://registry.npmjs.org');assert.equal(url.username,'');assert.equal(url.password,'');
    const tar=await fetchImpl(url,{signal:AbortSignal.timeout(60000)});assert.equal(tar.status,200);const data=await boundedBody(tar,pkg.size);assert.equal(data.length,pkg.size);assert.equal(hash(data),pkg.sha256,'Existing version has conflicting bytes.');assert.equal(archiveDigest(data).integrity,pkg.integrity);
    result.push({name:pkg.name,status:'exact-existing',sha256:pkg.sha256,integrity:pkg.integrity});
  }return result;
}

export function publicationHistoryContext(env=process.env){
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_WORKFLOW_REF!==`${repository}/.github/workflows/publish.yml@refs/heads/main`)return null;
  assert.ok(/^[1-9]\d*$/.test(env.GITHUB_RUN_ID||'')&&Number.isSafeInteger(Number(env.GITHUB_RUN_ID)),'Publication history requires an exact current run ID.');
  if(env.GITHUB_REPOSITORY!==undefined)assert.equal(env.GITHUB_REPOSITORY,repository);
  return {currentRunId:Number(env.GITHUB_RUN_ID)};
}

// An interrupted upload is an accepted attempt, even if its acknowledgement
// was lost. A new dispatch may proceed only after its exact bytes are public.
export function parsePublicationJournal(bytes,{version,source,releaseCommit,packages}){
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=2*1024**2&&bytes.at(-1)===10,'Incomplete or excessive publication journal.');
  const lines=new TextDecoder('utf8',{fatal:true}).decode(bytes).slice(0,-1).split('\n');assert.ok(lines.length<=1000&&lines.every(line=>line.length>0),'Invalid publication journal lines.');
  const events=lines.map(line=>JSON.parse(line)),init=events.shift();
  assert.deepEqual(Object.keys(init).sort(),['type','schemaVersion','planSha256','releaseVersion','sourceSha','releaseCommit'].sort(),'Invalid journal initialization.');
  assert.equal(init.type,'init');assert.equal(init.schemaVersion,1);assert.match(init.planSha256||'',/^[a-f0-9]{64}$/);
  assert.equal(init.releaseVersion,version,'Historical journal version differs.');assert.equal(init.sourceSha,source,'Historical journal source differs.');assert.equal(init.releaseCommit,releaseCommit,'Historical journal release differs.');
  const names=new Map(packages.map(pkg=>[pkg.name,pkg])),started=new Set(),completed=new Set(),accepted=new Set(),tags=new Set();let done=false;
  for(const event of events){
    assert.ok(event&&typeof event==='object'&&!Array.isArray(event)&&!done,'Invalid publication journal event.');
    assert.ok(Object.keys(event).every(key=>['type','name','sha256','tag'].includes(key)),'Unexpected journal event field.');
    assert.ok(['publish-started','publish-completed','publish-uncertain','registry-verified','tag-started','tag-completed','done'].includes(event.type),'Unknown publication journal event.');
    if(event.type==='done'){assert.deepEqual(event,{type:'done'});done=true;continue;}
    const pkg=names.get(event.name);assert.ok(pkg,'Unknown historical package.');
    if(event.type.startsWith('publish-')||event.type==='registry-verified'){
      assert.deepEqual(Object.keys(event).sort(),['type','name','sha256'].sort());assert.equal(event.sha256,pkg.sha256,'Historical package bytes differ.');
    }else{assert.deepEqual(Object.keys(event).sort(),['type','name','tag'].sort());assert.ok(['alpha','latest'].includes(event.tag));}
    if(event.type==='publish-started'){assert.ok(!started.has(event.name),'Repeated historical publication.');started.add(event.name);accepted.add(event.name);}
    if(event.type==='registry-verified')accepted.add(event.name);
    if(event.type==='publish-completed'){assert.ok(started.has(event.name)&&!completed.has(event.name),'Invalid historical completion.');completed.add(event.name);}
    if(event.type==='publish-uncertain')assert.ok(started.has(event.name)&&!completed.has(event.name),'Invalid historical uncertainty.');
    if(event.type==='tag-started')tags.add(event.name+':'+event.tag);
    if(event.type==='tag-completed')assert.ok(tags.has(event.name+':'+event.tag),'Invalid historical tag completion.');
  }
  for(const name of accepted)assert.equal(names.get(name).registry?.status,'exact-existing',`${name}: a previous upload is not yet verifiable; refusing another publication.`);
  return {planSha256:init.planSha256,started:[...started].sort(compare),completed:[...completed].sort(compare),accepted:[...accepted].sort(compare),done};
}

export async function verifyPublicationHistory(api,{currentRunId,version,source,releaseCommit,packages}){
  assert.ok(Number.isSafeInteger(currentRunId)&&currentRunId>0);let runs=[],expected;
  for(let page=1;page<=10;page++){
    const result=await api.json(`repos/${repository}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`);
    assert.ok(Number.isSafeInteger(result.total_count)&&result.total_count>=0&&result.total_count<=1000,'Publication history exceeds the 1000-run qualification bound.');
    if(expected===undefined)expected=result.total_count;else assert.equal(result.total_count,expected,'Publication history changed during collection.');
    assert.ok(Array.isArray(result.workflow_runs)&&result.workflow_runs.length<=100);runs.push(...result.workflow_runs);
    if(runs.length===expected)break;assert.ok(runs.length<expected&&result.workflow_runs.length===100,'Incomplete publication history.');
  }
  assert.equal(runs.length,expected,'Incomplete publication history.');assert.equal(new Set(runs.map(run=>run.id)).size,runs.length,'Repeated history run.');
  const evidence=[];let attempts=0;
  for(const run of runs.filter(run=>run.id!==currentRunId&&run.display_title===`PRNext ${version} release`).sort((a,b)=>a.id-b.id)){
    assert.ok(Number.isSafeInteger(run.id)&&run.id>0&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0,'Invalid historical run identity.');
    assert.equal(run.path,'.github/workflows/publish.yml');assert.equal(run.event,'workflow_dispatch');assert.equal(run.repository?.full_name,repository);
    assert.equal(run.status,'completed','Another release dispatch is still active.');attempts+=run.run_attempt;assert.ok(attempts<=1000,'Historical attempt bound exceeded.');let artifacts;
    for(let attempt=1;attempt<=run.run_attempt;attempt++){
      const jobs=await list(api,`repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs`,'jobs');assert.ok(jobs.length<=100);
      const steps=jobs.flatMap(job=>job.steps||[]).filter(step=>step.name==='Publish exact archives and verify both tags');assert.ok(steps.length<=1,'Ambiguous historical publication step.');
      const step=steps[0];if(!step||step.status==='completed'&&step.conclusion==='skipped'){evidence.push({runId:run.id,attempt,status:'not-started'});continue;}
      assert.equal(step.status,'completed','Historical publisher has not terminated.');
      artifacts??=await list(api,`repos/${repository}/actions/runs/${run.id}/artifacts`,'artifacts');
      const matches=artifacts.filter(item=>item.name===`release-publication-${run.id}-${attempt}`);assert.equal(matches.length,1,'Historical publication journal artifact is missing or ambiguous.');
      const artifact=matches[0],zip=await artifactBytes(api,artifact),entries=inspectZip(zip,{allowed:new Set(['journal.jsonl','registry-verification.json']),limits:new Map([['journal.jsonl',2*1024**2],['registry-verification.json',2*1024**2]]),maxEntries:4,maxBytes:4*1024**2});
      const journals=[...entries].filter(([name])=>path.posix.basename(name)==='journal.jsonl');assert.equal(journals.length,1,'Historical journal is missing.');
      const journal=parsePublicationJournal(journals[0][1],{version,source,releaseCommit,packages});
      evidence.push({runId:run.id,attempt,status:'reconciled',artifactId:artifact.id,zipSha256:hash(zip),journalSha256:hash(journals[0][1]),...journal});
    }
  }
  return {checkedRuns:runs.length,currentRunId,attempts:evidence};
}

async function performanceEvidence(api,{id,attempt,source,frameworkSha256}){
  const listing=await list(api,`repos/${repository}/actions/runs/${id}/artifacts`,'artifacts'),matches=listing.filter(a=>a.name===`controlled-performance-${id}-${attempt}`);assert.equal(matches.length,1,'Complete performance artifact is missing.');
  const artifact=matches[0],zip=await artifactBytes(api,artifact),entries=inspectZip(zip,{maxEntries:100,limits:new Map([['report.json',24*1024**2],['logs/baseline-native-build.log',16*1024**2]])});
  const reports=[...entries].filter(([name])=>name==='report.json');assert.equal(reports.length,1);const report=json(reports[0][1]),gate=checkReleaseRegression(report);assert.ok(isDeepStrictEqual(gate,report.gate),'Performance gate differs from recomputation.');assert.equal(gate.status,'passed','Performance is not qualified.');
  assert.equal(report.artifacts.candidate.source.declaredCommit,source);assert.equal(report.artifacts.candidate.archives.find(a=>a.name==='@thomas.f/prnext').sha256,frameworkSha256,'Performance framework differs from release archives.');
  return {artifact:{id:artifact.id,name:artifact.name,zipSha256:hash(zip)},status:gate.status,reportSha256:hash(reports[0][1]),measurements:report.samples.length};
}

export async function qualifyRelease(input,{api=githubReader(),fetchImpl=fetch,fileList=npmFileList,historyContext=null}={}){
  const options=validateInputs(input),out=options.output;
  try{assert.equal((await lstat(out)).isDirectory(),true);assert.equal((await lstat(out)).isSymbolicLink(),false);assert.deepEqual(await readdir(out),[],'Qualification output must be empty.');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(out,{recursive:true});}
  const source=await readSource(api,options),runSpecs=[['ci',options.ciRun,'ci.yml'],['artifacts',options.artifactRun,'npm-artifacts.yml'],...(options.performanceRun?[['performance',options.performanceRun,'performance-qualification.yml']]:[])],runs={};
  for(const [key,id,workflow]of runSpecs){const [run,jobs]=await Promise.all([api.json(`repos/${repository}/actions/runs/${id}`),api.json(`repos/${repository}/actions/runs/${id}/jobs?per_page=100`)]);runs[key]=validateRun(run,jobs,{id,source:options.source,workflow,archives:key==='artifacts'});}
  const {payload,evidence}=await collectPackageArtifacts(api,{runId:options.artifactRun,attempt:runs.artifacts.attempt,version:options.version});
  const mainName=archiveFilename('@thomas.f/prnext',options.version),main=payload.get(mainName),sourceProof=verifySourceArchive(main,source.files,await fileList(source.files));
  const staging=await mkdtemp(path.join(path.resolve(tmpdir()),'prnext-release-receipts-'));
  try{for(const [name,data]of payload)await writeFile(path.join(staging,name),data,{flag:'wx'});await verifyExactArtifacts({directory:staging,sourceManifest:source.manifest});await verifyLifecycleArtifacts({directory:staging,sourceManifest:source.manifest});}finally{assert.equal(path.dirname(staging),path.resolve(tmpdir()));assert.ok(path.basename(staging).startsWith('prnext-release-receipts-'));await rm(staging,{recursive:true,force:true});}
  const packages=[];for(const target of [...platforms].sort((a,b)=>compare(a.package,b.package))){const filename=archiveFilename(target.package,options.version),data=payload.get(filename),archive=readArchive(data),manifest=json(archive.get('package/package.json').data),descriptor=json(archive.get('package/native.json').data),binary=archive.get('package/bin/prnext'+(target.os==='win32'?'.exe':''));
    assert.equal(manifest.name,target.package);assert.equal(manifest.version,options.version);assert.equal(descriptor.id,target.id);assert.equal(descriptor.target,target.target);assert.equal(descriptor.version,options.version);assert.deepEqual(manifest.os,[target.os]);assert.deepEqual(manifest.cpu,[target.cpu]);if(target.libc)assert.deepEqual(manifest.libc,[target.libc]);assert.equal(hash(binary.data),descriptor.sha256);
    packages.push({name:target.package,version:options.version,filename,...archiveDigest(data),kind:'native',platform:target.id,binarySha256:descriptor.sha256});}
  packages.push({name:'@thomas.f/prnext',version:options.version,filename:mainName,...archiveDigest(main),kind:'framework'});
  const registry=await registryPreflight(packages,{fetchImpl});for(const pkg of packages)pkg.registry=registry.find(r=>r.name===pkg.name);
  const publicationHistory=historyContext?await verifyPublicationHistory(api,{...historyContext,version:options.version,source:options.source,releaseCommit:options.releaseCommit,packages}):null;
  const performance=options.performanceRun?await performanceEvidence(api,{id:options.performanceRun,attempt:runs.performance.attempt,source:options.source,frameworkSha256:hash(main)}):null;
  const plan={schemaVersion:1,repository,releaseVersion:options.version,sourceSha:options.source,sourceTree:source.tree,releaseCommit:options.releaseCommit,releaseTree:source.releaseTree,packages,runs,counts:{archives:7,installations:12,lifecycleReports:18,frameworkFiles:sourceProof.length}};
  const planBytes=Buffer.from(JSON.stringify(plan,null,2)+'\n'),planSha256=hash(planBytes);await mkdir(path.join(out,'archives'));await mkdir(path.join(out,'receipts'));
  for(const [name,data]of payload)await writeFile(path.join(out,name.endsWith('.tgz')?'archives':'receipts',name),data,{flag:'wx'});
  await writeFile(path.join(out,'receipts/source.json'),JSON.stringify({sourceSha:options.source,sourceTree:source.tree,releaseCommit:options.releaseCommit,main:source.main,files:sourceProof},null,2)+'\n',{flag:'wx'});
  await writeFile(path.join(out,'receipts/provenance.json'),JSON.stringify({runs,artifacts:evidence,registry,performance,publicationHistory},null,2)+'\n',{flag:'wx'});
  const qualification={schemaVersion:1,planFile:'plan.json',planSha256,sourceSha:options.source,releaseCommit:options.releaseCommit,counts:plan.counts,performance:performance?.status||'not-requested'};
  await writeFile(path.join(out,'qualification.json'),JSON.stringify(qualification,null,2)+'\n',{flag:'wx'});
  // The plan is written last. A partial or failed collection is not publishable.
  await writeFile(path.join(out,'plan.json'),planBytes,{flag:'wx'});return {plan,qualification};
}

export function parseArguments(args){const map={'--version':'version','--source':'source','--release-commit':'releaseCommit','--ci-run':'ciRun','--artifact-run':'artifactRun','--performance-run':'performanceRun','--output':'output'},value={};for(let i=0;i<args.length;i++){const key=map[args[i]];assert.ok(key&&value[key]===undefined&&args[i+1]&&!args[i+1].startsWith('--'),'Use exact --version --source --release-commit --ci-run --artifact-run [--performance-run] --output inputs.');value[key]=args[++i];}return validateInputs(value);}
if(isMainModule(import.meta.url)){
  try{const {qualification}=await qualifyRelease(parseArguments(process.argv.slice(2)),{historyContext:publicationHistoryContext()});if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`plan_sha256=${qualification.planSha256}\n`);console.log(JSON.stringify(qualification));}
  catch(error){console.error('Release qualification failed: '+String(error.message).slice(0,1200));process.exitCode=1;}
}
