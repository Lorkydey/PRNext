import {build} from './index.mjs';
import {closeIncrementalCompiler,incrementalCompilerStats} from './incremental.mjs';
import {realpath} from 'node:fs/promises';
import {createDevInputSnapshot} from '../runtime/dev-file-changes.mjs';
import {discoverDevelopment} from './dev-discovery.mjs';
import {transformCacheStats} from './transform-cache.mjs';
import {scheduleCompileCacheFlush} from '../runtime/compile-cache.mjs';
import {createCompilerHealth} from './dev-compiler-health.mjs';
const compilerHealth=createCompilerHealth();
let busy=false;
process.on('message',async message=>{
  if(!['build','discover'].includes(message?.type)||busy)return;
  busy=true;
  try{
    if(message.type==='discover'){process.send({type:'result',ok:true,discovery:await discoverDevelopment(message.root)});return;}
    const started=performance.now();
    const inputs=createDevInputSnapshot([message.root,await realpath(message.root)]);
    const manifest=await build(message.root,{dev:true,incremental:!message.options?.devSafe,...message.options,devInputs:inputs});
    console.log(`PRNext built ${message.root} in ${((performance.now()-started)/1000).toFixed(2)}s`);
    scheduleCompileCacheFlush();
    const health=compilerHealth(process.memoryUsage());
    if(message.options?.devSafe)Object.assign(health,{recycle:true,reason:'safe-mode'});
    process.send({type:'result',ok:true,manifest,inputs:inputs.entries(),compiler:{...incrementalCompilerStats(),health},transforms:transformCacheStats(),recycle:health.recycle});
  }catch(error){process.send({type:'result',ok:false,error:error.stack||error.message,recycle:true});}
  finally{busy=false;}
});
process.on('disconnect',async()=>{await closeIncrementalCompiler();process.exit();});
