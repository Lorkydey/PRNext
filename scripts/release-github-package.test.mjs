import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {archiveDigest,readArchive} from './verify-npm-artifacts.mjs';
import {canonicalName,githubName,validVersion,compareVersions,createReader,publishedCanonical,distributionFiles,writeDistribution,assertSameDistribution,completedReleaseVersion,publishDistribution,linkedPackageMetadata} from './release-github-package.mjs';

function tar(files){const chunks=[];for(const[name,value]of files){const data=Buffer.from(value.data??value),h=Buffer.alloc(512);assert.ok(Buffer.byteLength(name)<100);h.write(name);for(const[at,length,n]of[[100,8,value.mode??0o644],[108,8,0],[116,8,0],[124,12,data.length],[136,12,0]])h.write(n.toString(8).padStart(length-1,'0')+'\0',at,length);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);chunks.push(h,data,Buffer.alloc((512-data.length%512)%512));}return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));}
function fixture(change=()=>{}){
  const manifest={name:canonicalName,version:'0.2.0-alpha',license:'MIT',description:'PRNext fixture',repository:{type:'git',url:'git+https://github.com/Lorkydey/PRNext.git'},engines:{node:'>=22'},scripts:{prepublishOnly:'must never run'},optionalDependencies:{native:'0.2.0-alpha'},exports:{'.':{types:'./compat/index.d.ts',default:'./index.mjs'},'./server':{types:'./compat/server.d.cts',default:'./compat/server.cjs'},'./link':'./compat/link.cjs','./package.json':'./package.json','./AI.md':'./AI.md'}};
  change(manifest);const files=new Map(Object.entries({'package.json':JSON.stringify(manifest),'index.mjs':'export const route=(path)=>path; export const build=()=>42;','cli.mjs':"console.log('fixture:'+process.argv.slice(2).join('|'));",'compat/index.d.ts':'export declare function route(path:string):string; export declare function build():number;','compat/server.cjs':'exports.NextResponse=class NextResponse {};','compat/server.d.cts':'export declare class NextResponse {}','compat/link.cjs':'module.exports=function Link(){};','compat/link.d.cts':'declare function Link():void;\nexport = Link;','AI.md':'Fixture AI guide','docs/ai/manifest.json':'{"fixture":true}','LICENSE':'MIT fixture'}).map(([name,data])=>['package/'+name,Buffer.from(data)]));
  manifest.exports['./router']='./compat/router.cjs';files.set('package/package.json',Buffer.from(JSON.stringify(manifest)));
  files.set('package/compat/link.d.cts',Buffer.from('export default function Link():void;'));
  files.set('package/compat/server.d.cts',Buffer.from('export declare class NextResponse {private identity:void;}'));
  files.set('package/compat/router.cjs',Buffer.from("module.exports={pathname:'/'};"));files.set('package/compat/router.d.cts',Buffer.from('declare const router:{pathname:string};\nexport = router;'));
  const archive=tar(files);return {version:manifest.version,archive,integrity:archiveDigest(archive).integrity,releaseCommit:'a'.repeat(40)};
}
async function directory(t){const root=await mkdtemp(path.join(tmpdir(),'prnext-github distribution-'));t.after(async()=>{assert.ok(path.basename(root).startsWith('prnext-github distribution-'));assert.equal(path.dirname(root),tmpdir());await rm(root,{recursive:true,force:true});});return root;}

