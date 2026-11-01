import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {executeNpm} from '../../packages/prnext/native/npm.mjs';
import {nativePlatform,nativeBinaryName} from '../../packages/prnext/native/resolve.mjs';
import {packNative} from '../../scripts/package-native.mjs';
import {readArchive} from '../../scripts/verify-npm-artifacts.mjs';
import {createProductionFixture} from './production-fixture.mjs';
import {isMainModule} from '../../scripts/main-module.mjs';

const execute=promisify(execFile),repository=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>{const value=path.relative(root,file);return value&&!value.startsWith('..'+path.sep)&&value!=='..'&&!path.isAbsolute(value);};
const gitEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)/i.test(key)));

export async function verifyArchiveSource(archiveFile,commit,cwd=repository){
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('An exact Git source commit is required.');
  const {stdout}=await execute('git',['ls-tree','-rz','--full-tree',commit,'--','packages/prnext'],{cwd,env:gitEnvironment(),maxBuffer:16*1024**2,encoding:'buffer'});
  const blobs=new Map(stdout.toString('utf8').split('\0').filter(Boolean).map(line=>{const tab=line.indexOf('\t'),metadata=line.slice(0,tab).split(' ');return [line.slice(tab+1).slice('packages/prnext/'.length),metadata[1]==='blob'?metadata[2]:null];}));
  const archive=readArchive(await readFile(archiveFile));
  for(const [name,entry]of archive){
    const file=name.slice('package/'.length),actual=createHash('sha1').update(Buffer.from(`blob ${entry.data.length}\0`)).update(entry.data).digest('hex');
    if(blobs.get(file)!==actual)throw Error('A distributed archive file does not match its declared Git source: '+file);
  }
  return {commit,associationVerified:true,files:archive.size};
}

// A release bump needs its own versioned native, even when Rust behavior is
// unchanged. Never install the candidate executable as the baseline's native.
export function verifyComparisonPair(mainBytes,nativeBytes){
  const main=readArchive(mainBytes),native=readArchive(nativeBytes),target=nativePlatform();
  const manifest=JSON.parse(main.get('package/package.json')?.data.toString('utf8')||'null');
  const nativeManifest=JSON.parse(native.get('package/package.json')?.data.toString('utf8')||'null');
  const metadata=JSON.parse(native.get('package/native.json')?.data.toString('utf8')||'null');
  const executable=native.get('package/bin/'+nativeBinaryName(target.os));
  if(!manifest||manifest.name!=='@thomas.f/prnext'||!/^\d+\.\d+\.\d+-alpha(?:\.\d+)?$/.test(manifest.version||'')||
      manifest.optionalDependencies?.[target.package]!==manifest.version||nativeManifest?.name!==target.package||
      nativeManifest.version!==manifest.version||metadata?.version!==manifest.version||metadata.id!==target.id||
      JSON.stringify(nativeManifest.os)!==JSON.stringify([target.os])||JSON.stringify(nativeManifest.cpu)!==JSON.stringify([target.cpu])||
      (target.libc&&JSON.stringify(nativeManifest.libc)!==JSON.stringify([target.libc]))||!executable||sha(executable.data)!==metadata.sha256){
    throw Error('Comparison framework and native archives have mismatched versions, platform or executable bytes.');
  }
  return {version:manifest.version,platform:target.id,binarySha256:metadata.sha256,frameworkArchiveSha256:sha(mainBytes),nativeArchiveSha256:sha(nativeBytes)};
}

async function buildBaselineNative(source,root,output){
  const target=path.join(root,'target','performance-baseline');
  const args=[path.join(source,'scripts/cargo.mjs'),'build','--release','--locked','--target-dir',target];
  const log=path.join(output,'logs','baseline-native-build.log');
  try{
    const result=await execute(process.execPath,args,{cwd:source,env:gitEnvironment(),timeout:25*60*1000,maxBuffer:16*1024**2});
    await writeFile(log,result.stdout+'\n'+result.stderr,{flag:'wx'});
  }catch(error){
    await writeFile(log,(error.stdout||'')+'\n'+(error.stderr||'')+'\nNative build failed.\n',{flag:'wx'});
    throw Error('Baseline native build failed; see '+log);
  }
  const binary=path.join(target,'release','prnext'+(process.platform==='win32'?'.exe':''));
  const packed=await execute(process.execPath,[path.join(source,'scripts/package-native.mjs'),'--binary',binary,'--out',path.join(output,'archives','baseline-native')],{cwd:source,env:gitEnvironment(),timeout:120000,maxBuffer:4*1024**2});
  const result=JSON.parse(packed.stdout);
  if(typeof result.file!=='string'||!inside(path.join(output,'archives','baseline-native'),result.file))throw Error('Baseline native pack returned an unexpected archive.');
  return {tarball:result.file,buildLog:log,buildLogSha256:sha(await readFile(log)),binarySha256:sha(await readFile(binary))};
}

