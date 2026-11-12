import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {releasePackages,publishRelease,appendJournal,loadPublishInputs,parsePublishArguments,checkNpmVersion,checkTagMonotonicity,readPublishArchive,runNpm,publicationFailureMessage} from './release-publish.mjs';

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
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'prnext-release-publisher-test-')));
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
async function diagnosticCli(t,source){
  const root=await mkdtemp(path.join(tmpdir(),'prnext-publish-diagnostic-test-'));
  t.after(async()=>{
    assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith('prnext-publish-diagnostic-test-'));
    await rm(root,{recursive:true,force:true});
  });
  const cli=path.join(root,'node_modules/npm/bin/npm-cli.js');
  await mkdir(path.dirname(cli),{recursive:true});await writeFile(cli,source);
  const childEnv={RUNNER_TEMP:root};
  for(const key of ['SystemRoot','WINDIR','SystemDrive'])if(process.env[key])childEnv[key]=process.env[key];
  return {root,context:{npmCli:cli,cwd:root,env:childEnv}};
}
async function reconciliationFixture(f){
  const record=f.plan.packages[0],value={
    kind:'explicit-uncertain-absence',runId:101,attempt:1,source:f.plan.sourceSha,sourceTree:f.plan.sourceTree,releaseCommit:f.plan.releaseCommit,version,
    name:record.name,sha256:record.sha256,previousPlanSha256:'d'.repeat(64),journalSha256:'e'.repeat(64),previousState:'uncertain',
    requestedBy:{login:'Lorkydey',id:57268822},requiresApproval:'npm-release',
    observation:{name:record.name,version,status:'absent',revision:'1-'+'f'.repeat(32),modified:'2026-11-07T00:00:00.000Z',tags:{alpha:old,latest:old}},
  };
  const parent={runId:101,attempt:1,status:'reconciled',planSha256:value.previousPlanSha256,journalSha256:value.journalSha256,started:[record.name],accepted:[record.name],completed:[],done:false,reconciliation:value};
  const provenance={runs:structuredClone(f.plan.runs),publicationHistory:{currentRunId:202,attempts:[parent]}},file=path.join(f.root,'receipts/provenance.json');
  await mkdir(path.dirname(file),{recursive:true});
  f.options.reconcileRun='101';
  const save=async()=>{const bytes=Buffer.from(JSON.stringify(provenance));await writeFile(file,bytes);f.options.provenanceSha256=hash(bytes);};
  await save();
  return {record,value,parent,provenance,file,save,env:{...env,GITHUB_RUN_ID:'202'}};
}
function registryHarness(f,{failPublish,afterPublish,beforeFetch,failTag}={}){
  const available=new Map(),tags=new Map(f.plan.packages.map(p=>[p.name,{alpha:old,latest:old}])),events=[],published=[],tagged=[];
  let publishNumber=0;
  const fetcher=async(input,request)=>{
    const url=new URL(input),decoded=decodeURIComponent(url.pathname);
    const override=beforeFetch?.({url,available,tags,events,request});if(override instanceof Response)return override;
    if(decoded.startsWith('/-/package/')){
      const name=decoded.slice('/-/package/'.length,-'/dist-tags'.length);events.push('tags:'+name);return Response.json(tags.get(name));
    }
    if(decoded.startsWith('/archives/')){
      const name=decoded.slice('/archives/'.length,-4);events.push('archive:'+name);return new Response(available.get(name));
    }
    const packageRecord=f.plan.packages.find(p=>decoded===`/${p.name}`);
    if(packageRecord){
      events.push('packument:'+packageRecord.name+(url.search?':write':':normal'));
      return Response.json({name:packageRecord.name,_rev:'1-'+'f'.repeat(32),versions:{[old]:{name:packageRecord.name,version:old}},time:{modified:'2026-11-07T00:00:00.000Z'},'dist-tags':tags.get(packageRecord.name)});
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
      if(args.includes('--dry-run')){
        assert.deepEqual(args.slice(2),['--dry-run','--ignore-scripts','--tag','latest','--access','public','--registry','https://registry.npmjs.org/','--loglevel','verbose','--json']);
        events.push('auth:'+manifest.name);
        return 'npm verbose oidc Successfully retrieved and set token\n';
      }
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
  assert.deepEqual(h.events.slice(0,first).filter(e=>e.startsWith('auth:')),releasePackages.map(p=>'auth:'+p.name));
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

test('real subprocess diagnostics retain ANSI and Sigstore codes without exposing captured text',async t=>{
  for(const [label,prefix,wanted]of [
    ['ordinary auth','npm error code ENEEDAUTH\n','ENEEDAUTH'],
    ['Sigstore CA','npm error code CA_CREATE_SIGNING_CERTIFICATE_ERROR\n','CA_CREATE_SIGNING_CERTIFICATE_ERROR'],
    ['Sigstore log','npm error code TLOG_CREATE_ENTRY_ERROR\n','TLOG_CREATE_ENTRY_ERROR'],
    ['colored auth','npm \u001b[31merror\u001b[39m code \u001b[33mENEEDAUTH\u001b[39m\n','ENEEDAUTH'],
    ['JSON code','{"error":{"code":"TUF_INIT_CACHE_ERROR"}}\n','TUF_INIT_CACHE_ERROR'],
    ['oversized code','npm error code '+ 'A'.repeat(65)+'\n',undefined],
    ['URL is not a code','npm error code https://private.invalid/token\n',undefined],
  ])await t.test(label,async t=>{
    const output=prefix+'Bearer must-never-escape\nNPM_ID_TOKEN=secret-value\nhttps://private.invalid/?token=secret-value\n';
    const f=await diagnosticCli(t,`process.stderr.write(${JSON.stringify(output)});process.exitCode=7;`);
    await assert.rejects(runNpm([] ,f.context),error=>{
      assert.equal(error.npmCode,wanted);assert.equal(error.exitCode,7);
      const d=error.npmSubprocessFailure;
      assert.deepEqual(Object.keys(d).sort(),['elapsedMs','exitCode','outputBytes','outputLimitExceeded','outputSha256','signal','timedOut']);
      assert.equal(d.exitCode,7);assert.equal(d.signal,null);assert.equal(d.timedOut,false);assert.equal(d.outputLimitExceeded,false);
      assert.equal(d.outputBytes,Buffer.byteLength(output));assert.equal(d.outputSha256,hash(output));
      assert.ok(Number.isInteger(d.elapsedMs)&&d.elapsedMs>=0);assert.ok(Object.isFrozen(d));
      assert.doesNotMatch(JSON.stringify(error),/Bearer|secret-value|private\.invalid|NPM_ID_TOKEN|stdout|stderr/);
      return true;
    });
  });
});

test('output-limit failure records observed bytes and digest without retaining output',async t=>{
  const f=await diagnosticCli(t,"process.stderr.write('x'.repeat(1024*1024));");
  await assert.rejects(runNpm([],f.context),error=>{
    const d=error.npmSubprocessFailure;
    assert.equal(d.outputLimitExceeded,true);assert.equal(d.timedOut,false);
    assert.ok(d.outputBytes>128*1024&&d.outputBytes<=1024*1024);
    assert.equal(d.outputSha256,hash(Buffer.alloc(d.outputBytes,'x')));
    assert.equal(error.npmCode,undefined);assert.ok(JSON.stringify(error).length<1024);
    return true;
  });
});

test('timeout diagnostics preserve the existing deadlines and record the termination signal',async t=>{
  const f=await diagnosticCli(t,'setInterval(()=>{},1000);'),deadlines=[];
  const original=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
    if(delay===180000||delay===5000)deadlines.push(delay);
    return original(callback,delay===180000?20:delay,...args);
  });
  await assert.rejects(runNpm([],f.context),error=>{
    const d=error.npmSubprocessFailure;
    assert.equal(d.timedOut,true);assert.equal(d.outputLimitExceeded,false);
    assert.equal(d.exitCode,null);assert.equal(d.signal,'SIGTERM');
    assert.equal(d.outputBytes,0);assert.equal(d.outputSha256,hash(''));
    return true;
  });
  assert.deepEqual(deadlines,[180000,5000]);
});

test('spawn failure retains only bounded process metadata through the later close event',async t=>{
  const f=await diagnosticCli(t,'process.exitCode=0;');
  await assert.rejects(runNpm([],{...f.context,cwd:path.join(f.root,'missing-private-token')}),error=>{
    assert.match(error.message,/could not start/);assert.equal(error.npmCode,undefined);
    const d=error.npmSubprocessFailure;
    assert.equal(d.exitCode,null);assert.equal(d.signal,null);assert.equal(d.timedOut,false);
    assert.equal(d.outputBytes,0);assert.equal(d.outputSha256,hash(''));
    assert.doesNotMatch(JSON.stringify(error),/missing-private-token|cwd|stdout|stderr/);
    return true;
  });
  await new Promise(setImmediate);
});

test('bounded real-child diagnostics cross the publication wrapper and durable summary',async t=>{
  const f=await fixture(t),h=registryHarness(f),output='npm error code CA_CREATE_SIGNING_CERTIFICATE_ERROR\nBearer secret-value\n';
  const child=await diagnosticCli(t,`process.stderr.write(${JSON.stringify(output)});process.exitCode=7;`);
  h.adapters.runNpm=async args=>args[0]==='--version'?'11.21.0':args.includes('--dry-run')?'npm verbose oidc Successfully retrieved and set token\n':runNpm([],child.context);
  let failure;
  await assert.rejects(publishRelease(f.options,h.adapters),error=>{failure=error;return /uncertain/.test(error.message);});
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(summary.passed,false);assert.equal(summary.complete,false);assert.equal(summary.npmCode,'CA_CREATE_SIGNING_CERTIFICATE_ERROR');
  assert.equal(summary.subprocessExitCode,7);assert.deepEqual(summary.npmSubprocessFailure,failure.npmSubprocessFailure);
  assert.equal(summary.npmSubprocessFailure.outputSha256,hash(output));assert.equal(summary.npmSubprocessFailure.outputBytes,Buffer.byteLength(output));
  assert.doesNotMatch(JSON.stringify(summary),/Bearer|secret-value|stdout|stderr/);
  const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(journal.map(row=>row.type),['init','publish-started','publish-uncertain']);
});

test('adapter-supplied arbitrary diagnostic objects are not copied to the summary',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  h.adapters.runNpm=async args=>{
    if(args[0]==='--version')return '11.21.0';
    if(args.includes('--dry-run'))return 'npm verbose oidc Successfully retrieved and set token\n';
    throw Object.assign(Error('Bearer secret-value'),{npmCode:'https://private.invalid/',npmSubprocessFailure:{stderr:'secret-value'}});
  };
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(summary.npmCode,undefined);assert.equal(summary.npmSubprocessFailure,undefined);
  assert.doesNotMatch(JSON.stringify(summary),/Bearer|secret-value|private\.invalid|stderr/);
});

