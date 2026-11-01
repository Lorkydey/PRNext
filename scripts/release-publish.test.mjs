import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {releasePackages,publishRelease,appendJournal,loadPublishInputs,parsePublishArguments,checkNpmVersion,checkTagMonotonicity,readPublishArchive,runNpm} from './release-publish.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sri=bytes=>'sha512-'+createHash('sha512').update(bytes).digest('base64');
const version='0.1.19-alpha',old='0.1.18-alpha';
const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'Lorkydey/PRNext',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'Lorkydey/PRNext/.github/workflows/publish.yml@refs/heads/main',ACTIONS_ID_TOKEN_REQUEST_URL:'https://vstoken.actions.githubusercontent.com/oidc',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'test-only-oidc'};
function tar(files){
  const chunks=[];
  for(const [name,input]of Object.entries(files)){
    const bytes=Buffer.isBuffer(input)?input:Buffer.from(input),header=Buffer.alloc(512);
    const octal=(offset,length,value)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
    header.write(name,0,100);octal(100,8,0o644);octal(108,8,0);octal(116,8,0);octal(124,12,bytes.length);octal(136,12,0);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
    header.write(header.reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks));
}
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-release-publisher-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const packages=[];
  for(const target of releasePackages){
    const manifest={name:target.name,version,repository:{url:'git+https://github.com/Lorkydey/PRNext.git'},publishConfig:{access:'public',tag:'alpha',registry:'https://registry.npmjs.org/'},scripts:{prepublishOnly:'must never execute'}};
    const files={};let binary;
    if(target.platform){
      binary=Buffer.from('binary-'+target.platform);
      Object.assign(manifest,{os:[target.os],cpu:[target.cpu],...(target.libc?{libc:[target.libc]}:{})});
      files['package/native.json']=JSON.stringify({id:target.platform,package:target.name,version,os:target.os,cpu:target.cpu,...(target.libc?{libc:target.libc}:{}),sha256:hash(binary)});
      files['package/bin/prnext'+(target.os==='win32'?'.exe':'')]=binary;
    }else manifest.optionalDependencies=Object.fromEntries(releasePackages.filter(p=>p.platform).map(p=>[p.name,version]));
    files['package/package.json']=JSON.stringify(manifest);
    const bytes=tar(files),filename=`${target.name.replace(/^@/,'').replaceAll('/','-')}-${version}.tgz`;
    await writeFile(path.join(root,filename),bytes);
    packages.push({name:target.name,version,filename,sha256:hash(bytes),size:bytes.length,integrity:sri(bytes),kind:target.platform?'native':'framework',...(target.platform?{platform:target.platform,binarySha256:hash(binary)}:{}),registry:{status:'absent'}});
  }
  const plan={schemaVersion:1,repository:'Lorkydey/PRNext',releaseVersion:version,sourceSha:'a'.repeat(40),sourceTree:'b'.repeat(40),releaseCommit:'c'.repeat(40),releaseTree:'b'.repeat(40),packages,runs:{ci:{id:1,attempt:1,sha:'a'.repeat(40),conclusion:'success'},artifacts:{id:2,attempt:1,sha:'a'.repeat(40),conclusion:'success'}},counts:{archives:7,installations:12,lifecycleReports:18,frameworkFiles:436}};
  const planPath=path.join(root,'plan.json');
  const savePlan=async()=>{const bytes=Buffer.from(JSON.stringify(plan));await writeFile(planPath,bytes);return hash(bytes);};
  const options={plan:planPath,directory:root,journal:path.join(root,'journal.jsonl'),summary:path.join(root,'summary.json'),planSha256:await savePlan(),npmCli:path.join(root,'npm-cli.js')};
  return {root,plan,options,savePlan};
}
function registryHarness(f,{failPublish,afterPublish,beforeFetch,failTag}={}){
  const available=new Map(),tags=new Map(f.plan.packages.map(p=>[p.name,{alpha:old,latest:old}])),events=[],published=[],tagged=[];
  let publishNumber=0;
  const fetcher=async input=>{
    const url=new URL(input),decoded=decodeURIComponent(url.pathname);
    const override=beforeFetch?.({url,available,tags,events});if(override instanceof Response)return override;
    if(decoded.startsWith('/-/package/')){
      const name=decoded.slice('/-/package/'.length,-'/dist-tags'.length);events.push('tags:'+name);return Response.json(tags.get(name));
    }
    if(decoded.startsWith('/archives/')){
      const name=decoded.slice('/archives/'.length,-4);events.push('archive:'+name);return new Response(available.get(name));
    }
    const record=f.plan.packages.find(p=>decoded===`/${p.name}/${p.version}`);
    assert.ok(record,'Unexpected registry request');events.push('version:'+record.name);
    if(!available.has(record.name))return new Response(null,{status:404});
    return Response.json({name:record.name,version:record.version,dist:{integrity:record.integrity,tarball:`https://registry.npmjs.org/archives/${encodeURIComponent(record.name)}.tgz`}});
  };
  const runNpm=async(args,context)=>{
    if(args[0]==='--version')return '11.21.0';
    const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(await readFile(context.env.NPM_CONFIG_USERCONFIG,'utf8'),'');
    assert.equal(await readFile(context.env.NPM_CONFIG_GLOBALCONFIG,'utf8'),'');
    assert.equal(context.env.NPM_CONFIG_IGNORE_SCRIPTS,'true');
    if(args[0]==='publish'){
      const bytes=await readFile(args[1]),manifest=JSON.parse(readPublishArchive(bytes).get('package/package.json'));
      assert.equal(journal.at(-1).type,'publish-started');assert.equal(journal.at(-1).name,manifest.name);
      assert.ok(args.includes('--ignore-scripts'));assert.equal(args[args.indexOf('--tag')+1],'latest');
      events.push('publish:'+manifest.name);published.push(manifest.name);publishNumber++;
      if(failPublish?.({number:publishNumber,name:manifest.name,bytes,available,tags}))throw Error('simulated child failure');
      available.set(manifest.name,bytes);tags.get(manifest.name).latest=version;
      afterPublish?.({number:publishNumber,name:manifest.name,bytes,available,tags});
    }else{
      assert.deepEqual(args.slice(0,2),['dist-tag','add']);
      const name=args[2].slice(0,args[2].lastIndexOf('@')),tag=args[3];
      assert.equal(journal.at(-1).type,'tag-started');
      events.push('tag:'+name+':'+tag);tagged.push({name,tag});tags.get(name)[tag]=version;
      if(failTag?.({name,tag}))throw Error('simulated tag response failure');
    }
    return '';
  };
  const adapters={env,nodeVersion:'24.22.1',fetch:fetcher,runNpm,sleep:async()=>{events.push('wait');}};
  return {available,tags,events,published,tagged,adapters};
}