// Prepare once before measuring. The workload/profile/budgets below are fixed;
// no candidate result is used to tune them or retry an unsuccessful comparison.
export async function prepareCandidateComparison({baseline,output,affinityCpus,binary}={}){
  if(!/^[a-f0-9]{40}$/.test(baseline||''))throw Error('Use an exact baseline commit.');
  if(typeof affinityCpus!=='string'||!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(affinityCpus))throw Error('Use an explicit CPU affinity set.');
  const root=await realpath(repository),parent=await realpath(path.dirname(path.resolve(output||'')));
  output=path.join(parent,path.basename(path.resolve(output||'')));
  if(!inside(path.join(root,'artifacts'),output))throw Error('Use a new output directory inside the checkout artifacts directory.');
  const git=async args=>(await execute('git',args,{cwd:root,env:gitEnvironment(),maxBuffer:4*1024**2})).stdout.trim();
  const candidate=await git(['rev-parse','HEAD']);
  if(await git(['status','--porcelain=v1','--untracked-files=no']))throw Error('Candidate source must be committed and clean before qualification.');
  await git(['cat-file','-e',baseline+'^{commit}']);
  const nativeSourceChanges=(await git(['diff','--name-only',baseline,candidate,'--','Cargo.toml','Cargo.lock','crates'])).split('\n').filter(Boolean);
  await mkdir(output);await mkdir(path.join(output,'archives'));await mkdir(path.join(output,'logs'));
  const baselineSource=path.join(output,'baseline-source');
  await git(['worktree','add','--detach',baselineSource,baseline]);
  const candidateNative=await packNative({binary:binary||path.join(root,'target/release/prnext'+(process.platform==='win32'?'.exe':'')),out:path.join(output,'archives','candidate-native')});
  const baselineNative=await buildBaselineNative(baselineSource,root,output);
  const provenance={baseline,candidate,nativeSourcesEqual:nativeSourceChanges.length===0,nativeSourceChanges,nativeBuilds:'separate-versioned-source-builds',variants:{}};
  const variants={};
  for(const [variant,source,commit]of [['baseline',baselineSource,baseline],['candidate',root,candidate]]){
    const archiveDirectory=path.join(output,'archives',variant);await mkdir(archiveDirectory);
    const packed=await executeNpm(['pack','./packages/prnext','--ignore-scripts','--json','--pack-destination',archiveDirectory],{cwd:source,timeout:60000,maxBuffer:4*1024**2});
    const archive=path.join(archiveDirectory,JSON.parse(packed.stdout)[0].filename);
    const sourceProof=await verifyArchiveSource(archive,commit,root);
    const native=variant==='baseline'?baselineNative:candidateNative;
    const nativeProof=verifyComparisonPair(await readFile(archive),await readFile(native.tarball));
    if(variant==='baseline'&&nativeProof.binarySha256!==baselineNative.binarySha256)throw Error('Baseline native changed after its source build.');
    const directory=path.join(output,variant);await createProductionFixture(directory);
    const dependencies={'@thomas.f/prnext':'file:'+archive,[nativePlatform().package]:'file:'+native.tarball,react:'19.3.1','react-dom':'19.3.1','react-server-dom-webpack':'19.3.1'};
    await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'private-release-comparison-'+variant,private:true,type:'module',dependencies,overrides:{fflate:'0.7.5',glob:'14.0.2',minimatch:'11.0.1'}},null,2)+'\n');
    const installed=await executeNpm(['install','--workspaces=false','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,timeout:180000,maxBuffer:4*1024**2});
    await writeFile(path.join(output,'logs',variant+'-installation.log'),installed.stdout+'\n'+installed.stderr);
    variants[variant]={directory,archives:[archive,native.tarball],source:commit};
    provenance.variants[variant]={...sourceProof,...nativeProof,archiveSha256:sha(await readFile(archive)),lockSha256:sha(await readFile(path.join(directory,'package-lock.json'))),...(variant==='baseline'?{nativeBuildLog:baselineNative.buildLog,nativeBuildLogSha256:baselineNative.buildLogSha256}:{nativeBuild:'workflow build:native at the clean candidate source'})};
  }
  const configuration={...variants,workload:{seconds:15,warmupSeconds:2,connections:{'/ssr':8,'/api/json':2,'/stream':8},repetitions:12,workers:2},budgets:{throughputDropPercent:10,p95IncreasePercent:15,maxNoisePercent:15,maxGeneratorCpuPercent:85},resourcePolicy:{cpuLimit:2,memoryBytes:5*1024**3,affinityCpus},resourceAccounting:'cgroup-v2'};
  const bytes=JSON.stringify(configuration,null,2)+'\n';await writeFile(path.join(output,'configuration.json'),bytes,{flag:'wx'});
  await writeFile(path.join(output,'preparation.json'),JSON.stringify({...provenance,configurationSha256:sha(bytes),preparedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  return {output,configurationSha256:sha(bytes),baseline,candidate};
}

if(isMainModule(import.meta.url)){
  const [baseline,output,affinityCpus]=process.argv.slice(2);
  console.log(JSON.stringify(await prepareCandidateComparison({baseline,output,affinityCpus})));
}