test('dry-run exit zero without confirmed OIDC never starts a publication or tag mutation',async t=>{
  const confirmed='npm verbose oidc Successfully retrieved and set token\n';
  for(const output of [
    '{}\n',
    confirmed+'npm warn publish This command requires you to be logged in to https://registry.npmjs.org/ (dry-run)\n',
    confirmed+'npm error code ENEEDAUTH\nBearer secret-value\n',
  ]){
    const f=await fixture(t),h=registryHarness(f),npm=h.adapters.runNpm;
    h.adapters.runNpm=async(args,context)=>args.includes('--dry-run')?output:npm(args,context);
    await assert.rejects(publishRelease(f.options,h.adapters),/did not confirm trusted OIDC/);
    assert.deepEqual(h.published,[]);assert.deepEqual(h.tagged,[]);
    const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(journal.map(row=>row.type),['init']);
    const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
    assert.equal(summary.npmCode,'OIDC_AUTH_UNCONFIRMED');assert.equal(summary.passed,false);
    assert.doesNotMatch(JSON.stringify(summary),/Bearer|secret-value|npm warn|Successfully retrieved/);
  }
});

test('ANSI OIDC confirmations finish all seven preflights before the upload batch',async t=>{
  const f=await fixture(t),h=registryHarness(f),npm=h.adapters.runNpm;
  const auth=[];
  h.adapters.runNpm=async(args,context)=>{
    if(args.includes('--dry-run')){
      auth.push(args[1]);assert.deepEqual(h.published,[]);
      return 'npm \u001b[32mverbose\u001b[39m oidc Successfully retrieved and set token\r\n{}\n';
    }
    if(args[0]==='publish')assert.equal(auth.length,7);
    return npm(args,context);
  };
  assert.equal((await publishRelease(f.options,h.adapters)).passed,true);
  assert.equal(auth.length,7);assert.equal(h.published.length,7);
});