test('all seven are preflighted, native uploads precede framework, and exact registry bytes/tags finish the batch',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.complete,true);assert.equal(result.verifiedPackages.length,7);assert.equal(result.distTagsVerified,true);
  assert.equal(result.status,'passed');assert.equal(result.passed,true);assert.equal(result.packages.length,7);assert.ok(result.packages.every(p=>p.tags.alpha===version&&p.tags.latest===version));
  assert.deepEqual(h.published,releasePackages.map(p=>p.name));
  const first=h.events.findIndex(e=>e.startsWith('publish:')),last=h.events.findLastIndex(e=>e.startsWith('publish:'));
  assert.equal(h.events.slice(0,first).filter(e=>e.startsWith('version:')).length,7);
  assert.equal(h.events.slice(0,first).filter(e=>e.startsWith('tags:')).length,7);
  assert.ok(h.events.slice(first,last+1).every(e=>e.startsWith('publish:')),'No registry downloads during batch');
  assert.ok(h.tagged.every(e=>e.tag==='alpha'));
  const lines=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines.at(-1).type,'done');
});

test('accepted publication with a lost response resumes without replaying any accepted archive',async t=>{
  const f=await fixture(t);let fail=true;
  const h=registryHarness(f,{failPublish:({number,name,bytes,available,tags})=>{if(fail&&number===3){available.set(name,bytes);tags.get(name).latest=version;return true;}}});
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);assert.equal(h.available.size,3);
  fail=false;const resumed={...f.options,summary:path.join(f.root,'resumed.json')};
  const result=await publishRelease(resumed,h.adapters);
  assert.equal(result.complete,true);assert.equal(h.published.length,7);assert.equal(new Set(h.published).size,7);
});

test('an absent earlier attempt stays ambiguous and cannot be automatically replayed',async t=>{
  const f=await fixture(t),h=registryHarness(f,{failPublish:()=>true});
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);
  await assert.rejects(publishRelease({...f.options,summary:path.join(f.root,'resume.json')},h.adapters),/ambiguous/);
  assert.equal(h.published.length,1);assert.equal(h.events.filter(e=>e==='wait').length,12);
});

