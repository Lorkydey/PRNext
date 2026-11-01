import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync} from 'fflate';
import {packageManifest,platforms} from '../packages/prnext/native/resolve.mjs';
import {archiveFilename,archiveDigest,expectedMetadata,globalInstallationCheck,projectCreationCheck,reactCompilerInstallationCheck,releaseLifecycleTests,verifyExactArtifacts,verifyLifecycleArtifacts} from './verify-npm-artifacts.mjs';
import {repository,validateInputs,parseArguments,inspectZip,validateRun,collectPackageArtifacts,readSource,npmFileList,verifySourceArchive,registryPreflight,qualifyRelease,publicationHistoryContext,parsePublicationJournal,verifyPublicationHistory} from './release-qualification.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
const version=packageManifest.version,source='a'.repeat(40),releaseCommit='b'.repeat(40),main='c'.repeat(40),tree='d'.repeat(40);
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const inputs=output=>({version,source,releaseCommit,ciRun:101,artifactRun:102,output});
async function output(t){const root=await mkdtemp(path.join(tmpdir(),'prnext-qualification-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return path.join(root,'output');}

function tar(files){
 const chunks=[];for(const [name,entry]of files){const data=Buffer.isBuffer(entry)?entry:entry.data,mode=Buffer.isBuffer(entry)?0o644:entry.mode??0o644;assert.ok(Buffer.byteLength(name)<100);
  const h=Buffer.alloc(512);h.write(name);for(const [at,len,value]of [[100,8,mode],[108,8,0],[116,8,0],[124,12,data.length],[136,12,0]])h.write(value.toString(8).padStart(len-1,'0')+'\0',at,len);
  h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);chunks.push(h,data,Buffer.alloc((512-data.length%512)%512));
 }return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}

function fixture({mainOverride,missing,releaseVersion=version,sourceVersion=releaseVersion,failedJob=false}={}){
 const version=releaseVersion,manifest=structuredClone(packageManifest);manifest.version=version;manifest.optionalDependencies=Object.fromEntries(platforms.map(p=>[p.package,version]));manifest.scripts={prepack:'node forbidden-candidate-script.cjs'};
 if(sourceVersion!==version)manifest.version=sourceVersion;
 const files=new Map(Object.entries({
  'packages/prnext/package.json':encode(manifest),'packages/prnext/README.md':Buffer.from('Fixture README\n'),
  'packages/prnext/cli.mjs':Buffer.from('export const fixture = true;\n'),'packages/prnext/AI.md':Buffer.from('Fixture AI guide\n'),
  'packages/prnext/native/platforms.json':encode(platforms),'packages/prnext/.npmignore':Buffer.from('**/*.test.*\n'),
  'packages/prnext/runtime/.npmignore':Buffer.from('*.test.*\n'),
  'packages/prnext/runtime/ignored.test.mjs':Buffer.from('throw Error("never execute source");'),
  'package.json':encode({name:'fixture-root',version}),
  'crates/prnext/Cargo.toml':Buffer.from(`[package]\nname="prnext"\nversion="${version}"\n[dependencies]\n`),
  'Cargo.lock':Buffer.from('version = 4\n'),
 }).map(([name,data])=>[name,{data,mode:name.endsWith('/cli.mjs')?'100755':'100644',sha:gitBlob(data)}]));
 const packed=new Map([...files].filter(([name])=>name.startsWith('packages/prnext/')&&!name.endsWith('/.npmignore')&&!name.endsWith('.test.mjs')).map(([name,value])=>['package/'+name.slice('packages/prnext/'.length),{data:value.data,mode:parseInt(value.mode,8)&0o777}]));
 if(mainOverride)packed.set('package/AI.md',{data:Buffer.from(mainOverride)});
 const mainBytes=tar(packed),mainName=archiveFilename(packageManifest.name,version),payload=new Map([[mainName,mainBytes]]),artifacts=[],zips=new Map();
 for(let i=0;i<platforms.length;i++){
  const p=platforms[i],binary=Buffer.from('fixture-native-'+p.id),descriptor={id:p.id,target:p.target,version,sha256:sha(binary)};
  const nativeManifest={name:p.package,version,...expectedMetadata(false),os:[p.os],cpu:[p.cpu],...(p.libc?{libc:[p.libc]}:{})};
  const nativeName=archiveFilename(p.package,version),nativeBytes=tar(new Map([['package/package.json',encode(nativeManifest)],['package/native.json',encode(descriptor)],['package/bin/prnext'+(p.os==='win32'?'.exe':''),{data:binary,mode:0o755}]]));payload.set(nativeName,nativeBytes);
  const names=[mainName,nativeName],archives=names.map(filename=>({filename,...archiveDigest(payload.get(filename))}));
  const part=new Map([[mainName,mainBytes],[nativeName,nativeBytes]]);
  for(const strategy of ['hoisted','nested']){
   const report={version,platform:p.id,strategy,checks:[globalInstallationCheck,projectCreationCheck,reactCompilerInstallationCheck,...Array.from({length:10},(_,n)=>'fixture check '+n)],archives,sha256:Object.fromEntries(archives.map(a=>[a.filename,a.sha256]))};
   const name=`verified-${p.id}${strategy==='nested'?'-nested':''}.json`;part.set(name,encode(report));payload.set(name,encode(report));
  }
  for(const major of [22,24,26]){const name=`lifecycle-${p.id}-node${major}.json`,data=encode({platform:p.id,node:`v${major}.99.0`,passed:true,code:0,signal:null,tests:releaseLifecycleTests,mainArchiveSha256:sha(mainBytes),nativeArchiveSha256:sha(nativeBytes),binarySha256:sha(binary)});part.set(name,data);payload.set(name,data);}
  if(missing&&i===0)part.delete(missing===true?`lifecycle-${p.id}-node26.json`:missing);
  const bytes=Buffer.from(zipSync(Object.fromEntries(part))),id=200+i;zips.set(`repos/${repository}/actions/artifacts/${id}/zip`,bytes);artifacts.push({id,name:'npm-alpha-'+p.id,expired:false,digest:'sha256:'+sha(bytes)});
 }
 const run=(id,workflow)=>({id,path:'.github/workflows/'+workflow,head_sha:source,status:'completed',conclusion:'success',run_attempt:1,repository:{full_name:repository},head_repository:{full_name:repository}});
 const job=(id,name,conclusion='success')=>({id,name,head_sha:source,status:'completed',conclusion});
 const responses=new Map([
  [`repos/${repository}/git/commits/${source}`,{sha:source,tree:{sha:tree}}],[`repos/${repository}/git/commits/${releaseCommit}`,{sha:releaseCommit,tree:{sha:tree}}],
  [`repos/${repository}/git/ref/heads/main`,{object:{sha:main}}],[`repos/${repository}/compare/${releaseCommit}...${main}`,{status:'ahead',merge_base_commit:{sha:releaseCommit}}],
  [`repos/${repository}/git/trees/${tree}?recursive=1`,{sha:tree,truncated:false,tree:[...files].map(([name,v])=>({path:name,sha:v.sha,size:v.data.length,mode:v.mode,type:'blob'}))}],
  [`repos/${repository}/actions/runs/101`,run(101,'ci.yml')],[`repos/${repository}/actions/runs/101/jobs?per_page=100`,{total_count:1,jobs:[job(1001,'CI result')]}],
  [`repos/${repository}/actions/runs/102`,run(102,'npm-artifacts.yml')],[`repos/${repository}/actions/runs/102/jobs?per_page=100`,{total_count:6,jobs:platforms.map((p,i)=>job(1100+i,`package (${p.id})`,failedJob&&i===0?'failure':'success'))}],
  [`repos/${repository}/actions/runs/102/artifacts?per_page=100`,{total_count:6,artifacts}],
 ]);
 for(const value of files.values())responses.set(`repos/${repository}/git/blobs/${value.sha}`,{sha:value.sha,encoding:'base64',size:value.data.length,content:value.data.toString('base64')});
 const api={json:async resource=>{assert.ok(responses.has(resource),'Unexpected API path '+resource);return structuredClone(responses.get(resource));},zip:async resource=>{assert.ok(zips.has(resource));return zips.get(resource);}};
 return {api,responses,zips,files,packed,mainBytes,payload,artifacts};
}

test('strict CLI rejects ambiguous versions, refs, IDs and repeated flags',()=>{
 assert.equal(validateInputs(inputs('out')).version,version);
 for(const change of [{version:'^'+version},{version:'1.02.3'},{version:'1.2.3-01'},{source:'main'},{releaseCommit:'b'.repeat(39)},{ciRun:'1e2'},{artifactRun:'01'},{performanceRun:0},{output:''}])assert.throws(()=>validateInputs({...inputs('out'),...change}));
 assert.throws(()=>parseArguments(['--version',version,'--version',version]));
});

test('workflow validation refuses wrong source, skipped native jobs, missing gate and partial inventory',()=>{
 const f=fixture(),run=f.responses.get(`repos/${repository}/actions/runs/102`),jobs=f.responses.get(`repos/${repository}/actions/runs/102/jobs?per_page=100`),spec={id:102,source,workflow:'npm-artifacts.yml',archives:true};
 assert.equal(validateRun(run,jobs,spec).jobs.length,6);
 assert.throws(()=>validateRun({...run,head_sha:main},jobs,spec),/source differs/);
 assert.throws(()=>validateRun(run,{...jobs,jobs:jobs.jobs.slice(1)},spec),/inventory/);
 const skipped=structuredClone(jobs);skipped.jobs[0].conclusion='skipped';assert.throws(()=>validateRun(run,skipped,spec));
 const ci=f.responses.get(`repos/${repository}/actions/runs/101`);assert.throws(()=>validateRun(ci,{total_count:1,jobs:[{...jobs.jobs[0],name:'not the required gate'}]},{id:101,source,workflow:'ci.yml'}),/CI result/);
});

test('ZIP inspection rejects traversal, symlinks, unknown names and payload bounds',()=>{
 const good=Buffer.from(zipSync({'one.json':Buffer.from('{}')}));assert.equal(inspectZip(good,{allowed:new Set(['one.json'])}).size,1);
 assert.throws(()=>inspectZip(Buffer.from(zipSync({'../one.json':Buffer.from('{}')}))),/Unsafe/);
 assert.throws(()=>inspectZip(good,{allowed:new Set(['other.json'])}),/Unexpected/);
 assert.throws(()=>inspectZip(good,{limits:new Map([['one.json',1]])}),/bound/);
 const linked=Buffer.from(good);let at=0;while(at<linked.length-4&&linked.readUInt32LE(at)!==0x02014b50)at++;linked.writeUInt32LE((0xa1ff<<16)>>>0,at+38);assert.throws(()=>inspectZip(linked),/link/);
});

test('package collection refuses missing evidence, changed ZIP digest and conflicting framework bytes',async()=>{
 const missing=fixture({missing:true});await assert.rejects(collectPackageArtifacts(missing.api,{runId:102,attempt:1,version}),/Incomplete/);
 const digest=fixture();digest.responses.get(`repos/${repository}/actions/runs/102/artifacts?per_page=100`).artifacts[0].digest='sha256:'+'0'.repeat(64);await assert.rejects(collectPackageArtifacts(digest.api,{runId:102,attempt:1,version}),/digest differs/);
 const other=fixture();const first=other.artifacts[0],resource=`repos/${repository}/actions/artifacts/${first.id}/zip`;
 const entries=inspectZip(other.zips.get(resource));entries.set(archiveFilename(packageManifest.name,version),Buffer.from('changed archive'));
 const zip=Buffer.from(zipSync(Object.fromEntries(entries)));other.zips.set(resource,zip);first.digest='sha256:'+sha(zip);
 await assert.rejects(collectPackageArtifacts(other.api,{runId:102,attempt:1,version}),/Conflicting framework/);
});

test('source association refuses version changes, wrong release tree, non-main release and source links',async()=>{
 const old=fixture({sourceVersion:'0.1.18-alpha'});await assert.rejects(readSource(old.api,inputs('out')),/version|Expected values/);
 const mismatch=fixture();mismatch.responses.get(`repos/${repository}/git/commits/${releaseCommit}`).tree.sha=main;await assert.rejects(readSource(mismatch.api,inputs('out')),/tree differs/);
 const detached=fixture();detached.responses.get(`repos/${repository}/compare/${releaseCommit}...${main}`).merge_base_commit.sha=source;await assert.rejects(readSource(detached.api,inputs('out')),/not on main/);
 const linked=fixture();linked.responses.get(`repos/${repository}/git/trees/${tree}?recursive=1`).tree[0].mode='120000';await assert.rejects(readSource(linked.api,inputs('out')),/symbolic link/);
});

test('independent source comparison rejects a valid tarball with modified runtime bytes or omitted files',()=>{
 const f=fixture();assert.equal(verifySourceArchive(f.mainBytes,f.files,[...f.packed.keys()]).length,5);
 const modified=fixture({mainOverride:'modified source'});assert.throws(()=>verifySourceArchive(modified.mainBytes,modified.files,[...modified.packed.keys()]),/source bytes differ/);
 assert.throws(()=>verifySourceArchive(f.mainBytes,f.files,[...f.packed.keys()].slice(1)),/pack file list/);
});

test('npm selects files independently without running candidate lifecycle scripts or reading candidate npmrc',async t=>{
 const dir=await output(t);await mkdir(dir,{recursive:true});const marker=path.join(dir,'forbidden-script-executed');
 const f=fixture(),pkg=structuredClone(packageManifest);pkg.scripts=Object.fromEntries(['preinstall','install','postinstall','preprepare','prepare','postprepare','prepack','postpack','prepublish','prepublishOnly','publish','postpublish'].map(key=>[key,`node lifecycle-probe.cjs ${key}`]));
 const data=encode(pkg);f.files.set('packages/prnext/package.json',{data,mode:'100644',sha:gitBlob(data)});
 f.files.set('packages/prnext/lifecycle-probe.cjs',{data:Buffer.from(`require('node:fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({hook:process.argv[2]})+'\\n');\n`),mode:'100644'});
 f.files.set('packages/prnext/.npmignore',{data:Buffer.concat([f.files.get('packages/prnext/.npmignore').data,Buffer.from('/lifecycle-probe.cjs\n')]),mode:'100644'});
 f.files.set('packages/prnext/.npmrc',{data:Buffer.from('ignore-scripts=false\nregistry=http://127.0.0.1:1/\n'),mode:'100644'});
 const selected=await npmFileList(f.files);assert.deepEqual(selected,[...f.packed.keys()].sort());
 try{t.diagnostic('Forbidden lifecycle hooks: '+(await readFile(marker,'utf8')).slice(0,1000));}catch(error){if(error.code!=='ENOENT')throw error;}
 await assert.rejects(access(marker),{code:'ENOENT'});
});

test('registry preflight checks all seven absent versions and accepts only exact existing bytes for resume',async()=>{
 const f=fixture(),packages=[...f.payload].filter(([name])=>name.endsWith('.tgz')).map(([filename,data])=>{const p=filename===archiveFilename(packageManifest.name,version)?packageManifest.name:platforms.find(p=>filename===archiveFilename(p.package,version)).package;return {name:p,version,filename,...archiveDigest(data)};});
 let calls=0;const absent=await registryPreflight(packages,{fetchImpl:async()=>{calls++;return new Response('{}',{status:404});}});assert.equal(calls,7);assert.ok(absent.every(p=>p.status==='absent'));
 const pkg=packages[0],data=f.payload.get(pkg.filename),fetchImpl=async url=>String(url).endsWith('.tgz')?new Response(data):Response.json({name:pkg.name,version,dist:{integrity:pkg.integrity,tarball:'https://registry.npmjs.org/fixture.tgz'}});
 const resumed=await registryPreflight([pkg],{fetchImpl});assert.equal(resumed[0].status,'exact-existing');
 await assert.rejects(registryPreflight([pkg],{fetchImpl:async url=>String(url).endsWith('.tgz')?new Response(Buffer.from('conflict')):Response.json({name:pkg.name,version,dist:{integrity:pkg.integrity,tarball:'https://registry.npmjs.org/fixture.tgz'}})}));
 await assert.rejects(registryPreflight([pkg],{fetchImpl:async()=>new Response('{}',{status:503})}),/preflight failed/);
 await assert.rejects(registryPreflight([pkg],{fetchImpl:async()=>Response.json({name:pkg.name,version,dist:{integrity:'sha512-conflict'}})}),/conflicting integrity/);
});

test('complete data-only qualification writes a stable portable plan, seven archives and original receipts',async t=>{
 const f=fixture(),dir=await output(t);const {plan,qualification}=await qualifyRelease(inputs(dir),{api:f.api,fetchImpl:async()=>new Response('{}',{status:404})});
 assert.equal(plan.packages.length,7);assert.equal(plan.packages.at(-1).kind,'framework');assert.ok(plan.packages.slice(0,-1).every(p=>p.kind==='native'));assert.deepEqual(plan.counts,{archives:7,installations:12,lifecycleReports:18,frameworkFiles:5});
 const bytes=await readFile(path.join(dir,'plan.json'));assert.equal(qualification.planSha256,sha(bytes));assert.ok(!bytes.toString().includes(dir));assert.ok(!bytes.toString().includes('token'));assert.equal(JSON.parse(await readFile(path.join(dir,'qualification.json'))).planSha256,qualification.planSha256);
 const second=await output(t);const again=await qualifyRelease(inputs(second),{api:f.api,fetchImpl:async()=>new Response('{}',{status:404})});assert.equal(again.qualification.planSha256,qualification.planSha256,'Same immutable evidence must create the same plan bytes.');
 await assert.rejects(qualifyRelease(inputs(dir),{api:f.api}),/must be empty/);
});

test('failed workflows, source mismatch or existing conflict never produce a publishable plan',async t=>{
 for(const f of [fixture({failedJob:true}),fixture({mainOverride:'tampered framework'}),fixture()]){
  const dir=await output(t);await assert.rejects(qualifyRelease(inputs(dir),{api:f.api,fetchImpl:async()=>Response.json({name:'wrong existing package',version,dist:{integrity:'wrong'}})}));await assert.rejects(access(path.join(dir,'plan.json')),{code:'ENOENT'});
 }
});

test('a full exact-existing resume still qualifies all seven original archives without rewriting receipts',async t=>{
 const f=fixture(),dir=await output(t),byName=new Map();
 for(const [filename,data]of f.payload)if(filename.endsWith('.tgz')){
  const name=filename===archiveFilename(packageManifest.name,version)?packageManifest.name:platforms.find(p=>filename===archiveFilename(p.package,version)).package;
  byName.set(name,{filename,data,...archiveDigest(data)});
 }
 const fetchImpl=async value=>{
  const url=new URL(value);if(url.pathname.endsWith('.tgz')){const data=[...byName.values()].find(p=>'/'+p.filename===url.pathname)?.data;assert.ok(data);return new Response(data);}
  const name=decodeURIComponent(url.pathname.slice(1,-('/'+version).length)),record=byName.get(name);assert.ok(record);
  return Response.json({name,version,dist:{integrity:record.integrity,tarball:'https://registry.npmjs.org/'+record.filename}});
 };
 const {plan}=await qualifyRelease(inputs(dir),{api:f.api,fetchImpl});assert.ok(plan.packages.every(p=>p.registry.status==='exact-existing'));
 for(const [name,value]of f.payload)if(name.endsWith('.json'))assert.ok((await readFile(path.join(dir,'receipts',name))).equals(value));
});

test('source-manifest validation supports another exact version while default validation stays strict',async t=>{
 const future='0.2.0-alpha.1',f=fixture({releaseVersion:future}),dir=await output(t);
 const {plan}=await qualifyRelease({...inputs(dir),version:future},{api:f.api,fetchImpl:async()=>new Response('{}',{status:404})});
 assert.equal(plan.releaseVersion,future);assert.ok(plan.packages.every(p=>p.version===future));
 const combined=path.join(path.dirname(dir),'combined');await mkdir(combined);for(const [name,data]of f.payload)await writeFile(path.join(combined,name),data);
 await assert.rejects(verifyExactArtifacts({directory:combined}),/obsolete version/);
 await assert.rejects(verifyLifecycleArtifacts({directory:combined}),{code:'ENOENT'});
 const current=fixture(),currentDirectory=path.join(path.dirname(dir),'default-current');await mkdir(currentDirectory);for(const [name,data]of current.payload)await writeFile(path.join(currentDirectory,name),data);
 assert.equal((await verifyExactArtifacts({directory:currentDirectory})).size,6);await verifyLifecycleArtifacts({directory:currentDirectory});
});

const historyPath=page=>`repos/${repository}/actions/workflows/publish.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`;
function historyFixture({events,missing=false,attempts=1,skipped=false}={}){
 const currentRunId=900,id=800,packages=[...platforms.map(p=>p.package),packageManifest.name].map((name,index)=>({name,sha256:String(index+1).repeat(64),registry:{status:'exact-existing'}}));
 const init={type:'init',schemaVersion:1,planSha256:'f'.repeat(64),releaseVersion:version,sourceSha:source,releaseCommit};
 const journal=Buffer.from([...events||[init,{type:'publish-started',name:packages[0].name,sha256:packages[0].sha256},{type:'publish-uncertain',name:packages[0].name,sha256:packages[0].sha256}]].map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n')+'\n');
 const run={id,display_title:`PRNext ${version} release`,event:'workflow_dispatch',path:'.github/workflows/publish.yml',repository:{full_name:repository},status:'completed',run_attempt:attempts};
 const responses=new Map([[historyPath(1),{total_count:2,workflow_runs:[run,{...run,id:currentRunId,status:'in_progress'}]}]]),zips=new Map(),artifacts=[];
 for(let attempt=1;attempt<=attempts;attempt++){
  responses.set(`repos/${repository}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`,{total_count:1,jobs:[{steps:[{name:'Publish exact archives and verify both tags',status:'completed',conclusion:skipped?'skipped':'failure'}]}]});
  const zip=Buffer.from(zipSync({'journal.jsonl':journal})),artifactId=850+attempt;
  zips.set(`repos/${repository}/actions/artifacts/${artifactId}/zip`,zip);artifacts.push({id:artifactId,name:`release-publication-${id}-${attempt}`,digest:'sha256:'+sha(zip),expired:false});
 }
 responses.set(`repos/${repository}/actions/runs/${id}/artifacts?per_page=100`,{total_count:missing?0:artifacts.length,artifacts:missing?[]:artifacts});
 const api={json:async resource=>{assert.ok(responses.has(resource),'Unexpected history API '+resource);return structuredClone(responses.get(resource));},zip:async resource=>{assert.ok(zips.has(resource));return zips.get(resource);}};
 return {api,responses,zips,packages,journal,init,run,spec:{currentRunId,version,source,releaseCommit,packages}};
}

test('publication history is enabled only by the main publication CLI context',()=>{
 const env={GITHUB_ACTIONS:'true',GITHUB_WORKFLOW_REF:`${repository}/.github/workflows/publish.yml@refs/heads/main`,GITHUB_RUN_ID:'900',GITHUB_REPOSITORY:repository};
 assert.deepEqual(publicationHistoryContext(env),{currentRunId:900});
 for(const change of [{GITHUB_ACTIONS:'false'},{GITHUB_WORKFLOW_REF:`${repository}/.github/workflows/publish.yml@refs/heads/feature`}])assert.equal(publicationHistoryContext({...env,...change}),null);
 assert.throws(()=>publicationHistoryContext({...env,GITHUB_RUN_ID:'01'}));assert.throws(()=>publicationHistoryContext({...env,GITHUB_REPOSITORY:'other/repo'}));
});

test('prior uncertain uploads require exact public bytes while never-attempted packages may remain absent',async()=>{
 const f=historyFixture();for(const pkg of f.packages.slice(1))pkg.registry.status='absent';
 const result=await verifyPublicationHistory(f.api,f.spec);assert.equal(result.checkedRuns,2);assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].done,false);assert.deepEqual(result.attempts[0].started,[f.packages[0].name]);
 f.packages[0].registry.status='absent';await assert.rejects(verifyPublicationHistory(f.api,f.spec),/previous upload is not yet verifiable/);
});

test('a completed prior publication and a second page of dispatch history are reconciled',async()=>{
 const f=historyFixture(),events=[f.init];for(const pkg of f.packages)events.push({type:'publish-started',name:pkg.name,sha256:pkg.sha256},{type:'publish-completed',name:pkg.name,sha256:pkg.sha256},{type:'registry-verified',name:pkg.name,sha256:pkg.sha256});events.push({type:'done'});
 const zip=Buffer.from(zipSync({'journal.jsonl':Buffer.from(events.map(event=>JSON.stringify(event)).join('\n')+'\n')})),artifact=f.responses.get(`repos/${repository}/actions/runs/800/artifacts?per_page=100`).artifacts[0];artifact.digest='sha256:'+sha(zip);f.zips.set(`repos/${repository}/actions/artifacts/${artifact.id}/zip`,zip);
 const first=Array.from({length:100},(_,i)=>({...f.run,id:1000+i,display_title:'Another version'}));f.responses.set(historyPath(1),{total_count:101,workflow_runs:first});f.responses.set(historyPath(2),{total_count:101,workflow_runs:[f.run]});
 const result=await verifyPublicationHistory(f.api,f.spec);assert.equal(result.checkedRuns,101);assert.equal(result.attempts[0].done,true);assert.equal(result.attempts[0].completed.length,7);
});

test('a previously verified existing package is accepted durably even without a publication-started event',()=>{
 const f=historyFixture(),pkg=f.packages[0],bytes=Buffer.from([f.init,{type:'registry-verified',name:pkg.name,sha256:pkg.sha256}].map(event=>JSON.stringify(event)).join('\n')+'\n');
 const result=parsePublicationJournal(bytes,f.spec);assert.deepEqual(result.started,[]);assert.deepEqual(result.accepted,[pkg.name]);
 pkg.registry.status='absent';assert.throws(()=>parsePublicationJournal(bytes,f.spec),/previous upload is not yet verifiable/);
});

test('every historical attempt requires its own journal unless the publication step was skipped',async()=>{
 const f=historyFixture({attempts:2});assert.equal((await verifyPublicationHistory(f.api,f.spec)).attempts.length,2);
 const artifactList=f.responses.get(`repos/${repository}/actions/runs/800/artifacts?per_page=100`);artifactList.artifacts.shift();artifactList.total_count--;
 await assert.rejects(verifyPublicationHistory(f.api,f.spec),/missing or ambiguous/);
 const skipped=historyFixture({skipped:true,missing:true});assert.equal((await verifyPublicationHistory(skipped.api,skipped.spec)).attempts[0].status,'not-started');
 const missing=historyFixture({missing:true});await assert.rejects(verifyPublicationHistory(missing.api,missing.spec),/missing or ambiguous/);
});

test('historical journals reject truncation, wrong source/version, conflicting archive bytes and invalid transitions',()=>{
 const f=historyFixture(),parse=bytes=>parsePublicationJournal(bytes,f.spec);assert.equal(parse(f.journal).started.length,1);
 assert.throws(()=>parse(f.journal.subarray(0,-1)),/Incomplete/);
 for(const change of [{sourceSha:main},{releaseVersion:'0.1.18-alpha'},{releaseCommit:source},{extra:'unsafe'}])assert.throws(()=>parse(Buffer.from(JSON.stringify({...f.init,...change})+'\n')));
 const event={type:'publish-started',name:f.packages[0].name,sha256:'0'.repeat(64)};
 assert.throws(()=>parse(Buffer.from(JSON.stringify(f.init)+'\n'+JSON.stringify(event)+'\n')),/bytes differ/);
 event.sha256=f.packages[0].sha256;event.type='publish-completed';assert.throws(()=>parse(Buffer.from(JSON.stringify(f.init)+'\n'+JSON.stringify(event)+'\n')),/completion/);
 assert.throws(()=>parse(Buffer.concat([f.journal,Buffer.from('{"type":"unrecognized"}\n')])),/Unknown/);
});

test('historical evidence rejects wrong ZIP bytes, unexpected files, active dispatches and excessive or partial history',async()=>{
 const f=historyFixture(),artifactList=f.responses.get(`repos/${repository}/actions/runs/800/artifacts?per_page=100`),artifact=artifactList.artifacts[0];artifact.digest='sha256:'+'0'.repeat(64);
 await assert.rejects(verifyPublicationHistory(f.api,f.spec),/digest differs/);
 const unexpected=Buffer.from(zipSync({'journal.jsonl':f.journal,'secret.txt':Buffer.from('not accepted')}));artifact.digest='sha256:'+sha(unexpected);f.zips.set(`repos/${repository}/actions/artifacts/${artifact.id}/zip`,unexpected);
 await assert.rejects(verifyPublicationHistory(f.api,f.spec),/Unexpected ZIP/);
 const listing=f.responses.get(historyPath(1));listing.workflow_runs[0].status='in_progress';await assert.rejects(verifyPublicationHistory(f.api,f.spec),/still active/);
 listing.total_count=1001;await assert.rejects(verifyPublicationHistory(f.api,f.spec),/1000-run/);
 listing.total_count=3;await assert.rejects(verifyPublicationHistory(f.api,f.spec),/Incomplete/);
});

test('a missing previous journal or ambiguous upload prevents any new qualification plan',async t=>{
 for(const missing of [true,false]){
  const f=fixture(),history=historyFixture({missing}),dir=await output(t);
  const api={json:resource=>f.responses.has(resource)?f.api.json(resource):history.api.json(resource),zip:resource=>f.zips.has(resource)?f.api.zip(resource):history.api.zip(resource)};
  await assert.rejects(qualifyRelease(inputs(dir),{api,fileList:async()=>[...f.packed.keys()].sort(),fetchImpl:async()=>new Response('{}',{status:404}),historyContext:{currentRunId:900}}));
  await assert.rejects(access(path.join(dir,'plan.json')),{code:'ENOENT'});
 }
});
