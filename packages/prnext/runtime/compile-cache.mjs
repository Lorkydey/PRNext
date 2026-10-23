import {flushCompileCache} from 'node:module';
let pending;
// Flush after imports settle so later workers can reuse compiled code even
// while this worker stays warm. Disk failure is an optimization miss only.
export function scheduleCompileCacheFlush(){
  if(pending||!process.env.NODE_COMPILE_CACHE||process.env.NODE_DISABLE_COMPILE_CACHE==='1')return;
  pending=setTimeout(()=>{pending=undefined;try{flushCompileCache();}catch{}},1000);pending.unref();
}
