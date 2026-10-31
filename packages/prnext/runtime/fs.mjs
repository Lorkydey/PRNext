import { rename as move } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

// Windows scanners and recently closed file handles can briefly deny rename.
// Keep the atomic swap: never delete the destination to work around a lock.
export function createAtomicRenamer({moveFile=move,wait=delay,platform=process.platform,now=()=>performance.now(),retryMs=2000}={}) {
  return async function rename(source,destination) {
    const started=now(),deadline=started+retryMs;
    for(let attempt=1;;attempt++){
      try{return await moveFile(source,destination);}
      catch(error){
        if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||now()>=deadline){
          error.atomicRename={operation:'rename',code:error.code||'UNKNOWN',attempts:attempt,elapsedMs:Math.max(0,now()-started),destination:path.basename(destination)};
          throw error;
        }
        await wait(Math.min(10*attempt,100,Math.max(0,deadline-now())));
      }
    }
  };
}
export const rename=createAtomicRenamer();