test('pre-existing same-integrity metadata with different archive bytes blocks every upload',async t=>{
  const f=await fixture(t),h=registryHarness(f);h.available.set(f.plan.packages[4].name,Buffer.from('wrong'));
  await assert.rejects(publishRelease(f.options,h.adapters),/byte conflict/);assert.equal(h.published.length,0);
});

test('a publication race that installs mismatched bytes fails and its journal cannot hide the conflict on resume',async t=>{
  const f=await fixture(t),h=registryHarness(f,{failPublish:({name,available})=>{available.set(name,Buffer.from('racing-other-archive'));return true;}});
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);
  await assert.rejects(publishRelease({...f.options,summary:path.join(f.root,'resume.json')},h.adapters),/byte conflict/);
  assert.equal(h.published.length,1);
});

test('durable started event is required before npm; failed completion persistence is reconciled without replay',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  let refuse='publish-started';
  const append=async(file,event)=>{if(event.type===refuse)throw Error('simulated fsync failure');return appendJournal(file,event);};
  await assert.rejects(publishRelease(f.options,{...h.adapters,appendJournal:append}),/fsync/);assert.equal(h.published.length,0);
  refuse='publish-completed';
  await assert.rejects(publishRelease({...f.options,summary:path.join(f.root,'second.json')},{...h.adapters,appendJournal:append}),/fsync/);assert.equal(h.available.size,1);
  await publishRelease({...f.options,summary:path.join(f.root,'third.json')},h.adapters);assert.equal(h.published.length,7);
});

test('already published exact archives skip all publish operations; tags still verified through OIDC',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  for(const p of f.plan.packages)h.available.set(p.name,await readFile(path.join(f.root,p.filename)));
  const result=await publishRelease(f.options,h.adapters);assert.equal(result.complete,true);assert.equal(h.published.length,0);assert.equal(h.tagged.length,14);
});

test('a lost dist-tag response resumes from observed tags without replaying accepted publications',async t=>{
  const f=await fixture(t);let failure=true;
  const h=registryHarness(f,{failTag:()=>{if(failure){failure=false;return true;}}});
  await assert.rejects(publishRelease(f.options,h.adapters),/tag response/);
  const result=await publishRelease({...f.options,summary:path.join(f.root,'resume.json')},h.adapters);
  assert.equal(result.complete,true);assert.equal(h.published.length,7);assert.equal(h.tagged.length,7);
});

test('newer or incomparable alpha/latest tags refuse an old release before upload',async t=>{
  for(const current of ['0.1.20-alpha','0.1.19','unknown']){
    const f=await fixture(t),h=registryHarness(f);h.tags.get(f.plan.packages[0].name).latest=current;
    await assert.rejects(publishRelease(f.options,h.adapters),/downgrade|incomparable/);assert.equal(h.published.length,0);
  }
  assert.doesNotThrow(()=>checkTagMonotonicity({alpha:old,latest:version},version));
});

test('legacy credentials and an untrusted workflow are rejected without npm or registry access',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  for(const extra of [{NODE_AUTH_TOKEN:'do-not-use'},{npm_config__authToken:'do-not-use'},{GITHUB_REF:'refs/heads/other'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_WORKFLOW_REF:'Lorkydey/PRNext/.github/workflows/other.yml@refs/heads/main'}]){
    await assert.rejects(publishRelease(f.options,{...h.adapters,env:{...env,...extra}}),/credentials|workflow|runner/);
  }
  assert.equal(h.events.length,0);assert.equal(h.published.length,0);
});

test('plan digest, exact package set, archive manifest and unsafe tar entries are checked before networking',async t=>{
  const f=await fixture(t);
  await assert.rejects(loadPublishInputs({...f.options,planSha256:'0'.repeat(64)}),/digest/);
  f.plan.packages[0].filename='../escape.tgz';f.options.planSha256=await f.savePlan();
  await assert.rejects(loadPublishInputs(f.options),/filename/);
  f.plan.packages[0]={...f.plan.packages[1]};f.options.planSha256=await f.savePlan();
  await assert.rejects(loadPublishInputs(f.options),/duplicate|Missing/);
  assert.throws(()=>readPublishArchive(tar({'package/../escape':'x','package/package.json':'{}'})),/Unsafe/);
  assert.throws(()=>readPublishArchive(tar({'package/.npmrc':'auth=bad','package/package.json':'{}'})),/configuration/);
});

test('an incomplete journal or journal from another plan fails closed',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  await writeFile(f.options.journal,'{"type":"init"');
  await assert.rejects(publishRelease(f.options,h.adapters),/journal/);
  assert.equal(h.published.length,0);
});

