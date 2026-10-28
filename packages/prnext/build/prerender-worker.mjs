import {prerenderProduction} from './production-builder.mjs';
const controller=new AbortController();
process.on('message',message=>{if(message.type==='abort')controller.abort(new Error('Production prerender cancelled by supervisor'));});
process.once('message',async({root,stage,manifest,options})=>{
  try{
    await prerenderProduction(root,stage,manifest,{...options,signal:controller.signal});
    process.send({ok:true,manifest},()=>process.exit(0));
  }catch(error){process.send({ok:false,error:error.stack||error.message},()=>process.exit(1));}
});
process.once('disconnect',()=>process.exit(1));