test('GitHub distribution depends on the exact official runtime and retains its API surface',()=>{
  const source=fixture(),files=distributionFiles(source),manifest=JSON.parse(files.get('package.json').data);
  assert.equal(manifest.name,githubName);assert.deepEqual(manifest.dependencies,{[canonicalName]:source.version});assert.deepEqual(Object.keys(manifest.exports),Object.keys(JSON.parse(readArchive(source.archive).get('package/package.json').data).exports));
  assert.equal(manifest.scripts,undefined);assert.equal(manifest.optionalDependencies,undefined);assert.equal(manifest.publishConfig.registry,'https://npm.pkg.github.com');assert.equal(manifest.prnextDistribution.integrity,source.integrity);
  assert.equal(files.get('AI.md').data.toString(),'Fixture AI guide');assert.equal(files.get('docs/ai/manifest.json').data.toString(),'{"fixture":true}');
});
test('installed forwarders share runtime identities and preserve CLI arguments in paths with spaces',async t=>{
  const root=await directory(t),source=fixture(),canonical=path.join(root,'node_modules/@thomas.f/prnext'),wrapper=path.join(root,'node_modules/@lorkydey/prnext');
  for(const[name,value]of readArchive(source.archive)){const file=path.join(canonical,name.slice(8));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value.data);}
  await mkdir(path.dirname(wrapper),{recursive:true});await writeDistribution(source,wrapper);
  const require=createRequire(path.join(root,'package.json'));assert.equal(require(githubName+'/server').NextResponse,require(canonicalName+'/server').NextResponse);assert.equal(require(githubName+'/link'),require(canonicalName+'/link'));
  const official=await import(pathToFileURL(path.join(canonical,'index.mjs'))),entry=await import(pathToFileURL(path.join(wrapper,'index.mjs')));assert.equal(entry.route,official.route);assert.equal(entry.build,official.build);
  const esmLink=await import(pathToFileURL(path.join(wrapper,'compat/link.mjs'))),esmServer=await import(pathToFileURL(path.join(wrapper,'compat/server.mjs')));assert.equal(esmLink.default,require(canonicalName+'/link'));assert.equal(esmServer.NextResponse,require(canonicalName+'/server').NextResponse);
  const result=await promisify(execFile)(process.execPath,[path.join(wrapper,'cli.mjs'),'--version','argument with spaces'],{windowsHide:true});assert.equal(result.stdout.trim(),'fixture:--version|argument with spaces');
});
test('compiled application imports retain a component when the framework resolves it as an ES module',async t=>{
  const root=await directory(t),source=fixture(),wrapper=path.join(root,'node_modules/@lorkydey/prnext');await mkdir(path.dirname(wrapper),{recursive:true});await writeDistribution(source,wrapper);
  const {build}=await import('esbuild');const result=await build({stdin:{contents:`import Link from '${githubName}/link';export {Link};`,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'framework-esm-alias',setup(builder){builder.onResolve({filter:/^@thomas\.f\/prnext\/link$/},()=>({path:'link',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function Link(){return "component"};export function useLinkStatus(){return false;}'}));}}]});
  const module=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));assert.equal(typeof module.Link,'function');assert.equal(module.Link(),'component');
});
test('forwarded TypeScript declarations preserve named and export-equals module identities',async t=>{
  const root=await directory(t),source=fixture(),canonical=path.join(root,'node_modules/@thomas.f/prnext'),wrapper=path.join(root,'node_modules/@lorkydey/prnext');
  for(const[name,value]of readArchive(source.archive)){const file=path.join(canonical,name.slice(8));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value.data);}
  await mkdir(path.dirname(wrapper),{recursive:true});await writeDistribution(source,wrapper);await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  const input=path.join(root,'consumer.mts');await writeFile(input,`import {route} from '${githubName}';import {NextResponse} from '${githubName}/server';import Link from '${githubName}/link';import Router from '${githubName}/router';import {NextResponse as Original} from '${canonicalName}/server';const same:typeof Original=NextResponse;const result:string=route('/');const pathname:string=Router.pathname;Link();new same();void result;void pathname;`);
  const ts=await import('typescript');for(const settings of [{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext},{module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler}]){const program=ts.createProgram([input],{...settings,target:ts.ScriptTarget.ES2022,strict:true,noEmit:true,esModuleInterop:true,types:[]});const diagnostics=ts.getPreEmitDiagnostics(program);assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);}
});
test('wrong source identity, integrity and exported paths cannot create a distribution',()=>{
  assert.throws(()=>distributionFiles(fixture(p=>p.name='@other/package')),/strictly equal/);
  assert.throws(()=>distributionFiles({...fixture(),integrity:'sha512-wrong'}),/strictly equal/);
  assert.throws(()=>distributionFiles(fixture(p=>p.exports['.']='./../../outside.mjs')));
  assert.throws(()=>distributionFiles(fixture(p=>p.exports['.']='./missing.mjs')),/Missing exported source/);
});
test('existing GitHub packages must contain the exact prepared files',()=>{
  const files=distributionFiles(fixture()),archive=tar(new Map([...files].map(([n,v])=>['package/'+n,v])));assert.equal(assertSameDistribution(files,archive),true);
  const changed=new Map(files);changed.set('index.mjs',{data:Buffer.from('export const wrong=true;')});assert.throws(()=>assertSameDistribution(changed,archive),/differs/);
  changed.set('unexpected.mjs',{data:Buffer.from('unexpected')});assert.throws(()=>assertSameDistribution(changed,archive),/Unexpected/);
});
test('release version ordering includes numeric prereleases and never accepts shell input',()=>{
  for(const bad of ['1.2.3;whoami','../1.2.3','01.2.3','1.2.3-alpha.01','1.2.3\n'])assert.throws(()=>validVersion(bad));
  assert.equal(compareVersions('0.2.0-alpha.10','0.2.0-alpha.9'),1);assert.equal(compareVersions('0.2.0','0.2.0-alpha'),1);assert.equal(compareVersions('1.0.0-alpha','0.99.99'),1);assert.equal(compareVersions('0.1.22-alpha','0.2.0-alpha'),-1);
});
test('read-only transient failures retry within their bound while permanent failures stop',async()=>{
  let calls=0;const get=createReader({fetcher:async()=>new Response(++calls<3?'bad':'ok',{status:calls<3?502:200}),wait:async()=>{}});assert.equal((await get('https://api.github.com/repos/Lorkydey/PRNext/releases',{operation:'Fixture read'})).toString(),'ok');assert.equal(calls,3);
  calls=0;const denied=createReader({fetcher:async()=>{calls++;return new Response('private body',{status:403});},wait:async()=>{}});await assert.rejects(()=>denied('https://api.github.com/user',{operation:'Fixture read'}),/HTTP 403/);assert.equal(calls,1);
  calls=0;const unavailable=createReader({fetcher:async()=>{calls++;throw new Error('sensitive server detail');},wait:async()=>{}});await assert.rejects(()=>unavailable('https://api.github.com/user',{operation:'Fixture read'}),error=>error.message==='Fixture read: network read failed');assert.equal(calls,4);
});
test('signed archive redirects strip the GitHub credential and reject untrusted destinations',async()=>{
  const requests=[];const get=createReader({fetcher:async(url,options)=>{requests.push({url,options});return requests.length===1?new Response(null,{status:302,headers:{location:'https://fixture.blob.core.windows.net/archive?signature=fixture'}}):new Response('bytes');},wait:async()=>{}});
  assert.equal((await get('https://npm.pkg.github.com/download/fixture',{operation:'Fixture archive',token:'fixture-secret',archive:true})).toString(),'bytes');assert.equal(requests[0].options.headers.Authorization,'Bearer fixture-secret');assert.equal(requests[1].options.headers.Authorization,undefined);
  let calls=0;const rejected=createReader({fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://untrusted.example/archive'}});},wait:async()=>{}});await assert.rejects(()=>rejected('https://npm.pkg.github.com/download/fixture',{operation:'Fixture archive',token:'fixture-secret',archive:true}),/redirect rejected/);assert.equal(calls,1);
});
test('archive reads are bounded and registry credentials never go to npmjs',async()=>{
  const get=createReader({fetcher:async()=>new Response('oversize'),wait:async()=>{}});await assert.rejects(()=>get('https://registry.npmjs.org/fixture',{operation:'Fixture read',maxBytes:2}),/too large/);await assert.rejects(()=>get('https://registry.npmjs.org/fixture',{operation:'Fixture read',token:'secret'}),/Credential destination/);
});
test('public canonical archive must match the published GitHub asset digest',async()=>{
  const source=fixture(),digest=archiveDigest(source.archive),release={draft:false,published_at:'2026-11-12T00:00:00Z',tag_name:'v'+source.version,target_commitish:source.releaseCommit,assets:[{name:'thomas.f-prnext-'+source.version+'.tgz',state:'uploaded',size:digest.size,digest:'sha256:'+digest.sha256}]};
  const metadata={name:canonicalName,version:source.version,repository:{url:'git+https://github.com/Lorkydey/PRNext.git'},dist:{tarball:'https://registry.npmjs.org/fixture.tgz',integrity:source.integrity}};
  const get=async(url)=>url.includes('/releases/tags/')?Buffer.from(JSON.stringify(release)):url.endsWith('.tgz')?source.archive:Buffer.from(JSON.stringify(metadata));
  assert.equal((await publishedCanonical(source.version,{get,token:undefined})).integrity,source.integrity);
  release.assets[0].digest='sha256:'+'0'.repeat(64);await assert.rejects(()=>publishedCanonical(source.version,{get,token:undefined}),/differs/);
});
test('automatic distribution accepts only a successful first-attempt release from this protected main',()=>{
  const source={repository:{full_name:'Lorkydey/PRNext'},workflow_run:{name:'Publish qualified release',path:'.github/workflows/publish.yml',head_branch:'main',event:'workflow_dispatch',conclusion:'success',run_attempt:1,head_repository:{full_name:'Lorkydey/PRNext'},display_title:'PRNext 0.2.0-alpha release'}};
  assert.equal(completedReleaseVersion(source),'0.2.0-alpha');
  for(const change of [r=>r.head_branch='feature',r=>r.head_repository.full_name='other/PRNext',r=>r.conclusion='failure',r=>r.run_attempt=2,r=>r.event='pull_request',r=>r.path='.github/workflows/other.yml',r=>r.display_title='PRNext 0.2.0-alpha;command release']){const event=structuredClone(source);change(event.workflow_run);assert.throws(()=>completedReleaseVersion(event));}
});
async function publisher(t){
  const root=await directory(t),source=fixture(),output=path.join(root,'package'),files=await writeDistribution(source,output),bytes=tar(new Map([...files].map(([n,v])=>['package/'+n,v]))),archiveFile=path.join(root,'package.tgz');await writeFile(archiveFile,bytes);
  const manifest=JSON.parse(files.get('package.json').data),state={bytes,commands:[],packument:null};const metadata=()=>({...manifest,dist:{integrity:archiveDigest(state.bytes).integrity,tarball:'https://npm.pkg.github.com/download/fixture.tgz'}});
  const npm=async args=>{
    state.commands.push(args);assert.ok(args.includes('--registry=https://npm.pkg.github.com'));assert.ok(!args.includes('fixture-secret'));
    if(args[0]==='publish'){assert.equal(JSON.parse(await readFile(path.join(root,'github-package-result.json'),'utf8')).uploadStarted,true);state.packument??={versions:{},'dist-tags':{}};state.packument.versions[source.version]=metadata();state.packument['dist-tags'][args.find(a=>a.startsWith('--tag=')).slice(6)]=source.version;}
    else{assert.deepEqual(args.slice(0,2),['dist-tag','add']);state.packument['dist-tags'][args[3]]=source.version;}
  };
  const get=async url=>url.includes('/download/')?state.bytes:state.packument?Buffer.from(JSON.stringify(state.packument)):null;
  const options={directory:output,archiveFile,expectedFiles:files,token:'fixture-secret',attempt:'1',get,npm,wait:async()=>{}};
  return {root,state,metadata,options,publish:()=>publishDistribution(options)};
}
test('first GitHub publication writes once, verifies bytes and reads back both tags',async t=>{
  const f=await publisher(t),result=await f.publish();assert.equal(result.passed,true);assert.equal(result.uploaded,true);assert.equal(result.tags.latest,'0.2.0-alpha');assert.equal(result.tags.alpha,'0.2.0-alpha');assert.equal(f.state.commands.filter(a=>a[0]==='publish').length,1);
});
test('an exact existing version skips uploads and a differing archive refuses publication',async t=>{
  const f=await publisher(t);f.state.packument={versions:{'0.2.0-alpha':f.metadata()},'dist-tags':{latest:'0.2.0-alpha',alpha:'0.2.0-alpha'}};assert.equal((await f.publish()).existing,true);assert.deepEqual(f.state.commands,[]);
  const wrong=await publisher(t),files=readArchive(wrong.state.bytes);files.get('package/index.mjs').data=Buffer.from('export const corrupted=true;');wrong.state.bytes=tar(files);wrong.state.packument={versions:{'0.2.0-alpha':wrong.metadata()},'dist-tags':{latest:'0.2.0-alpha'}};await assert.rejects(()=>wrong.publish(),/differs/);assert.deepEqual(wrong.state.commands,[]);
});
test('uncertain uploads are never retried and a fresh verified recovery only reads existing bytes',async t=>{
  const f=await publisher(t),npm=f.options.npm;f.options.npm=async args=>{await npm(args);throw new Error('Fixture response lost after acceptance');};await assert.rejects(()=>f.publish(),/response lost/);assert.equal(f.state.commands.length,1);const report=JSON.parse(await readFile(path.join(f.root,'github-package-result.json'),'utf8'));assert.equal(report.uploadStarted,true);assert.equal(report.uploaded,false);assert.equal(report.passed,false);
  await assert.rejects(()=>f.publish(),/EEXIST/);assert.equal(f.state.commands.length,1);
  const recovery=await publisher(t);recovery.state.packument=structuredClone(f.state.packument);recovery.state.packument['dist-tags'].alpha='0.2.0-alpha';assert.equal((await recovery.publish()).existing,true);assert.deepEqual(recovery.state.commands,[]);
});
test('older distribution versions never move newer GitHub tags backwards',async t=>{
  const f=await publisher(t);f.state.packument={versions:{},'dist-tags':{latest:'0.3.0-alpha',alpha:'0.3.0-alpha'}};const result=await f.publish();assert.equal(result.tags.latest,'0.3.0-alpha');assert.equal(result.tags.alpha,'0.3.0-alpha');assert.equal(f.state.commands.length,1);assert.ok(f.state.commands[0].includes('--tag=archive-0.2.0-alpha'));
});
test('publication rejects reruns before any read or write',async()=>{let touched=false;await assert.rejects(()=>publishDistribution({attempt:'2',directory:'unused',get:async()=>{touched=true;},npm:async()=>{touched=true;}}),/fresh first-attempt/);assert.equal(touched,false);});
test('repository association is reported only when GitHub metadata confirms this exact repository',async()=>{
  const metadata={name:'prnext',package_type:'npm',repository:{full_name:'Lorkydey/PRNext'},visibility:'private',html_url:'https://github.com/Lorkydey/PRNext/packages/123'};const get=async()=>Buffer.from(JSON.stringify(metadata));const result=await linkedPackageMetadata({get,token:'fixture-secret'});assert.equal(result.verified,true);assert.equal(result.visibility,'private');assert.equal(result.repository,'Lorkydey/PRNext');
  metadata.repository.full_name='private/other';const wrong=await linkedPackageMetadata({get,token:'fixture-secret'});assert.equal(wrong.verified,false);assert.ok(!JSON.stringify(wrong).includes('private/other'));
  assert.equal((await linkedPackageMetadata({get:async()=>{throw Error('denied');}})).verified,false);
});
test('compiler-owned fonts keep their canonical import contract rather than exposing untransformed aliases',()=>{
  const source=fixture(p=>{p.exports['./font/local']='./compat/font-local.cjs';p.exports['./font/google']='./compat/font-google.cjs';});const files=distributionFiles(source),manifest=JSON.parse(files.get('package.json').data);assert.ok(!Object.hasOwn(manifest.exports,'./font/local'));assert.ok(!Object.hasOwn(manifest.exports,'./font/google'));assert.match(files.get('README.md').data.toString(),/next\/font\/\*/);
});
test('a registry without SRI metadata still requires every prepared file, and a supplied wrong SRI is rejected',async t=>{
  const f=await publisher(t),entry=f.metadata();delete entry.dist.integrity;f.state.packument={versions:{'0.2.0-alpha':entry},'dist-tags':{latest:'0.2.0-alpha',alpha:'0.2.0-alpha'}};assert.equal((await f.publish()).existing,true);assert.deepEqual(f.state.commands,[]);
  const wrong=await publisher(t),metadata=wrong.metadata();metadata.dist.integrity='sha512-wrong';wrong.state.packument={versions:{'0.2.0-alpha':metadata},'dist-tags':{latest:'0.2.0-alpha'}};await assert.rejects(()=>wrong.publish());assert.deepEqual(wrong.state.commands,[]);
  const corrupt=await publisher(t),files=readArchive(corrupt.state.bytes);files.get('package/index.mjs').data=Buffer.from('export const wrong=true;');corrupt.state.bytes=tar(files);const absent=corrupt.metadata();delete absent.dist.integrity;corrupt.state.packument={versions:{'0.2.0-alpha':absent},'dist-tags':{latest:'0.2.0-alpha'}};await assert.rejects(()=>corrupt.publish(),/differs/);assert.deepEqual(corrupt.state.commands,[]);
});
test('a changed prepared artifact cannot authorize any GitHub upload',async t=>{
  const f=await publisher(t),files=readArchive(await readFile(f.options.archiveFile));files.get('package/cli.mjs').data=Buffer.from('throw Error("changed");');await writeFile(f.options.archiveFile,tar(files));await assert.rejects(()=>f.publish(),/differs/);assert.deepEqual(f.state.commands,[]);
});