test('explicit owner reconciliation rechecks the selected version and both no-cache views after auth',async t=>{
  const f=await fixture(t),r=await reconciliationFixture(f),views=[];
  const h=registryHarness(f,{beforeFetch:({url,request})=>{
    if(decodeURIComponent(url.pathname)==='/'+r.record.name){
      assert.equal(request.headers['Cache-Control'],'no-cache');views.push(url.href);
    }
  }});
  h.adapters.env=r.env;
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.passed,true);
  assert.deepEqual(views,['https://registry.npmjs.org/'+r.record.name,'https://registry.npmjs.org/'+r.record.name+'?write=true']);
  assert.deepEqual(result.registryReads.reconciliation,{runId:101,attempt:1,name:r.record.name,version,sha256:r.record.sha256,previousPlanSha256:r.value.previousPlanSha256,journalSha256:r.value.journalSha256,previousState:'uncertain',observation:r.value.observation});
  const firstPublish=h.events.findIndex(e=>e.startsWith('publish:')),before=h.events.slice(0,firstPublish);
  const lastAuth=before.findLastIndex(e=>e.startsWith('auth:')),lastVersion=before.findLastIndex(e=>e==='version:'+r.record.name);
  assert.equal(before.filter(e=>e.startsWith('auth:')).length,7);assert.ok(lastVersion>lastAuth);
  assert.equal(before.filter(e=>e==='version:'+r.record.name).length,2);
  assert.equal(before.filter((e,i)=>e.startsWith('packument:')&&i>lastVersion).length,2);
  assert.ok(before.at(-1).endsWith(':write'));
  const lastPublish=h.events.findLastIndex(e=>e.startsWith('publish:'));
  assert.ok(h.events.slice(firstPublish,lastPublish+1).every(e=>e.startsWith('publish:')));
  assert.deepEqual(h.published,releasePackages.map(row=>row.name));
});

test('a freshly exact existing reconciled archive is byte-verified and never sent again',async t=>{
  const f=await fixture(t),r=await reconciliationFixture(f),h=registryHarness(f);h.adapters.env=r.env;
  h.available.set(r.record.name,await readFile(path.join(f.root,r.record.filename)));
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.passed,true);assert.ok(!h.published.includes(r.record.name));assert.equal(h.published.length,6);
  assert.equal(h.events.filter(e=>e.startsWith('packument:')).length,0);
  assert.deepEqual(result.registryReads.reconciliation.observation,{name:r.record.name,version,status:'exact-existing',sha256:r.record.sha256,integrity:r.record.integrity});
  assert.equal(result.registryReads.reconciliation.previousState,'uncertain');
});

