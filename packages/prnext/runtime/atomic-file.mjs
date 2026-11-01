import {open,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {rename} from './fs.mjs';

// The old destination stays readable until the complete replacement exists.
// Keeping an injectable I/O boundary lets tests exercise real partial-write and
// rename failures without depending on an antivirus or a physical disk fault.
export function createAtomicFileWriter({openFile=open,moveFile=rename,removeFile=rm}={}){
  return async function writeAtomicFile(filename,data){
    const temporary=filename+'.'+randomUUID()+'.tmp';let file,created=false,failure,phase='create';
    try{
      file=await openFile(temporary,'wx',0o600);created=true;phase='write';await file.writeFile(data);phase='close';await file.close();file=undefined;
      phase='publish';await moveFile(temporary,filename);
    }catch(error){
      error.atomicFile={operation:'publish-development-state',phase,code:error.code||'UNKNOWN',destination:path.basename(filename),...(error.atomicRename||{})};
      failure=error;
      throw error;
    }finally{
      await file?.close().catch(()=>{});
      // This unpredictable temporary is owned by this invocation. Never remove
      // the destination to work around a Windows lock.
      if(created)try{await removeFile(temporary,{force:true});}catch(error){if(failure)failure.atomicFile.cleanupCode=error.code||'UNKNOWN';else throw error;}
    }
  };
}
export const writeAtomicFile=createAtomicFileWriter();
