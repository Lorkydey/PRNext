// Only these framework-owned, regenerable caches participate in the common
// budget. Runtime data, page/image indexes, invalidations and app files do not.
import {AsyncLocalStorage} from 'node:async_hooks';
import {lstat,open,opendir,realpath,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {withBuildLock} from './build-lock.mjs';
import {captureStorageDirectory,verifyStorageDirectories,sameStoragePath} from '../runtime/storage-path.mjs';

const MiB=1024*1024,DEFAULT=256*MiB,MAX_SCAN=32768;
const storage=new AsyncLocalStorage();
const namespaces={
  'transforms-v1':/^[a-f0-9]{64}\.json$/,
  'transforms-dev-v1':/^[a-f0-9]{64}\.json$/,
  'runtime-bundle-v2':/^[a-f0-9]{64}\.json$/,
  'loaders-v2':/^[a-f0-9]{64}\.json$/,
  'compilation-graphs-v1':/^[a-f0-9]{64}\.json$/,
  'compilation-graphs-v2':/^[a-f0-9]{64}\.(?:graph|blob)$/,
  'fonts-v1':/^[a-f0-9]{64}\.bin$/,
  'precompress-v1':/^[a-f0-9]{64}\.(?:gz|br)$/,
  'dev-compiler-v8':null,
  'node-compile-v1':null,
};
export function validateCompilationCache(value={}){
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(key=>key!=='maxDiskSize'))throw new TypeError('compilationCache accepts only maxDiskSize, in bytes.');
  const maxDiskSize=value.maxDiskSize===undefined?DEFAULT:value.maxDiskSize;
  if(!Number.isSafeInteger(maxDiskSize)||maxDiskSize<0||maxDiskSize>4*1024*MiB)throw new TypeError('compilationCache.maxDiskSize must be an integer from 0 to 4294967296 bytes.');
  return {maxDiskSize};
}
export function configureCompilationStorage(policy){const context=storage.getStore();if(context)context.policy=validateCompilationCache(policy);}
async function realDirectory(directory){const info=await lstat(directory).catch(()=>null);return info?.isDirectory()&&!info.isSymbolicLink();}
const sameFile=(left,right)=>left.isFile()&&!left.isSymbolicLink()&&left.ino===right.ino&&left.dev===right.dev&&left.size===right.size&&left.mtimeMs===right.mtimeMs;
async function unchangedFile(file,snapshot,guards){
  if(!await verifyStorageDirectories(guards))return false;
  const current=await lstat(file).catch(()=>null);
  return !!current&&sameFile(current,snapshot)&&sameStoragePath(await realpath(file),file)&&await verifyStorageDirectories(guards);
}
async function boundedJson(file,guards){
  let descriptor;
  try{
    if(guards&&!await verifyStorageDirectories(guards))return null;
    const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return null;
    descriptor=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    if(!sameFile(await descriptor.stat(),info))return null;
    const contents=await descriptor.readFile('utf8');
    if(guards&&!await unchangedFile(file,info,guards))return null;
    return JSON.parse(contents);
  }catch{return null;}finally{await descriptor?.close().catch(()=>{});}
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
async function pinned(directory,{clean=false,guards}={}){
  let scanned=0,active=false;
  if(!await verifyStorageDirectories(guards))return {active:true,changed:true};
  try{
    for await(const entry of await opendir(directory)){
      if(++scanned>8192)return {active:true,changed:false};
      const name=entry.name;
      if(!/^\.lease-\d+-[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=path.join(directory,name),info=await lstat(file).catch(()=>null),owner=await boundedJson(file,guards);
      if(!owner||owner.host!==hostname()||!Number.isSafeInteger(owner.pid)||owner.pid<1||String(owner.pid)!==name.split('-')[1]||alive(owner.pid)){active=true;continue;}
      if(clean&&info&&await unchangedFile(file,info,guards))await unlink(file).catch(()=>{});
    }
  }catch{return {active:true,changed:true};}
  return {active,changed:!await verifyStorageDirectories(guards)};
}
async function storedPolicy(root){return validateCompilationCache(await boundedJson(path.join(root,'.prnext-cache','compilation-policy.json'))||{});}
async function savePolicy(root,policy){
  const directory=path.join(root,'.prnext-cache'),guards=[await captureStorageDirectory(root),await captureStorageDirectory(directory)];
  if(!await verifyStorageDirectories(guards))return;
  const temporary=path.join(directory,`.policy-${randomUUID()}.tmp`);
  let temporaryInfo;
  try{
    if(!await verifyStorageDirectories(guards))return;
    const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(policy));temporaryInfo=await file.stat();}finally{await file.close();}
    if(await unchangedFile(temporary,temporaryInfo,guards))await rename(temporary,path.join(directory,'compilation-policy.json'));
  }catch{/* Optional cache metadata cannot fail compilation. */}
  finally{if(temporaryInfo&&await unchangedFile(temporary,temporaryInfo,guards).catch(()=>false))await unlink(temporary).catch(()=>{});}
}

/** Stats never execute application config. The budget is from the last build. */
export async function compilationStorageStats(root,{maxDiskSize}={}){
  root=await realpath(root);const base=path.join(root,'.prnext-cache');
  let policy;
  if(maxDiskSize!==undefined)policy=validateCompilationCache({maxDiskSize});
  else try{policy=await storedPolicy(root);}catch{policy=validateCompilationCache();}
  const report={version:1,root,maxDiskSize:policy.maxDiskSize,bytes:0,files:0,scanComplete:true,categories:[],excluded:['runtime data and SQLite','page and image caches','unknown files and directories']};
  if(!await realDirectory(base))return report;
  const baseGuards=[await captureStorageDirectory(root),await captureStorageDirectory(base)];
  if(!await verifyStorageDirectories(baseGuards)){report.scanComplete=false;return report;}
  let scanned=0;
  for(const [name,pattern] of Object.entries(namespaces)){
    const directory=path.join(base,name);if(!await realDirectory(directory))continue;
    const guards=[...baseGuards,await captureStorageDirectory(directory)],treeGuards=[...guards];
    const lease=await pinned(directory,{guards});
    if(lease.changed){report.scanComplete=false;break;}
    const category={name,bytes:0,files:0,pinned:lease.active,entries:[],guards};
    async function collect(folder,parentGuards,depth=0){
      if(depth>3){report.scanComplete=false;return;}
      if(!await verifyStorageDirectories(parentGuards)){report.scanComplete=false;return;}
      try{
        for await(const entry of await opendir(folder)){
          if(++scanned>MAX_SCAN){report.scanComplete=false;return;}
          const filename=path.join(folder,entry.name),info=await lstat(filename).catch(()=>null);
          if(!info||info.isSymbolicLink())continue;
          if(!pattern&&info.isDirectory()&&!entry.name.startsWith('.')){
            const snapshot=await captureStorageDirectory(filename);treeGuards.push(snapshot);
            await collect(filename,[...parentGuards,snapshot],depth+1);
          }else if(info.isFile()){
            const temporary=!!pattern&&/^[a-f0-9]{64}\.(?:json|graph|blob|bin|gz|br)\.[a-f0-9-]{36}\.tmp$/.test(entry.name);
            if(!(pattern?pattern.test(entry.name)||temporary:!entry.name.startsWith('.')))continue;
            category.entries.push({filename,size:info.size,time:info.mtimeMs,ino:info.ino,dev:info.dev,temporary,pinned:temporary&&Date.now()-info.mtimeMs<3600000,guards:parentGuards});category.bytes+=info.size;category.files++;
          }
          if(!report.scanComplete)return;
        }
      }catch{report.scanComplete=false;}
      if(!await verifyStorageDirectories(parentGuards))report.scanComplete=false;
    }
    await collect(directory,guards);
    if(!await verifyStorageDirectories(treeGuards))report.scanComplete=false;
    report.categories.push(category);report.bytes+=category.bytes;report.files+=category.files;
    if(!report.scanComplete)break;
  }
  return report;
}
function publicReport(report){return {...report,categories:report.categories.map(({entries,guards,...category})=>category)};}
export async function inspectCompilationStorage(root,options){return publicReport(await compilationStorageStats(root,options));}

// Called only under the existing interprocess publisher lock. Long-lived dev
// compilers retain their cache until shutdown; managed V8 workers pin theirs.
export async function pruneCompilationStorage(root,{maxDiskSize,dryRun=false,locked=false}={}){
  if(!locked)return withBuildLock(root,canonical=>pruneCompilationStorage(canonical,{maxDiskSize,dryRun,locked:true}));
  const report=await compilationStorageStats(root,{maxDiskSize});
  let dev=false;try{await lstat(path.join(report.root,'.prnext-dev.lock'));dev=true;}catch(error){if(error.code!=='ENOENT')dev=true;}
  const result={...publicReport(report),dryRun,beforeBytes:report.bytes,afterBytes:report.bytes,removedBytes:0,removedFiles:0,deferred:dev||!report.scanComplete,reason:dev?'Development is running; stop it to reclaim compilation caches.':!report.scanComplete?'The scan limit was reached; no files were removed.':undefined};
  if(result.deferred)return result;
  const units=[];
  for(const category of report.categories){
    if(category.pinned)continue;
    const lease=await pinned(path.join(report.root,'.prnext-cache',category.name),{clean:!dryRun,guards:category.guards});
    if(lease.changed){result.scanComplete=false;result.deferred=true;result.reason='A compiler cache directory changed; no further files were removed.';return result;}
    if(lease.active){result.categories.find(value=>value.name===category.name).pinned=true;continue;}
    // Graph records share content-addressed blobs. Evict this bounded namespace
    // together so a global trim cannot strand metadata or remove shared bytes.
    if(category.name==='compilation-graphs-v2'&&category.entries.length){
      const graphs=category.entries.filter(entry=>!entry.temporary);if(graphs.length)units.push(graphs);
      for(const entry of category.entries)if(entry.temporary&&!entry.pinned)units.push([entry]);
    }
    else for(const entry of category.entries)if(!entry.pinned)units.push([entry]);
  }
  units.sort((a,b)=>Math.max(...a.map(e=>e.time))-Math.max(...b.map(e=>e.time)));
  for(const entries of units){
    if(result.afterBytes<=report.maxDiskSize&&!entries.some(entry=>entry.temporary))continue;
    for(const entry of entries){
      try{
        // Do not unlink an entry replaced after this snapshot (or a symlink).
        if(!await verifyStorageDirectories(entry.guards)){result.scanComplete=false;result.deferred=true;result.reason='A compiler cache directory changed; no further files were removed.';return result;}
        const current=await lstat(entry.filename);
        if(!current.isFile()||current.isSymbolicLink()||current.ino!==entry.ino||current.dev!==entry.dev||current.size!==entry.size||current.mtimeMs!==entry.time)continue;
        if(!sameStoragePath(await realpath(entry.filename),entry.filename)||!await verifyStorageDirectories(entry.guards)){result.scanComplete=false;result.deferred=true;result.reason='A compiler cache directory changed; no further files were removed.';return result;}
        if(!dryRun)await unlink(entry.filename);
        result.afterBytes-=entry.size;result.removedBytes+=entry.size;result.removedFiles++;
      }catch{/* Busy/changed files remain visible and retryable next time. */}
    }
  }
  result.overBudget=result.afterBytes>report.maxDiskSize;
  return result;
}

export async function withCompilationStorage(root,run){
  if(process.env.PRNEXT_BUILD_CACHE==='0')return run();
  let policy;try{policy=await storedPolicy(root);}catch{policy=validateCompilationCache();}
  const context={policy};
  return storage.run(context,async()=>{
    let value;
    try{value=await run();return value;}
    finally{
      await savePolicy(root,context.policy);
      try{
        // A live dev session pins compiler state. Avoid a full disk scan after
        // every keystroke; shutdown applies the stored policy once it drains.
        const dev=await lstat(path.join(root,'.prnext-dev.lock')).catch(()=>null);
        const report=dev?{version:1,...context.policy,deferred:true,reason:'Development is running; maintenance runs after shutdown.'}:await pruneCompilationStorage(root,{...context.policy,locked:true});
        if(value&&typeof value==='object')value.compilationStorage=report;
      }
      catch{/* Retention failure must not hide a build error. */}
    }
  });
}