test('CLI accepts only structured exact flags and outside-GitHub invocation cannot invoke npm',()=>{
  assert.throws(()=>parsePublishArguments(['--plan','x','--unknown','x']),/arguments/);
  assert.throws(()=>parsePublishArguments(['--plan','x','--plan','y']),/arguments/);
  const argv=['--plan','$(touch nope)','--directory','with spaces','--plan-sha256','a'.repeat(64),'--journal','journal','--summary','summary','--npm-cli','npm-cli.js'];
  assert.equal(parsePublishArguments(argv).plan,'$(touch nope)');
  const file=fileURLToPath(new URL('./release-publish.mjs',import.meta.url));
  const child=spawnSync(process.execPath,[file,...argv],{env:{...process.env,GITHUB_ACTIONS:'false'},shell:false,encoding:'utf8',timeout:10000});
  assert.equal(child.status,1);assert.match(child.stderr,/did not complete/);assert.equal(child.stdout,'');
});

test('npm version guard includes dist-tag OIDC requirements',()=>{
  for(const value of ['11.5.1','11.20.0','12.1.0','bad'])assert.throws(()=>checkNpmVersion(value));
  for(const value of ['11.21.0','12.2.0','13.0.0'])assert.doesNotThrow(()=>checkNpmVersion(value));
});

test('real Node subprocess preserves literal shell characters and empty config isolation, without a shell',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'prnext-publish-cli-space-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'node_modules/npm/bin');await mkdir(bin,{recursive:true});
  const cli=path.join(bin,'npm-cli.js');
  await writeFile(cli,"console.log(JSON.stringify({args:process.argv.slice(2),user:process.env.NPM_CONFIG_USERCONFIG}));");
  const literal='$(touch should-not-run); & echo unsafe';
  const output=JSON.parse(await runNpm(['--version',literal],{npmCli:cli,cwd:root,env:{...process.env,RUNNER_TEMP:root,NPM_CONFIG_USERCONFIG:path.join(root,'empty.npmrc')}}));
  assert.deepEqual(output.args,['--version',literal]);assert.equal(output.user,path.join(root,'empty.npmrc'));
  await writeFile(cli,"console.error('npm error code E403');console.error('Bearer must-never-escape-diagnostics');process.exitCode=7;");
  await assert.rejects(runNpm([],{npmCli:cli,cwd:root,env:{...process.env,RUNNER_TEMP:root}}),error=>error.npmCode==='E403'&&error.exitCode===7&&!error.message.includes('Bearer'));
});

test('wrong archive package identity and publishConfig credentials are rejected even when planned hashes match',async t=>{
  for(const change of [manifest=>manifest.name='evil-package',manifest=>manifest.publishConfig._authToken='do-not-use']){
    const f=await fixture(t),record=f.plan.packages.at(-1),entries=readPublishArchive(await readFile(path.join(f.root,record.filename)));
    const manifest=JSON.parse(entries.get('package/package.json'));change(manifest);entries.set('package/package.json',Buffer.from(JSON.stringify(manifest)));
    const bytes=tar(Object.fromEntries(entries));Object.assign(record,{size:bytes.length,sha256:hash(bytes),integrity:sri(bytes)});
    await writeFile(path.join(f.root,record.filename),bytes);f.options.planSha256=await f.savePlan();
    await assert.rejects(loadPublishInputs(f.options),/identity|publishConfig/);
  }
});

test('post-batch propagation is bounded, verified before tag mutations, and never causes republishing',async t=>{
  const f=await fixture(t);let hide=0;
  const h=registryHarness(f,{afterPublish:({number})=>{if(number===7)hide=1;},beforeFetch:({url,available})=>{
    if(hide&&decodeURIComponent(url.pathname)===`/${f.plan.packages[0].name}/${version}`){
      const bytes=available.get(f.plan.packages[0].name);available.delete(f.plan.packages[0].name);hide=0;queueMicrotask(()=>available.set(f.plan.packages[0].name,bytes));
    }
  }});
  const result=await publishRelease(f.options,h.adapters);assert.equal(result.complete,true);assert.equal(h.published.length,7);
  assert.ok(h.events.includes('wait'));
  const firstTag=h.events.findIndex(e=>e.startsWith('tag:'));
  const lastPublish=h.events.findLastIndex(e=>e.startsWith('publish:'));
  assert.ok(firstTag>lastPublish);assert.equal(h.events.slice(lastPublish+1,firstTag).filter(e=>e.startsWith('archive:')).length,7);
});

