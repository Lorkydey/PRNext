import {build} from './index.mjs';
import {closeIncrementalCompiler,incrementalCompilerStats} from './incremental.mjs';
import {realpath} from 'node:fs/promises';
import {createDevInputSnapshot} from '../runtime/dev-file-changes.mjs';
import {discoverDevelopment} from './dev-discovery.mjs';
import {transformCacheStats} from './transform-cache.mjs';
import {scheduleCompileCacheFlush} from '../runtime/compile-cache.mjs';
let builds=0,busy=false;
process.on('message',async message=>{
  if(!['build','discover'].includes(message?.type)||busy)return;
  busy=true;
  try{
    if(message.type==='discover'){process.send({type:'result',ok:true,discovery:await discoverDevelopment(message.root)});return;}
    const started=performance.now();
    const inputs=createDevInputSnapshot([message.root,await realpath(message.root)]);
    const manifest=await build(message.root,{dev:true,incremental:true,...message.options,devInputs:inputs});
    console.log(`PRNext built ${message.root} in ${((performance.now()-started)/1000).toFixed(2)}s`);
    scheduleCompileCacheFlush();
    process.send({type:'result',ok:true,manifest,inputs:inputs.entries(),compiler:incrementalCompilerStats(),transforms:transformCacheStats(),recycle:++builds>=24 || process.memoryUsage().rss>512*1024*1024});
  }catch(error){process.send({type:'result',ok:false,error:error.stack||error.message,recycle:true});}
  finally{busy=false;}
});
process.on('disconnect',async()=>{await closeIncrementalCompiler();process.exit();});