test('an exact version appearing during auth is byte-verified and removed from the pending batch',async t=>{
  const f=await fixture(t),r=await reconciliationFixture(f),h=registryHarness(f);h.adapters.env=r.env;
  const archive=await readFile(path.join(f.root,r.record.filename)),npm=h.adapters.runNpm;let authenticated=0;
  h.adapters.runNpm=async(args,context)=>{
    const output=await npm(args,context);
    if(args.includes('--dry-run')&&++authenticated===7){h.available.set(r.record.name,archive);h.tags.get(r.record.name).latest=version;}
    return output;
  };
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.passed,true);assert.equal(authenticated,7);
  assert.deepEqual(h.published,releasePackages.slice(1).map(row=>row.name));
  assert.equal(h.events.filter(e=>e.startsWith('packument:')).length,0);
  assert.equal(result.registryReads.reconciliation.observation.status,'exact-existing');
  const before=h.events.slice(0,h.events.findIndex(e=>e.startsWith('publish:')));
  assert.ok(before.findLastIndex(e=>e==='version:'+r.record.name)>before.findLastIndex(e=>e.startsWith('auth:')));
  assert.ok(before.at(-1)==='archive:'+r.record.name);
  const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(journal.findIndex(e=>e.type==='registry-verified'&&e.name===r.record.name)<journal.findIndex(e=>e.type==='publish-started'));
  assert.ok(!journal.some(e=>e.type==='publish-started'&&e.name===r.record.name));
});

test('a version observed existing before auth cannot become republishable after a final 404',async t=>{
  const f=await fixture(t),r=await reconciliationFixture(f),h=registryHarness(f);h.adapters.env=r.env;
  h.available.set(r.record.name,await readFile(path.join(f.root,r.record.filename)));
  const npm=h.adapters.runNpm;let authenticated=0;
  h.adapters.runNpm=async(args,context)=>{
    const output=await npm(args,context);
    if(args.includes('--dry-run')&&++authenticated===7)h.available.delete(r.record.name);
    return output;
  };
  await assert.rejects(publishRelease(f.options,h.adapters),/cannot be reconciled as absent/);
  assert.equal(authenticated,7);assert.deepEqual(h.published,[]);assert.deepEqual(h.tagged,[]);
  assert.equal(h.events.filter(e=>e.startsWith('packument:')).length,0);
});

test('reconciliation identity, source and provenance failures precede every journal write',async t=>{
  const changes=[
    r=>{r.value.source='0'.repeat(40);},r=>{r.value.sourceTree='0'.repeat(40);},r=>{r.value.releaseCommit='0'.repeat(40);},
    r=>{r.value.version=old;},r=>{r.value.name='unexpected-package';},r=>{r.value.sha256='0'.repeat(64);},
    r=>{r.value.requestedBy.id=1;},r=>{r.value.requiresApproval='other';},r=>{r.value.previousState='completed';},
    r=>{r.parent.completed=[r.record.name];},r=>{r.parent.planSha256='0'.repeat(64);},r=>{r.parent.journalSha256='0'.repeat(64);},
    r=>{r.provenance.publicationHistory.currentRunId=303;},r=>{r.provenance.runs.ci.sha='0'.repeat(40);},
    r=>{r.provenance.publicationHistory.attempts.push(structuredClone(r.parent));},
    r=>{r.provenance.publicationHistory.attempts.push({accepted:[r.record.name]});},
  ];
  for(const change of changes){
    const f=await fixture(t),r=await reconciliationFixture(f),h=registryHarness(f);h.adapters.env=r.env;
    change(r);await r.save();
    await assert.rejects(publishRelease(f.options,h.adapters));
    await assert.rejects(lstat(f.options.journal),{code:'ENOENT'});await assert.rejects(lstat(f.options.summary),{code:'ENOENT'});
    assert.equal(h.events.length,0);assert.deepEqual(h.published,[]);
  }
  for(const change of [f=>{f.options.provenanceSha256='0'.repeat(64);},f=>{f.options.reconcileRun='999';}]){
    const f=await fixture(t),r=await reconciliationFixture(f),h=registryHarness(f);h.adapters.env=r.env;change(f);
    await assert.rejects(publishRelease(f.options,h.adapters));
    await assert.rejects(lstat(f.options.journal),{code:'ENOENT'});assert.equal(h.events.length,0);
  }
});

test('conflicting or failed canonical views never become absence or permit an upload',async t=>{
  for(const problem of ['present','revision','unavailable']){
    const f=await fixture(t),r=await reconciliationFixture(f);
    const h=registryHarness(f,{beforeFetch:({url})=>{
      if(decodeURIComponent(url.pathname)!=='/'+r.record.name||!url.search)return;
      if(problem==='unavailable')return new Response(null,{status:404});
      return Response.json({name:r.record.name,_rev:problem==='revision'?'2-'+'a'.repeat(32):'1-'+'f'.repeat(32),versions:problem==='present'?{[version]:{}}:{},time:{modified:'2026-11-07T00:00:00.000Z'},'dist-tags':{alpha:old,latest:old}});
    }});h.adapters.env=r.env;
    await assert.rejects(publishRelease(f.options,h.adapters),/reconciliation/);
    assert.deepEqual(h.published,[]);assert.deepEqual(h.tagged,[]);assert.equal(h.events.filter(e=>e.startsWith('auth:')).length,7);
    const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(journal.map(row=>row.type),['init']);
    const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
    assert.equal(summary.registryReadFailure.code,problem==='unavailable'?'RECONCILIATION_UNAVAILABLE':'RECONCILIATION_CONFLICT');
  }
});

