import {build} from './index.mjs';
import {closeIncrementalCompiler} from './incremental.mjs';
import {realpath} from 'node:fs/promises';
import {createDevInputSnapshot} from '../runtime/dev-file-changes.mjs';
let builds=0,busy=false;
process.on('message',async message=>{
  if(message?.type!=='build'||busy)return;
  busy=true;
  try{
    const started=performance.now();
    const inputs=createDevInputSnapshot([message.root,await realpath(message.root)]);
    await build(message.root,{dev:true,incremental:true,devInputs:inputs});
    console.log(`Rustyx built ${message.root} in ${((performance.now()-started)/1000).toFixed(2)}s`);
    process.send({type:'result',ok:true,inputs:inputs.entries(),recycle:++builds>=24 || process.memoryUsage().rss>512*1024*1024});
  }catch(error){process.send({type:'result',ok:false,error:error.stack||error.message,recycle:true});}
  finally{busy=false;}
});
process.on('disconnect',async()=>{await closeIncrementalCompiler();process.exit();});
