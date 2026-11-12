import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {archiveDigest,readArchive} from './verify-npm-artifacts.mjs';

export const canonicalName='@thomas.f/prnext';
export const githubName='@lorkydey/prnext';
const repository='Lorkydey/PRNext';
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;
export function validVersion(version){
  assert.equal(typeof version,'string');assert.ok(version.length<=100&&version===version.trim()&&versionPattern.test(version),'Invalid release version');
  assert.ok(!version.split('-').slice(1).join('-').split('.').some(part=>/^0\d+$/.test(part)),'Invalid numeric prerelease');
  return version;
}
export function compareVersions(a,b){
  const left=versionPattern.exec(validVersion(a)),right=versionPattern.exec(validVersion(b));
  for(let i=1;i<=3;i++){const difference=BigInt(left[i])-BigInt(right[i]);if(difference)return difference>0n?1:-1;}
  if(!left[4]||!right[4])return left[4]===right[4]?0:left[4]?-1:1;
  const x=left[4].split('.'),y=right[4].split('.');
  for(let i=0;i<Math.max(x.length,y.length);i++){
    if(x[i]===y[i])continue;if(x[i]===undefined)return -1;if(y[i]===undefined)return 1;
    const numericX=/^\d+$/.test(x[i]),numericY=/^\d+$/.test(y[i]);
    if(numericX&&numericY)return BigInt(x[i])>BigInt(y[i])?1:-1;
    if(numericX!==numericY)return numericX?-1:1;return x[i]>y[i]?1:-1;
  }return 0;
}

