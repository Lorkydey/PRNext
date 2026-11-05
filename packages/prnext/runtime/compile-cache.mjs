import {flushCompileCache} from 'node:module';
import {lstatSync,realpathSync,writeFileSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {pruneCompilerCache} from './compile-cache-retention.mjs';
let pending;
let managedDirectory;
let lastMaintenance=0,maintenance;
// Native workers opt in explicitly. Never maintain a caller-supplied global
// NODE_COMPILE_CACHE, and reject links in both framework-owned path components.
try{
  const root=process.env.PRNEXT_MANAGED_COMPILE_CACHE_ROOT;
  if(root&&process.env.NODE_COMPILE_CACHE&&process.env.NODE_DISABLE_COMPILE_CACHE!=='1'){
    const canonical=realpathSync(root),base=path.join(canonical,'.prnext-cache'),directory=path.join(base,'node-compile-v1');
    if(realpathSync(process.env.NODE_COMPILE_CACHE)===directory&&[base,directory,process.env.NODE_COMPILE_CACHE].every(folder=>{const info=lstatSync(folder);return info.isDirectory()&&!info.isSymbolicLink();})){
      const lease=path.join(directory,`.lease-${process.pid}-${randomUUID()}.json`);
      writeFileSync(lease,JSON.stringify({pid:process.pid,host:hostname()}),{flag:'wx',mode:0o600});
      managedDirectory=directory;
      process.once('exit',()=>{try{unlinkSync(lease);}catch{}});
    }
  }
}catch{/* A lease failure leaves this process's cache unmanaged. */}
// Flush after imports settle so later workers can reuse compiled code even
// while this worker stays warm. Disk failure is an optimization miss only.
export function scheduleCompileCacheFlush(){
  if(pending||!process.env.NODE_COMPILE_CACHE||process.env.NODE_DISABLE_COMPILE_CACHE==='1')return;
  pending=setTimeout(()=>{
    pending=undefined;try{flushCompileCache();}catch{}
    if(managedDirectory&&!maintenance&&Date.now()-lastMaintenance>=60000){
      lastMaintenance=Date.now();
      maintenance=pruneCompilerCache(managedDirectory,{maxBytes:128*1024*1024,maxFiles:4096}).finally(()=>{maintenance=undefined;});
    }
  },1000);pending.unref();
}