test('reconciliation GET time consumes the same existing registry read budget',async t=>{
  const f=await fixture(t),r=await reconciliationFixture(f);let clock=0;
  const h=registryHarness(f,{beforeFetch:({url})=>{
    clock+=url.pathname.startsWith('/-/package/')?8000:decodeURIComponent(url.pathname)==='/'+r.record.name?29000:10000;
  }});h.adapters.env=r.env;h.adapters.now=()=>clock;
  await assert.rejects(publishRelease(f.options,h.adapters));
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(summary.registryReads.budgetMs,180000);assert.equal(summary.registryReadFailure.code,'READ_BUDGET_EXHAUSTED');
  assert.equal(summary.registryReads.reconciliation,undefined,'Incomplete final views are never published as a proof');
  assert.equal(h.events.filter(e=>e.startsWith('auth:')).length,7);assert.deepEqual(h.published,[]);assert.deepEqual(h.tagged,[]);
});

test('explicit reconciliation never exempts an uncertain attempt in the current journal',async t=>{
  const f=await fixture(t),r=await reconciliationFixture(f),h=registryHarness(f,{failPublish:()=>true});h.adapters.env=r.env;
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);assert.equal(h.published.length,1);
  await assert.rejects(publishRelease({...f.options,summary:path.join(f.root,'resume.json')},h.adapters),/ambiguous/);
  assert.equal(h.published.length,1);assert.equal(h.events.filter(e=>e.startsWith('packument:')).length,2);
});

test('a qualified existing archive cannot use absence reconciliation after a later 404',async t=>{
  const f=await fixture(t),record=f.plan.packages[0];record.registry={name:record.name,status:'exact-existing',sha256:record.sha256,integrity:record.integrity};f.options.planSha256=await f.savePlan();
  const r=await reconciliationFixture(f),h=registryHarness(f);h.adapters.env=r.env;
  r.value.observation={name:r.record.name,version,status:'exact-existing',sha256:r.record.sha256,integrity:r.record.integrity};await r.save();
  await assert.rejects(publishRelease(f.options,h.adapters),/ambiguous/);
  assert.deepEqual(h.published,[]);assert.equal(h.events.filter(e=>e.startsWith('packument:')).length,0);
});

