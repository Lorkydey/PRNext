// Recovery journal for framework-owned build stages. Uncommitted backups can
// be the only working build after a crash: keep them for explicit recovery.
import {mkdir,open,opendir,lstat,rename,unlink,rm,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {captureStorageDirectory,verifyStorageDirectories,sameStoragePath} from '../runtime/storage-path.mjs';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const recordName=new RegExp('^'+uuid+'\\.json$'),stageName=new RegExp('^\\.prnext-build-'+uuid+'$'),backupName=new RegExp('^\\.prnext-backup-'+uuid+'$');
const MAX_JOURNAL_NAMES=32768,MAX_PAGE=128;
async function container(root){
  const directory=path.join(root,'.prnext-gc');
  await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Build recovery journal must be a real directory.');
  return directory;
}
async function readValue(file){
  let handle;
  try{
    const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return null;
    handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));if((await handle.stat()).size>4096)return null;
    return JSON.parse(await handle.readFile('utf8'));
  }catch{return null;}finally{await handle?.close().catch(()=>{});}
}
async function read(file){
  const value=await readValue(file);
  if(!value||value.version!==1||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.host!=='string'||!Number.isSafeInteger(value.createdAt)||!stageName.test(value.stage)||!backupName.test(value.backup)||typeof value.committed!=='boolean')return null;
  return value;
}
async function save(file,value){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value));}finally{await handle.close();}await rename(temporary,file);}
  finally{await unlink(temporary).catch(()=>{});}
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
async function remove(root,name,pattern){
  if(!pattern.test(name))return false;
  const target=path.resolve(root,name);if(path.dirname(target)!==root)return false;
  const rootGuard=await captureStorageDirectory(root);if(!rootGuard)return false;
  const info=await lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(!info)return 'missing';if(!info.isDirectory()||info.isSymbolicLink())return false;
  const targetGuard=await captureStorageDirectory(target);
  if(!targetGuard||!await verifyStorageDirectories([rootGuard,targetGuard]))return false;
  // Root and basename were checked immediately before this scoped removal.
  await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:50});return 'removed';
}

/** Caller holds withBuildLock for this canonical root. No age-only deletion. */
export async function reclaimBuildStages(root,{now=Date.now(),graceMs=3600000,maxEntries=MAX_PAGE,maxListingEntries=MAX_JOURNAL_NAMES}={}){
  const report={scanned:0,listed:0,removedStages:0,removedBackups:0,retainedRecoveryBackups:0,scanComplete:true,deferred:false};
  const pageSize=Number.isSafeInteger(maxEntries)&&maxEntries>0?Math.min(maxEntries,MAX_PAGE):MAX_PAGE;
  const listingLimit=Number.isSafeInteger(maxListingEntries)&&maxListingEntries>0?Math.min(maxListingEntries,MAX_JOURNAL_NAMES):MAX_JOURNAL_NAMES;
  try{
    root=path.resolve(root);const rootGuard=await captureStorageDirectory(root);
    if(!rootGuard)return {...report,scanComplete:false,deferred:true,reason:'The build recovery root changed.'};
    const directory=await container(root);
    const guards=[rootGuard,await captureStorageDirectory(directory)];
    if(!await verifyStorageDirectories(guards))return {...report,scanComplete:false,deferred:true,reason:'The build recovery directory changed.'};
    const cursorFile=path.join(directory,'cursor.json');
    const cursorInfo=await lstat(cursorFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(cursorInfo&&(!cursorInfo.isFile()||cursorInfo.isSymbolicLink()))return {...report,scanComplete:false,deferred:true,reason:'The build recovery cursor is not an ordinary file.'};
    const saved=await readValue(cursorFile);
    const after=saved?.version===1&&typeof saved.after==='string'&&recordName.test(saved.after)?saved.after:null;
    const names=[];
    for await(const entry of await opendir(directory)){
      if(report.listed>=listingLimit)return {...report,scanComplete:false,deferred:true,reason:'The build recovery journal listing limit was reached; no stages were removed.'};
      report.listed++;
      if(recordName.test(entry.name))names.push(entry.name);
    }
    names.sort();
    let start=after?names.findIndex(name=>name>after):0;if(start<0)start=0;
    const page=names.slice(start,start+pageSize);
    report.scanComplete=start+page.length>=names.length;
    report.deferred=!report.scanComplete;
    if(report.deferred)report.reason='More build recovery journals remain; the next build resumes this scan.';
    for(const name of page){
      if(!await verifyStorageDirectories(guards))return {...report,scanComplete:false,deferred:true,reason:'The build recovery directory changed.'};
      report.scanned++;
      const file=path.join(directory,name),owner=await read(file);
      if(!owner||owner.host!==hostname()||alive(owner.pid)||now-owner.createdAt<graceMs)continue;
      let stageGone=false,backupGone=false;
      try{stageGone=await remove(root,owner.stage,stageName);if(stageGone==='removed')report.removedStages++;}catch{}
      if(owner.committed){try{backupGone=await remove(root,owner.backup,backupName);if(backupGone==='removed')report.removedBackups++;}catch{}}
      else{
        const backup=await lstat(path.join(root,owner.backup)).catch(()=>null);
        backupGone=!backup;if(backup)report.retainedRecoveryBackups++;
      }
      if(stageGone&&backupGone&&await verifyStorageDirectories(guards))await unlink(file).catch(()=>{});
    }
    if(!await verifyStorageDirectories(guards))return {...report,scanComplete:false,deferred:true,reason:'The build recovery directory changed.'};
    // The caller owns the publisher lock, so a single persistent cursor advances
    // across fresh CLI processes without renaming any live owner's journals.
    await save(cursorFile,{version:1,after:report.scanComplete?null:page.at(-1)||null});
  }catch{report.scanComplete=false;report.deferred=true;report.reason='Build recovery maintenance is unavailable; retry on a later build.';}
  return report;
}

export async function trackBuildStage(root,{stage,backup}){
  root=path.resolve(root);const rootGuard=await captureStorageDirectory(root);
  if(!rootGuard)throw Error('Build recovery root must be a canonical physical directory.');
  const value={version:1,pid:process.pid,host:hostname(),createdAt:Date.now(),stage:path.basename(stage),backup:path.basename(backup),committed:false};
  if(!stageName.test(value.stage)||!backupName.test(value.backup)||!sameStoragePath(await realpath(path.dirname(path.resolve(stage))),root)||!sameStoragePath(await realpath(path.dirname(path.resolve(backup))),root))throw Error('Build recovery paths must be owned stages inside the project.');
  const file=path.join(await container(root),randomUUID()+'.json');
  const guards=[rootGuard,await captureStorageDirectory(path.dirname(file))];
  if(!await verifyStorageDirectories(guards))throw Error('Build recovery directory changed before publication.');
  await save(file,value);
  return {
    async committed(){value.committed=true;if(await verifyStorageDirectories(guards))await save(file,value);},
    async cleanup(){
      try{
        const stageGone=await remove(root,value.stage,stageName);
        // An uncommitted backup is kept until rollback has restored it.
        const backupGone=value.committed?await remove(root,value.backup,backupName):!await lstat(path.join(root,value.backup)).catch(()=>null);
        if(stageGone&&backupGone&&await verifyStorageDirectories(guards))await unlink(file);
      }catch{/* Keep the journal so a later build can retry Windows busy files. */}
    },
  };
}