test('visible metadata whose tarball is still propagating never grants permission to republish',async t=>{
  const f=await fixture(t);let hideArchive=true;
  const h=registryHarness(f,{beforeFetch:({url})=>{if(hideArchive&&decodeURIComponent(url.pathname)===`/archives/${f.plan.packages[0].name}.tgz`){hideArchive=false;return new Response(null,{status:404});}}});
  h.available.set(f.plan.packages[0].name,await readFile(path.join(f.root,f.plan.packages[0].filename)));
  const result=await publishRelease(f.options,h.adapters);assert.equal(result.complete,true);
  assert.equal(h.published.includes(f.plan.packages[0].name),false);assert.equal(h.published.length,6);assert.ok(h.events.includes('wait'));
});

test('new journal directories and expanded data-only workflow provenance are accepted',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  f.plan.runs.ci.workflow='.github/workflows/ci.yml';f.plan.runs.ci.jobs=[{id:10,name:'CI result',conclusion:'success'}];
  f.options.planSha256=await f.savePlan();
  f.options.journal=path.join(f.root,'new-output','journal.jsonl');f.options.summary=path.join(f.root,'new-output','summary.json');
  const result=await publishRelease(f.options,h.adapters);assert.equal(result.status,'passed');
});

test('a sealed exact-existing status stays accepted if the registry temporarily returns 404 after approval',async t=>{
  const f=await fixture(t),h=registryHarness(f),record=f.plan.packages[0];
  record.registry={name:record.name,status:'exact-existing',sha256:record.sha256,integrity:record.integrity};
  f.options.planSha256=await f.savePlan();
  await assert.rejects(publishRelease(f.options,h.adapters),/ambiguous/);
  assert.equal(h.published.length,0);assert.equal(h.events.filter(e=>e==='wait').length,12);
});

test('invalid qualified registry states are rejected before networking',async t=>{
  const f=await fixture(t),h=registryHarness(f);f.plan.packages[0].registry.status='accepted-maybe';f.options.planSha256=await f.savePlan();
  await assert.rejects(publishRelease(f.options,h.adapters),/registry status/);assert.equal(h.events.length,0);
});

test('job reruns require their prior journal, and a restored completed journal is idempotent',async t=>{
  const f=await fixture(t),h=registryHarness(f),rerun={...h.adapters,env:{...env,GITHUB_RUN_ATTEMPT:'2'}};
  await assert.rejects(publishRelease(f.options,rerun),/rerun without its journal/);assert.equal(h.events.length,0);
  await publishRelease(f.options,h.adapters);
  const result=await publishRelease({...f.options,summary:path.join(f.root,'rerun.json')},rerun);
  assert.equal(result.complete,true);assert.equal(h.published.length,7);
});

test('completed journal reruns remain terminal and parse as real historical evidence',async t=>{
  const {parsePublicationJournal}=await import('./release-qualification.mjs');
  const f=await fixture(t),h=registryHarness(f);
  await publishRelease(f.options,h.adapters);
  const before=await readFile(f.options.journal);
  const result=await publishRelease({...f.options,summary:path.join(f.root,'rerun.json')},{...h.adapters,env:{...env,GITHUB_RUN_ATTEMPT:'2'}});
  assert.equal(result.complete,true);assert.deepEqual(await readFile(f.options.journal),before);
  const history=parsePublicationJournal(before,{version,source:f.plan.sourceSha,releaseCommit:f.plan.releaseCommit,packages:f.plan.packages.map(p=>({...p,registry:{status:'exact-existing'}}))});
  assert.equal(history.done,true);assert.equal(history.started.length,7);
  h.tags.get(f.plan.packages[0].name).alpha=old;
  const mutations=h.tagged.length;
  await assert.rejects(publishRelease({...f.options,summary:path.join(f.root,'changed.json')},{...h.adapters,env:{...env,GITHUB_RUN_ATTEMPT:'2'}}),/Completed publication tags changed/);
  assert.equal(h.tagged.length,mutations);assert.deepEqual(await readFile(f.options.journal),before);
});

test('an exact preflight observation is durable acceptance even if a later package fails',async t=>{
  const f=await fixture(t),h=registryHarness(f,{failPublish:()=>true}),record=f.plan.packages[0];
  h.available.set(record.name,await readFile(path.join(f.root,record.filename)));
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);
  const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(journal.some(e=>e.type==='registry-verified'&&e.name===record.name));
  h.available.delete(record.name);
  await assert.rejects(publishRelease({...f.options,summary:path.join(f.root,'resume.json')},h.adapters),/ambiguous/);
  assert.equal(h.published.length,1);
});