test('legacy CLI stays strict and an empty reconciliation ID supplies no exception',async t=>{
  const argv=['--plan','p','--directory','d','--plan-sha256','a'.repeat(64),'--journal','j','--summary','s','--npm-cli','n'];
  assert.equal(Object.keys(parsePublishArguments(argv)).length,6);
  assert.equal(parsePublishArguments([...argv,'--reconcile-run','']).reconcileRun,'');
  assert.equal(parsePublishArguments([...argv,'--provenance-sha256','b'.repeat(64)]).provenanceSha256,'b'.repeat(64));
  assert.equal(parsePublishArguments([...argv,'--reconcile-run','101','--provenance-sha256','b'.repeat(64)]).reconcileRun,'101');
  for(const extra of [['--reconcile-run','101'],['--reconcile-run','01','--provenance-sha256','b'.repeat(64)],['--reconcile-run','1.5','--provenance-sha256','b'.repeat(64)],['--reconcile-run','9007199254740992','--provenance-sha256','b'.repeat(64)],['--provenance-sha256','bad'],['--unknown','value']])assert.throws(()=>parsePublishArguments([...argv,...extra]));
  const f=await fixture(t),h=registryHarness(f,{failPublish:()=>true});
  await assert.rejects(publishRelease(f.options,h.adapters),/uncertain/);
  await assert.rejects(publishRelease({...f.options,reconcileRun:'',provenanceSha256:'b'.repeat(64),summary:path.join(f.root,'resume.json')},h.adapters),/ambiguous/);
  assert.equal(h.published.length,1);assert.equal(h.events.filter(e=>e.startsWith('packument:')).length,0);
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

test('accepted archives can propagate beyond one minute without repeated uploads or early tag writes', async t => {
 const f=await fixture(t);let elapsed=0,accepted=false;
 const h=registryHarness(f,{afterPublish:({number})=>{if(number===7)accepted=true;},beforeFetch:({url,request})=>{
  if(accepted&&decodeURIComponent(url.pathname).endsWith('/'+version)&&elapsed<305000){assert.equal(request.headers['Cache-Control'],'no-cache');return new Response(null,{status:404});}
 }});
 h.adapters.sleep=async ms=>{elapsed+=ms;};
 const result=await publishRelease(f.options,h.adapters);
 assert.equal(result.passed,true);assert.equal(h.published.length,7);assert.ok(elapsed>=305000&&elapsed<=360000);
 assert.ok(result.registryReads.propagation.rounds<20);
});

test('unpropagated accepted archives stop at a shared bound and retain acceptance without tag mutations', async t => {
 const f=await fixture(t);let accepted=false;
 const h=registryHarness(f,{afterPublish:({number})=>{if(number===7)accepted=true;},beforeFetch:({url})=>accepted&&decodeURIComponent(url.pathname).endsWith('/'+version)?new Response(null,{status:404}):undefined});
 await assert.rejects(publishRelease(f.options,h.adapters),/verification is still pending/);
 const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
 assert.equal(h.published.length,7);assert.equal(h.tagged.length,0);assert.equal(summary.complete,false);
 assert.equal(summary.registryReadFailure.code,'PROPAGATION_BUDGET_EXHAUSTED');assert.equal(summary.registryReads.propagation.waitedMs,360000);
 assert.equal(summary.registryReadFailure.operation,'packument');assert.equal(summary.registryReadFailure.status,200);
 assert.equal(summary.registryReadFailure.pendingReason,'VERSION_NOT_VISIBLE');assert.equal(summary.registryReads.propagation.pending.length,7);
 const journal=(await readFile(f.options.journal,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(journal.filter(e=>e.type==='publish-completed').length,7);
});

test('a stale version endpoint is verified through fresh package metadata without repeating accepted uploads',async t=>{
 const f=await fixture(t),record=f.plan.packages.find(p=>p.platform==='linux-arm64-gnu');let accepted=false;
 const h=registryHarness(f,{afterPublish:({number})=>{if(number===7)accepted=true;},beforeFetch:({url,request})=>{
  const pathname=decodeURIComponent(url.pathname);
  if(accepted&&pathname===`/${record.name}/${version}`)return new Response(null,{status:404});
  if(accepted&&pathname===`/${record.name}`){
   assert.equal(url.search,'?write=true');assert.equal(request.headers['Cache-Control'],'no-cache');
   return Response.json({name:record.name,versions:{[version]:{name:record.name,version,dist:{integrity:record.integrity,tarball:`https://registry.npmjs.org/archives/${encodeURIComponent(record.name)}.tgz`}}}});
  }
  if(accepted&&pathname.startsWith('/archives/'))assert.equal(request.headers['Cache-Control'],'no-cache');
 }});
 const result=await publishRelease(f.options,h.adapters);
 assert.equal(result.passed,true);assert.equal(h.published.length,7);assert.equal(new Set(h.published).size,7);
 assert.equal(h.events.includes('wait'),false);assert.deepEqual(result.registryReads.propagation.metadataFallbacks,[record.name]);
 assert.deepEqual(result.registryReads.propagation.pending,[]);assert.equal(h.tagged.length,7);
 const first=h.events.findIndex(e=>e.startsWith('publish:')),last=h.events.findLastIndex(e=>e.startsWith('publish:'));
 assert.ok(!h.events.slice(0,first).some(e=>e.startsWith('packument:')));
 assert.ok(h.events.slice(first,last+1).every(e=>e.startsWith('publish:')));
});

test('fresh package metadata keeps all identity, integrity, origin and byte conflict checks',async t=>{
 for(const problem of ['document-name','versions','manifest-name','version','integrity','origin','bytes'])await t.test(problem,async t=>{
  const f=await fixture(t),record=f.plan.packages[0];let accepted=false;
  const h=registryHarness(f,{afterPublish:({number})=>{if(number===7)accepted=true;},beforeFetch:({url})=>{
   const pathname=decodeURIComponent(url.pathname);
   if(!accepted)return;
   if(pathname===`/${record.name}/${version}`)return new Response(null,{status:404});
   if(pathname===`/${record.name}`){
    const manifest={name:record.name,version,dist:{integrity:record.integrity,tarball:`https://registry.npmjs.org/archives/${encodeURIComponent(record.name)}.tgz`}};
    const document={name:record.name,versions:{[version]:manifest}};
    if(problem==='document-name')document.name='other-package';
    if(problem==='versions')document.versions=[];
    if(problem==='manifest-name')manifest.name='other-package';
    if(problem==='version')manifest.version=old;
    if(problem==='integrity')manifest.dist.integrity='sha512-different';
    if(problem==='origin')manifest.dist.tarball='https://untrusted.example/archive.tgz';
    return Response.json(document);
   }
   if(problem==='bytes'&&pathname===`/archives/${record.name}.tgz`)return new Response('wrong');
  }});
  await assert.rejects(publishRelease(f.options,h.adapters),/identity|versions|integrity|archive URL|byte conflict/);
  assert.equal(h.published.length,7);assert.equal(h.tagged.length,0);
 });
});

test('pending verification diagnostics retain the last actual HTTP result and never print external error text',async t=>{
 for(const missing of ['package','archive'])await t.test(missing,async t=>{
  const f=await fixture(t),record=f.plan.packages[0];let accepted=false;
  const h=registryHarness(f,{afterPublish:({number})=>{if(number===7)accepted=true;},beforeFetch:({url})=>{
   if(!accepted)return;
   const pathname=decodeURIComponent(url.pathname);
   if(missing==='package'&&(pathname===`/${record.name}/${version}`||pathname===`/${record.name}`))return new Response(null,{status:404});
   if(missing==='archive'&&pathname===`/archives/${record.name}.tgz`)return new Response(null,{status:404});
  }});
  let failure;try{await publishRelease(f.options,h.adapters);}catch(error){failure=error;}
  assert.ok(failure);failure.message='Bearer NEVER-PRINT-THIS';failure.registryReadFailure={secret:'NEVER-PRINT-THIS'};
  const message=publicationFailureMessage(failure),summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.match(message,/PROPAGATION_BUDGET_EXHAUSTED/);assert.ok(message.includes(record.name));assert.doesNotMatch(message,/NEVER-PRINT-THIS|Bearer/);
  assert.equal(summary.registryReadFailure.status,404);assert.equal(summary.registryReadFailure.attempt,1);
  assert.equal(summary.registryReadFailure.operation,missing==='package'?'packument':'archive');
  assert.equal(summary.registryReadFailure.pendingReason,missing==='package'?'PACKAGE_NOT_VISIBLE':'ARCHIVE_NOT_VISIBLE');
  assert.equal(h.published.length,7);assert.equal(h.tagged.length,0);assert.equal(summary.registryReads.propagation.waitedMs,360000);
 });
 assert.doesNotMatch(publicationFailureMessage(Error('Bearer NEVER-PRINT-THIS')),/NEVER-PRINT-THIS|Bearer/);
});

test('tag propagation is observed without repeating accepted tag changes', async t => {
 const f=await fixture(t);let elapsed=0,h;
 h=registryHarness(f,{beforeFetch:({url})=>{
  if(h.tagged.length===7&&decodeURIComponent(url.pathname).startsWith('/-/package/')&&elapsed<10000)return Response.json({alpha:old,latest:version});
 }});
 h.adapters.sleep=async ms=>{elapsed+=ms;};
 const result=await publishRelease(f.options,h.adapters);assert.equal(result.passed,true);assert.equal(h.published.length,7);assert.equal(h.tagged.length,7);assert.ok(elapsed>=10000);
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

test('registry reads retry transient GET failures without replaying npm mutations',async t=>{
  const f=await fixture(t);
  let failures=0;
  const h=registryHarness(f,{beforeFetch:({url,available})=>{
    if(available.size===7&&decodeURIComponent(url.pathname)===`/${f.plan.packages[0].name}/${version}`&&failures++<2){
      return new Response('not retained',{status:503});
    }
  }});
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.passed,true);
  assert.equal(h.published.length,7);
  assert.equal(new Set(h.published).size,7);
  assert.equal(h.tagged.length,7);
  assert.equal(result.registryReads.retries.length,2);
  assert.ok(result.registryReads.retries.every(event=>event.phase==='post-batch'&&event.operation==='metadata'&&event.status===503));
});

test('registry reads recover a transient body failure and retain only safe diagnostics',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  const fetcher=h.adapters.fetch;
  let reads=0;
  h.adapters.fetch=async(...args)=>{
    if(reads++===0){
      return new Response(new ReadableStream({start(controller){
        const error=Error('Bearer private-token https://signed.invalid/?secret=value');
        error.code='ECONNRESET';
        controller.error(error);
      }}));
    }
    return fetcher(...args);
  };
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.passed,true);
  assert.equal(h.published.length,7);
  assert.equal(result.registryReads.retries[0].code,'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(result),/private-token|signed\.invalid|secret=value|Bearer/);
});

test('registry reads exhaust three attempts and never expose untrusted transport diagnostics',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  let attempts=0;
  h.adapters.fetch=async()=>{
    attempts++;
    const error=Error('Bearer do-not-retain');
    error.cause={code:'ECONNRESET',url:'https://private.invalid'};
    error.registryReadFailure={phase:'Bearer do-not-retain'};
    throw error;
  };
  await assert.rejects(publishRelease(f.options,h.adapters),/Registry read failed/);
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(attempts,3);
  assert.equal(h.published.length,0);
  assert.deepEqual(summary.registryReadFailure,{phase:'preflight',operation:'metadata',package:f.plan.packages[0].name,status:null,code:'ECONNRESET',attempt:3});
  assert.doesNotMatch(JSON.stringify(summary),/Bearer|do-not-retain|private\.invalid|cause/);
});

test('registry reads reject malformed JSON and content conflicts without retries',async t=>{
  for(const malformed of [true,false]){
    const f=await fixture(t),h=registryHarness(f);
    let attempts=0;
    h.adapters.fetch=async()=>{
      attempts++;
      return malformed?new Response('{not-json'):Response.json({name:'other',version,dist:{}});
    };
    await assert.rejects(publishRelease(f.options,h.adapters),/JSON|identity conflict/);
    const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
    assert.equal(attempts,1);
    assert.equal(h.published.length,0);
    assert.equal(summary.registryReads.retries.length,0);
    assert.equal(summary.registryReadFailure.code,malformed?'INVALID_JSON':'PACKAGE_IDENTITY');
  }
});

test('registry reads include body transfer in their single thirty-second deadline',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  let now=0;
  h.adapters.now=()=>now;
  h.adapters.fetch=async()=>new Response(new ReadableStream({pull(controller){
    now+=30001;
    controller.enqueue(Buffer.from('{}'));
    controller.close();
  }}));
  await assert.rejects(publishRelease(f.options,h.adapters),/Registry read failed/);
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(summary.registryReadFailure.code,'REQUEST_TIMEOUT');
  assert.equal(summary.registryReadFailure.attempt,1);
  assert.equal(h.published.length,0);
});

test('registry reads share their budget with propagation waits but exclude npm subprocess time',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  let now=0;
  const npm=h.adapters.runNpm;
  h.adapters.now=()=>now;
  h.adapters.runNpm=async(...args)=>{
    now+=60000;
    return npm(...args);
  };
  const result=await publishRelease(f.options,h.adapters);
  assert.equal(result.passed,true);
  assert.equal(result.registryReads.elapsedMs,0);
  assert.equal(h.published.length,7);

  const blocked=await fixture(t),waiting=registryHarness(blocked);
  let elapsed=0,requests=0;
  waiting.adapters.now=()=>elapsed;
  waiting.adapters.sleep=async ms=>{elapsed+=ms;};
  waiting.adapters.fetch=async()=>{requests++;return new Response(null,{status:404});};
  for(const record of blocked.plan.packages)record.registry={status:'exact-existing',sha256:record.sha256,integrity:record.integrity};
  blocked.options.planSha256=await blocked.savePlan();
  // Body/headers time plus propagation pauses exhaust the shared allowance
  // before the old twelve-wait loop can multiply it across seven packages.
  const original=waiting.adapters.fetch;
  waiting.adapters.fetch=async(...args)=>{
    elapsed+=10000;
    return original(...args);
  };
  await assert.rejects(publishRelease(blocked.options,waiting.adapters),/Registry read failed/);
  const summary=JSON.parse(await readFile(blocked.options.summary,'utf8'));
  assert.equal(summary.registryReadFailure.code,'READ_BUDGET_EXHAUSTED');
  assert.ok(requests<=13);
  assert.equal(elapsed,180000);
  assert.equal(waiting.published.length,0);
});

test('registry reads use one deadline across transport retries and their backoff',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  let now=0,attempts=0;
  h.adapters.now=()=>now;
  h.adapters.sleep=async ms=>{now+=ms;};
  h.adapters.fetch=async()=>{
    attempts++;
    now+=14900;
    return new Response(null,{status:503});
  };
  await assert.rejects(publishRelease(f.options,h.adapters),/Registry read failed/);
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(attempts,2);
  assert.equal(summary.registryReadFailure.code,'REQUEST_TIMEOUT');
  assert.equal(summary.registryReadFailure.attempt,2);
  assert.equal(summary.registryReads.retries.length,1);
  assert.equal(h.published.length,0);
});