// Only GETs are retried. Credentials and response bodies never enter errors.
export function createReader({fetcher=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>performance.now(),budgetMs=120000}={}){
  const deadline=now()+budgetMs;
  return async function get(url,{operation,token,maxBytes=8*1024**2,allowMissing=false,archive=false}={}){
    const target=new URL(url);assert.equal(target.protocol,'https:');assert.ok(['api.github.com','registry.npmjs.org','npm.pkg.github.com'].includes(target.hostname));
    assert.ok(!target.username&&!target.password&&!target.port&&!target.hash);
    if(token)assert.ok(['api.github.com','npm.pkg.github.com'].includes(target.hostname),'Credential destination rejected');
    for(let attempt=0;attempt<4;attempt++){
      let response,bytes;const remaining=deadline-now();if(remaining<=0)throw new Error(`${operation}: read budget exhausted`);
      try{
        let current=target;
        for(let redirect=0;redirect<=3;redirect++){
          response=await fetcher(current.href,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(30000,Math.floor(deadline-now())))),headers:{Accept:archive?'application/octet-stream':'application/json','Cache-Control':'no-cache','User-Agent':'PRNext-GitHub-package',...(current.hostname==='api.github.com'?{'X-GitHub-Api-Version':'2022-11-28'}:{}),...(token&&current.origin===target.origin?{Authorization:`Bearer ${token}`}:{})}});
          if(![301,302,303,307,308].includes(response.status))break;
          const location=response.headers.get('location');await response.body?.cancel();
          const next=new URL(location,current);
          const trusted=next.hostname==='npm.pkg.github.com'||next.hostname.endsWith('.blob.core.windows.net')||next.hostname.endsWith('.githubusercontent.com');
          if(!archive||target.hostname!=='npm.pkg.github.com'||!location||redirect===3||next.protocol!=='https:'||next.username||next.password||next.port||!trusted)throw Object.assign(new Error(`${operation}: redirect rejected`),{permanent:true});
          current=next;
        }
        if(response.status===404&&allowMissing){await response.body?.cancel();return null;}
        if(response.status!==200){await response.body?.cancel();if([408,429,500,502,503,504].includes(response.status)&&attempt<3){await wait(Math.min(1000*(attempt+1),Math.max(0,deadline-now())));continue;}throw Object.assign(new Error(`${operation}: HTTP ${response.status}`),{permanent:true});}
        const parts=[];let size=0;
        if(response.body)for await(const chunk of response.body){size+=chunk.byteLength;if(size>maxBytes)throw Object.assign(new Error(`${operation}: response too large`),{permanent:true});parts.push(Buffer.from(chunk));}
        bytes=Buffer.concat(parts);return bytes;
      }catch(error){if(error.permanent)throw error;if(attempt===3)throw new Error(`${operation}: network read failed`);await wait(Math.min(1000*(attempt+1),Math.max(0,deadline-now())));}
    }
  };
}
function json(bytes,operation){try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Error(`${operation}: invalid JSON`);}}
export async function publishedCanonical(version,{get=createReader(),token=process.env.GITHUB_TOKEN}={}){
  let release;
  if(version==='auto'){
    const releases=json(await get(`https://api.github.com/repos/${repository}/releases?per_page=100`,{operation:'Read published releases',token}),'Read published releases');
    assert.ok(Array.isArray(releases));
    const candidates=releases.filter(r=>!r.draft&&r.published_at&&typeof r.tag_name==='string'&&versionPattern.test(r.tag_name.replace(/^v/,'')));
    candidates.sort((a,b)=>compareVersions(b.tag_name.replace(/^v/,''),a.tag_name.replace(/^v/,'')));assert.ok(candidates.length,'No published PRNext release');release=candidates[0];version=release.tag_name.replace(/^v/,'');
  }else{validVersion(version);release=json(await get(`https://api.github.com/repos/${repository}/releases/tags/v${version}`,{operation:'Read matching GitHub release',token}),'Read matching GitHub release');}
  validVersion(version);assert.equal(release.draft,false);assert.ok(release.published_at);assert.equal(release.tag_name,`v${version}`);
  assert.match(release.target_commitish,/^[a-f0-9]{40}$/,'Release must identify its verified commit');
  const asset=release.assets.find(a=>a.name===`thomas.f-prnext-${version}.tgz`);assert.ok(asset&&asset.state==='uploaded','Qualified framework archive missing');assert.match(asset.digest,/^sha256:[a-f0-9]{64}$/);
  const metadata=json(await get(`https://registry.npmjs.org/${encodeURIComponent(canonicalName)}/${version}`,{operation:'Read official npm version'}),'Read official npm version');
  assert.equal(metadata.name,canonicalName);assert.equal(metadata.version,version);assert.equal(metadata.repository?.url,'git+https://github.com/Lorkydey/PRNext.git');
  const url=new URL(metadata.dist.tarball);assert.equal(url.origin,'https://registry.npmjs.org');
  const archive=await get(url.href,{operation:'Read official npm archive',maxBytes:64*1024**2});const digest=archiveDigest(archive);
  assert.equal(digest.size,asset.size);assert.equal('sha256:'+digest.sha256,asset.digest,'npm archive differs from GitHub release');assert.equal(digest.integrity,metadata.dist.integrity);
  return {version,archive,integrity:digest.integrity,releaseCommit:release.target_commitish};
}
function relativeTarget(target){assert.equal(typeof target,'string');assert.ok(target.startsWith('./')&&!target.includes('\\')&&!target.includes('*'));const value=target.slice(2);assert.ok(value.split('/').every(part=>part&&part!=='.'&&part!=='..'));assert.ok(!value.includes(':'));return value;}
function defaultExport(source){return /^\s*export\s+(?:declare\s+)?default\b/m.test(source)||[...source.matchAll(/^\s*export\s*\{([^}]+)\}/gm)].some(match=>match[1].split(',').some(value=>value.trim()==='default'||/\bas\s+default$/.test(value.trim())));}
export function distributionFiles({version,archive,integrity,releaseCommit}){
  validVersion(version);assert.equal(archiveDigest(archive).integrity,integrity);assert.match(releaseCommit,/^[a-f0-9]{40}$/);
  const original=readArchive(archive),entry=name=>{const result=original.get('package/'+name);assert.ok(result,`Missing exported source: ${name}`);return result;};
  const source=json(entry('package.json').data,'Official package manifest');assert.equal(source.name,canonicalName);assert.equal(source.version,version);assert.equal(source.repository?.url,'git+https://github.com/Lorkydey/PRNext.git');assert.ok(source.exports&&typeof source.exports==='object'&&!Array.isArray(source.exports));
  const files=new Map();const put=(name,data,mode=0o644)=>{relativeTarget('./'+name);const value={data:Buffer.from(data),mode};if(files.has(name))assert.deepEqual(files.get(name),value,'Conflicting export targets');else files.set(name,value);};
  function types(name,specifier){const text=entry(name).data.toString('utf8');put(name,/^\s*export\s*=\s*/m.test(text)?`import value = require(${JSON.stringify(specifier)});\nexport = value;\n`:`export * from ${JSON.stringify(specifier)};\n${defaultExport(text)?`export {default} from ${JSON.stringify(specifier)};\n`:''}`);}
  function target(value,specifier){
    if(value&&typeof value==='object'&&!Array.isArray(value)){for(const leaf of Object.values(value))target(leaf,specifier);return;}
    const name=relativeTarget(value);if(name==='package.json')return;const bytes=entry(name).data;
    if(/\.d\.(?:ts|cts|mts)$/.test(name)){types(name,specifier);return;}
    if(name.endsWith('.cjs')){
      put(name,`module.exports = require(${JSON.stringify(specifier)});\n`);
      const declaration=name.slice(0,-4)+'.d.cts',declarationSource=original.get('package/'+declaration)?.data.toString('utf8')||'';
      const hasDefault=defaultExport(declarationSource)||/^\s*export\s*=/m.test(declarationSource)||/(?:module\.exports|exports)\.default\s*=/.test(bytes.toString('utf8'));
      put(name.slice(0,-4)+'.mjs',`${hasDefault?`import * as implementation from ${JSON.stringify(specifier)};\n`:''}export * from ${JSON.stringify(specifier)};\n${hasDefault?`export default Reflect.get(implementation,'default') ?? implementation;\n`:''}`);
      if(original.has('package/'+declaration))types(declaration,specifier);return;
    }
    if(name.endsWith('.mjs')){put(name,`export * from ${JSON.stringify(specifier)};\n${defaultExport(bytes.toString('utf8'))?`export {default} from ${JSON.stringify(specifier)};\n`:''}`);return;}
    assert.ok(name.endsWith('.md')||name.endsWith('.json'),'Unsupported exported asset');put(name,bytes);
  }
  const exports={};
  for(const [key,value]of Object.entries(source.exports)){
    // Font calls are transformed from their literal import path by the compiler.
    // Keep those calls on the documented canonical paths, instead of offering
    // aliases that appear valid but cannot undergo the font transform.
    if(['./font/local','./font/google'].includes(key))continue;
    assert.ok(key==='.'||key.startsWith('./'));target(value,key==='.'?canonicalName:canonicalName+'/'+key.slice(2));
    const runtime=typeof value==='string'?value:value.default;
    if(typeof runtime==='string'&&runtime.endsWith('.cjs')){
      const declaration=runtime.slice(0,-4)+'.d.cts',base=typeof value==='string'?{}:Object.fromEntries(Object.entries(value).filter(([condition])=>condition!=='default'));
      assert.ok(!Object.hasOwn(base,'import')&&!Object.hasOwn(base,'require'),'Unsupported nested runtime export');
      if(!base.types&&original.has('package/'+relativeTarget(declaration)))base.types=declaration;
      if(typeof base.types==='string'&&base.types.endsWith('.d.cts')&&defaultExport(entry(relativeTarget(base.types)).data.toString('utf8'))){
        const imported=base.types.slice(0,-6)+'.d.mts',specifier=key==='.'?canonicalName:canonicalName+'/'+key.slice(2);
        put(relativeTarget(imported),`export * from ${JSON.stringify(specifier)};\ndeclare const value: typeof import(${JSON.stringify(specifier)}).default;\nexport default value;\n`);
        base.types={import:imported,require:base.types};
      }
      exports[key]={...base,import:runtime.slice(0,-4)+'.mjs',require:runtime,default:runtime.slice(0,-4)+'.mjs'};
    }else exports[key]=value;
  }
  for(const [name,value]of original)if(name.startsWith('package/docs/ai/')||name==='package/LICENSE')put(name.slice(8),value.data);
  put('cli.mjs',`#!/usr/bin/env node\nimport {createRequire} from 'node:module';\nimport {dirname,join} from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst require=createRequire(import.meta.url);\nawait import(pathToFileURL(join(dirname(require.resolve(${JSON.stringify(canonicalName+'/package.json')})),'cli.mjs')).href);\n`,0o755);
  const manifest={name:githubName,version,description:source.description,license:source.license,homepage:source.homepage,repository:source.repository,bugs:source.bugs,author:source.author,keywords:source.keywords,type:'module',bin:{prnext:'./cli.mjs',prn:'./cli.mjs'},exports,dependencies:{[canonicalName]:version},peerDependencies:source.peerDependencies,peerDependenciesMeta:source.peerDependenciesMeta,engines:source.engines,publishConfig:{registry:'https://npm.pkg.github.com',access:'public',tag:'latest'},prnextDistribution:{kind:'official-npm-runtime',package:canonicalName,version,integrity,releaseCommit}};
  manifest.files=[...new Set([...files.keys()].filter(name=>!['README.md','LICENSE'].includes(name)).map(name=>name.includes('/')?name.split('/')[0]+'/':name))].sort();
  put('package.json',JSON.stringify(manifest,null,2)+'\n');
  put('README.md',`# PRNext\n\nPRNext ${version}, distributed through GitHub Packages. This entry uses the exact official \`${canonicalName}@${version}\` dependency. The CLI, framework APIs and native runtime come from that package.\n\n## Install from npm\n\n\`\`\`sh\nnpm install ${canonicalName}\n\`\`\`\n\n## Install from GitHub Packages\n\nAuthenticate to GitHub Packages with read access and configure the account scope in your project’s .npmrc:\n\n\`\`\`ini\n@lorkydey:registry=https://npm.pkg.github.com\n\`\`\`\n\n\`\`\`sh\nnpm install ${githubName}\nnpx --no-install prnext --version\n\`\`\`\n\nThe package provides the corresponding CLI and exported subpaths, including \`${githubName}/link\` and \`${githubName}/server\`. It requires Node.js \`${source.engines.node}\`. Use \`prnext\` on Windows; \`prn\` is the Unix shortcut.\n\nKeep the documented \`next/*\` or \`${canonicalName}/*\` imports in application source for compiler-managed features. Font loaders remain available through \`next/font/*\` and \`${canonicalName}/font/*\`; the GitHub entry does not introduce alternate font import paths.\n\nRead the [documentation](https://prnext.dev) and [source](https://github.com/${repository}). PRNext remains experimental alpha software; compatibility and resource usage depend on the application.\n`);
  return files;
}
export async function writeDistribution(input,directory){const files=distributionFiles(input);await mkdir(directory);for(const[name,value]of files){const file=path.join(directory,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value.data,{flag:'wx',mode:value.mode});}return files;}
export function assertSameDistribution(expected,archive){const observed=readArchive(archive);assert.equal(observed.size,expected.size,'Unexpected GitHub package files');for(const[name,value]of expected){const actual=observed.get('package/'+name);assert.deepEqual(actual?.data,value.data,`GitHub package differs: ${name}`);if(value.mode&0o111)assert.ok(actual.mode&0o111,`GitHub executable permission missing: ${name}`);}return true;}
export function completedReleaseVersion(event){
  const run=event.workflow_run;assert.equal(event.repository?.full_name,repository);assert.equal(run.name,'Publish qualified release');assert.equal(run.path,'.github/workflows/publish.yml');assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.conclusion,'success');assert.equal(run.run_attempt,1);assert.equal(run.head_repository.full_name,repository);
  const title=/^PRNext (\S+) release$/.exec(run.display_title);assert.ok(title);return validVersion(title[1]);
}
export function recordedReleaseJobs(document){
  if(!Array.isArray(document?.jobs)||document.total_count!==document.jobs.length)return false;
  return ['Verify qualified archives','Publish all seven packages','Record the verified release'].every(name=>{
    const matches=document.jobs.filter(job=>job.name===name);return matches.length===1&&matches[0].status==='completed'&&matches[0].conclusion==='success';
  });
}
export async function linkedPackageMetadata({get=createReader({budgetMs:60000}),token}={}){
  for(const entry of [{path:'/user/packages/npm/prnext',token},{path:'/users/Lorkydey/packages/npm/prnext',token},{path:'/users/Lorkydey/packages/npm/prnext',token:undefined}]){
    let bytes;try{bytes=await get('https://api.github.com'+entry.path,{operation:'Read GitHub package association',token:entry.token,allowMissing:true});}catch{continue;}
    if(!bytes)continue;const metadata=json(bytes,'GitHub package association');
    if(!['prnext',githubName].includes(metadata.name)||metadata.package_type!=='npm'||metadata.repository?.full_name!==repository)return {verified:false,reason:'Repository association does not match'};
    const url=new URL(metadata.html_url);assert.equal(url.origin,'https://github.com');assert.ok(!url.username&&!url.password);
    return {verified:true,repository,visibility:metadata.visibility,url:url.href};
  }return {verified:false,reason:'Package metadata requires owner access'};
}
function execute(command,args,options={}){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});child.once('error',()=>reject(new Error('Package command could not start')));child.once('exit',(code,signal)=>code===0&&!signal?resolve():reject(new Error(`Package command failed (${signal||code})`)));});}
async function cli(){
  const [command,...args]=process.argv.slice(2);const options={};for(let i=0;i<args.length;i+=2){assert.ok(['--directory','--version','--archive','--npm-cli'].includes(args[i])&&args[i+1]);assert.ok(!Object.hasOwn(options,args[i]));options[args[i]]=args[i+1];}
  const directory=path.resolve(options['--directory']);
  if(command==='prepare'){
    let version=options['--version']||'auto';const get=createReader();
    if(process.env.GITHUB_EVENT_NAME==='workflow_run'){
      const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));version=completedReleaseVersion(event);
      assert.ok(Number.isSafeInteger(event.workflow_run.id)&&event.workflow_run.id>0);
      const jobs=json(await get(`https://api.github.com/repos/${repository}/actions/runs/${event.workflow_run.id}/jobs?filter=latest&per_page=100`,{operation:'Read completed release result',token:process.env.GITHUB_TOKEN}),'Completed release result');
      if(!recordedReleaseJobs(jobs)){if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,'eligible=false\n',{flag:'a'});console.log('No recorded release in this run; GitHub package synchronization skipped.');return;}
    }
    const source=await publishedCanonical(version,{get});await writeDistribution(source,directory);
    await writeFile(path.join(path.dirname(directory),'canonical-proof.json'),JSON.stringify({...source,archive:undefined},null,2)+'\n',{flag:'wx'});
    if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`eligible=true\nversion=${source.version}\n`,{flag:'a'});
    console.log(`Prepared ${githubName}@${source.version} from the verified public release.`);return;
  }
  assert.equal(command,'publish');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1','A fresh first-attempt dispatch is required');
  // Rebuild the expected files in this fresh job without running any code
  // from the consumer or the downloaded artifact.
  const source=await publishedCanonical(validVersion(options['--version']),{token:process.env.NODE_AUTH_TOKEN});
  const expectedFiles=distributionFiles(source);
  const result=await publishDistribution({directory,archiveFile:path.resolve(options['--archive']),expectedFiles,npmCli:options['--npm-cli'],token:process.env.NODE_AUTH_TOKEN});
  result.linkage=await linkedPackageMetadata({token:process.env.NODE_AUTH_TOKEN});await writeFile(path.join(path.dirname(directory),'github-package-result.json'),JSON.stringify(result,null,2)+'\n');console.log(`Verified ${result.name}@${result.version} on GitHub Packages.`);
}
export async function publishDistribution({directory,archiveFile,expectedFiles,npmCli,token,attempt=process.env.GITHUB_RUN_ATTEMPT,get=createReader({budgetMs:240000}),npm=args=>execute(process.execPath,[npmCli,...args]),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>performance.now()}){
  assert.equal(attempt,'1','A fresh first-attempt dispatch is required');
  assert.ok(expectedFiles instanceof Map&&expectedFiles.has('package.json'),'Independently prepared files are required');
  const manifest=JSON.parse(expectedFiles.get('package.json').data);assert.equal(manifest.name,githubName);validVersion(manifest.version);assert.equal(manifest.dependencies[canonicalName],manifest.version);assert.equal(manifest.repository.url,'git+https://github.com/Lorkydey/PRNext.git');
  assert.ok(token,'GitHub Packages authentication missing');
  const archiveInfo=await lstat(archiveFile);assert.ok(archiveInfo.isFile()&&!archiveInfo.isSymbolicLink()&&archiveInfo.size<=8*1024**2,'Invalid prepared archive');
  const expectedArchive=await readFile(archiveFile);assertSameDistribution(expectedFiles,expectedArchive);const expected=new Map([...readArchive(expectedArchive)].map(([name,value])=>[name.slice(8),value]));
  const packedManifest=JSON.parse(expected.get('package.json').data);assert.equal(packedManifest.name,manifest.name);assert.equal(packedManifest.version,manifest.version);assert.deepEqual(packedManifest.dependencies,manifest.dependencies);assert.deepEqual(packedManifest.exports,manifest.exports);
  const url=`https://npm.pkg.github.com/${githubName.replace('/','%2f')}`;
  const stateFile=path.join(path.dirname(directory),'github-package-result.json');const result={name:githubName,version:manifest.version,passed:false,uploadStarted:false,uploaded:false,existing:false};
  const save=()=>writeFile(stateFile,JSON.stringify(result,null,2)+'\n');await writeFile(stateFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  const first=await get(url,{operation:'Check existing GitHub package',token,allowMissing:true});const previous=first?json(first,'GitHub package metadata'):null;
  const existing=previous?.versions?.[manifest.version];
  // Registry SRI is checked when available. The sealed artifact's complete
  // file contents and executable modes remain mandatory on every path.
  if(existing){assert.equal(existing.name,githubName);assert.equal(existing.version,manifest.version);const target=new URL(existing.dist.tarball);assert.equal(target.origin,'https://npm.pkg.github.com');const bytes=await get(target.href,{operation:'Verify existing GitHub archive',token,maxBytes:8*1024**2,archive:true});if(existing.dist.integrity)assert.equal(archiveDigest(bytes).integrity,existing.dist.integrity);assertSameDistribution(expected,bytes);result.existing=true;await save();}
  else{const current=previous?.['dist-tags']?.latest;const tag=current&&compareVersions(current,manifest.version)>0?`archive-${manifest.version}`:'latest';result.uploadStarted=true;await save();await npm(['publish',archiveFile,'--registry=https://npm.pkg.github.com','--tag='+tag,'--ignore-scripts']);result.uploaded=true;await save();}
  let packument;const until=now()+60000;
  do{const bytes=await get(url,{operation:'Verify GitHub package',token,allowMissing:true});packument=bytes?json(bytes,'GitHub package'):null;if(packument?.versions?.[manifest.version])break;await wait(1000);}while(now()<until);
  const metadata=packument?.versions?.[manifest.version];assert.ok(metadata,'GitHub archive verification did not become available; never replay an accepted upload');assert.equal(metadata.name,githubName);assert.equal(metadata.version,manifest.version);const target=new URL(metadata.dist.tarball);assert.equal(target.origin,'https://npm.pkg.github.com');const bytes=await get(target.href,{operation:'Verify GitHub archive bytes',token,maxBytes:8*1024**2,archive:true});if(metadata.dist.integrity)assert.equal(archiveDigest(bytes).integrity,metadata.dist.integrity);assertSameDistribution(expected,bytes);
  const current=packument['dist-tags']?.latest;
  if(!current||compareVersions(manifest.version,current)>=0){
    const tags=['latest',...(manifest.version.includes('-')?['alpha']:[])];for(const tag of tags)if(packument['dist-tags']?.[tag]!==manifest.version)await npm(['dist-tag','add',`${githubName}@${manifest.version}`,tag,'--registry=https://npm.pkg.github.com']);
    const deadline=now()+60000;let observed;
    do{observed=json(await get(url,{operation:'Verify GitHub tags',token}),'GitHub tags');if(tags.every(tag=>observed['dist-tags']?.[tag]===manifest.version))break;await wait(1000);}while(now()<deadline);
    assert.ok(tags.every(tag=>observed['dist-tags']?.[tag]===manifest.version),'GitHub package tags did not verify');result.tags=observed['dist-tags'];
  }else result.tags=packument['dist-tags'];
  result.passed=true;await save();return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(error=>{console.error(error.message);process.exitCode=1;});
