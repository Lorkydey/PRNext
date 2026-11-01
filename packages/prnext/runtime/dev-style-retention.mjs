import {rm} from 'node:fs/promises';
import path from 'node:path';

// Asset-only generations do not own backend/compiler requests. Drain their
// asset leases and finish deleting the excess snapshot before announcing ready.
export async function pruneDevelopmentStyles(generations,gateway,root){
  while(generations.length>3){
    const old=generations[0];
    await gateway.request('retire',{generation:old.id});
    await gateway.request('forget',{generation:old.id});
    await rm(path.join(root,old.directory),{recursive:true,force:true,maxRetries:10,retryDelay:100});
    // Keep failed deletions tracked so a later update can retry their cleanup.
    generations.shift();
  }
}