test('registry reads bound broken cancellation and do not overlap another attempt',async t=>{
  const f=await fixture(t),h=registryHarness(f);
  let attempts=0,released=0;
  h.adapters.fetch=async()=>{
    attempts++;
    return {status:200,body:{getReader(){return {
      read:async()=>{throw Object.assign(Error('not retained'),{code:'ECONNRESET'});},
      cancel:()=>new Promise(()=>{}),
      releaseLock(){released++;}
    };}}};
  };
  await assert.rejects(publishRelease(f.options,h.adapters),/Registry read failed/);
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(attempts,1);
  assert.equal(released,1);
  assert.equal(summary.registryReadFailure.code,'CANCEL_TIMEOUT');
  assert.equal(summary.registryReads.retries.length,0);
  assert.equal(h.published.length,0);
});

test('registry reads retry only the allowed HTTP and transport failures',async t=>{
  for(const status of [408,429,500,502,503,504]){
    const f=await fixture(t),h=registryHarness(f),fetcher=h.adapters.fetch;
    let attempts=0;
    h.adapters.fetch=async(...args)=>++attempts===1?new Response(null,{status}):fetcher(...args);
    const result=await publishRelease(f.options,h.adapters);
    assert.equal(result.passed,true);
    assert.equal(result.registryReads.retries[0].status,status);
    assert.equal(h.published.length,7);
  }
  for(const status of [400,401,403]){
    const f=await fixture(t),h=registryHarness(f);
    let attempts=0;
    h.adapters.fetch=async()=>{attempts++;return new Response(null,{status});};
    await assert.rejects(publishRelease(f.options,h.adapters),/Registry read failed/);
    const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
    assert.equal(attempts,1);
    assert.equal(summary.registryReadFailure.code,'HTTP_STATUS');
    assert.equal(h.published.length,0);
  }
  const f=await fixture(t),h=registryHarness(f);
  let attempts=0;
  h.adapters.fetch=async()=>{attempts++;throw Object.assign(Error('private'),{code:'SECRET_NOT_ALLOWED'});};
  await assert.rejects(publishRelease(f.options,h.adapters),/Registry read failed/);
  const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
  assert.equal(attempts,1);
  assert.equal(summary.registryReadFailure.code,'NETWORK_FAILURE');
  assert.doesNotMatch(JSON.stringify(summary),/SECRET_NOT_ALLOWED|private/);
});

