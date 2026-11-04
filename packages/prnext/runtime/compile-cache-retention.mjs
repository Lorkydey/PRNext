import {lstat,opendir,unlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {captureStorageDirectory,verifyStorageDirectories,sameStoragePath} from './storage-path.mjs';
import {withBuildLock} from './project-lock.mjs';

/** Bounded maintenance of a known, disposable compiler namespace. Open V8
 * cache readers remain valid; an evicted future lookup is a cache miss. */
export async function pruneCompilerCache(directory,{maxBytes=64*1024*1024,maxFiles=2048}={}){
  if(!directory)return;
  try{
    const snapshot=await captureStorageDirectory(directory);if(!snapshot)return;
    return await withBuildLock(directory,async canonical=>{
      if(!sameStoragePath(canonical,directory)||!await verifyStorageDirectories([snapshot]))return;
      return prune(canonical,{maxBytes,maxFiles});
    });
  }
  catch{/* A busy or unverifiable maintenance owner wins; never wait on it. */}
}
async function prune(directory,{maxBytes,maxFiles}){
  try{
    const files=[];let scanned=0,complete=true;
    const input=await lstat(directory);if(!input.isDirectory()||input.isSymbolicLink())return;
    directory=await realpath(directory);
    const initial=await captureStorageDirectory(directory);if(!initial)return;
    async function collect(folder,depth,parents){
      if(depth>3){complete=false;return;}
      const snapshot=await captureStorageDirectory(folder),guards=[...parents,snapshot];
      if(!snapshot||!await verifyStorageDirectories(guards)){complete=false;return;}
      const entries=await opendir(folder);
      for await(const entry of entries){
        if(++scanned>8192){complete=false;break;}
        if(entry.name.startsWith('.'))continue;
        const name=path.join(folder,entry.name),info=await lstat(name).catch(()=>null);
        if(!info||info.isSymbolicLink())continue;
        if(info.isDirectory())await collect(name,depth+1,guards);
        else if(info.isFile())files.push({name,size:info.size,time:info.mtimeMs,ino:info.ino,dev:info.dev,guards});
        if(!complete)break;
      }
      if(!await verifyStorageDirectories(guards))complete=false;
    }
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())return;
    await collect(directory,0,[initial]);if(!complete)return;
    files.sort((a,b)=>b.time-a.time);let bytes=0,retained=0;
    for(let i=0;i<files.length;i++){
      const file=files[i];
      if(retained>=maxFiles||bytes+file.size>maxBytes){
        if(!await verifyStorageDirectories(file.guards))return;
        const current=await lstat(file.name).catch(()=>null);
        if(current?.isFile()&&!current.isSymbolicLink()&&current.ino===file.ino&&current.dev===file.dev&&current.mtimeMs===file.time&&current.size===file.size&&sameStoragePath(await realpath(file.name),file.name)&&await verifyStorageDirectories(file.guards))await unlink(file.name).catch(()=>{});
      }else{bytes+=file.size;retained++;}
    }
  }catch{/* Compiler cache retention cannot fail a request or build. */}
}