test('registry reads preserve immediate SRI and byte conflicts with no retry or tag mutation',async t=>{
  for(const conflict of ['integrity','bytes']){
    const f=await fixture(t),h=registryHarness(f),record=f.plan.packages[0];
    h.available.set(record.name,await readFile(path.join(f.root,record.filename)));
    const fetcher=h.adapters.fetch;
    let metadata=0,archives=0;
    h.adapters.fetch=async input=>{
      const decoded=decodeURIComponent(new URL(input).pathname);
      if(decoded===`/${record.name}/${version}`){
        metadata++;
        if(conflict==='integrity')return Response.json({name:record.name,version,dist:{integrity:'sha512-other',tarball:'https://registry.npmjs.org/not-read.tgz'}});
      }
      if(decoded===`/archives/${record.name}.tgz`){archives++;return new Response('different');}
      return fetcher(input);
    };
    await assert.rejects(publishRelease(f.options,h.adapters),/integrity conflict|byte conflict/);
    const summary=JSON.parse(await readFile(f.options.summary,'utf8'));
    assert.equal(metadata,1);
    assert.equal(archives,conflict==='bytes'?1:0);
    assert.equal(summary.registryReads.retries.length,0);
    assert.equal(summary.registryReadFailure.code,conflict==='bytes'?'ARCHIVE_CONFLICT':'INTEGRITY_CONFLICT');
    assert.equal(h.published.length,0);
    assert.equal(h.tagged.length,0);
  }
});
